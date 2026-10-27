import { HostKeyError } from '@evershell/ui';
import type {
  ConnectOptions,
  EditorWindowHost,
  FileEntry,
  HostKeyProblem,
  KdfParams,
  LocalTextFile,
  ManagerWindowHost,
  MonitorDetail,
  MonitorSnapshot,
  PermScope,
  PrivateKeyInfo,
  SecretStore,
  SshBackend,
  SshSession,
  StorageSync,
  SyncPlatform,
  SystemInfo,
  TransferProgress,
} from '@evershell/ui';
import { Channel, invoke } from '@tauri-apps/api/core';
import { emit, emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { getCurrentWindow } from '@tauri-apps/api/window';

// 与 src-tauri/src/commands.rs 对应
interface ConnectReply {
  id: string;
  fingerprint: string | null;
}

/** import_find_local / import_find_local_commands 的一项，见 src-tauri/src/local_import.rs 的 LocalConfig */
interface LocalConfigReply {
  source: string;
  location: string;
  files: { path: string; bytes: number[] }[];
  error: string | null;
}

/** 文件内容是 JSON 里的数字数组（配置文件很小），这里转回字节 */
const toLocalConfigs = (list: LocalConfigReply[]) =>
  list.map((c) => ({ ...c, files: c.files.map((f) => ({ path: f.path, bytes: Uint8Array.from(f.bytes) })) }));

/** 远端输出是原始字节（ArrayBuffer），退出事件是一条 JSON */
type ShellEvent = ArrayBuffer | Uint8Array | { exit: number | null; reason: string | null };

/** 原始字节请求（write / upload）的元数据放在请求头里 */
const SESSION_HEADER = 'x-session';
const PATH_HEADER = 'x-path';
const PROGRESS_HEADER = 'x-progress';

/** Rust 侧返回的错误是字符串，统一包成 Error 交给界面显示 */
function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args).catch(rethrow);
}

function rethrow(err: unknown): never {
  throw err instanceof Error ? err : new Error(String(err));
}

/** ssh_connect 的错误是 { kind: 'message', message } 或 { kind: 'hostKey', problem }，见 commands.rs 的 ConnectError */
function connectError(err: unknown): never {
  if (err && typeof err === 'object' && 'kind' in err) {
    const e = err as { kind: string; message?: string; problem?: HostKeyProblem };
    if (e.kind === 'hostKey' && e.problem) throw new HostKeyError(e.problem);
    if (typeof e.message === 'string') throw new Error(e.message);
  }
  rethrow(err);
}

class TauriSession implements SshSession {
  // 每次 invoke 是一个独立的 fetch，到达顺序没有保证；串成一条链，上一条确认后再发下一条
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly id: string,
    readonly hostKeyFingerprint: string | null,
  ) {}

  write(data: Uint8Array): void {
    this.enqueue(() => invoke('ssh_write', data, { headers: { [SESSION_HEADER]: this.id } }));
  }

  // 回执不进 chain：输出暂停时 Rust 那边的按键可能也在等，回执排在按键后面就会互等
  ack(bytes: number): void {
    invoke('ssh_ack', { id: this.id, bytes }).catch(() => {});
  }

  resize(cols: number, rows: number): void {
    this.enqueue(() => invoke('ssh_resize', { id: this.id, cols, rows }));
  }

  close(): void {
    this.enqueue(() => invoke('ssh_close', { id: this.id }));
  }

  watchMonitor(onSnapshot: (s: MonitorSnapshot) => void, intervalMs: number): () => void {
    const channel = new Channel<MonitorSnapshot>();
    channel.onmessage = onSnapshot;
    let stopped = false;
    call('ssh_monitor_start', { id: this.id, intervalMs, onSnapshot: channel }).catch((err: unknown) => {
      if (!stopped) console.error(`[monitor ${this.id}]`, err);
    });
    return () => {
      stopped = true;
      invoke('ssh_monitor_stop', { id: this.id }).catch(() => {});
    };
  }

  // 会话已关时 Rust 报“会话不存在”，不用管；先于 ssh_monitor_start 到达也没关系，Rust 会记下
  setMonitorDetail(detail: MonitorDetail): void {
    invoke('ssh_monitor_detail', { id: this.id, procs: detail.procs, sockets: detail.sockets }).catch(() => {});
  }

  systemInfo(): Promise<SystemInfo> {
    return call('ssh_system_info', { id: this.id });
  }

  homeDir(): Promise<string> {
    return call('sftp_home', { id: this.id });
  }

  listDir(path: string): Promise<FileEntry[]> {
    return call('sftp_list', { id: this.id, path });
  }

  mkdir(path: string): Promise<void> {
    return call('sftp_mkdir', { id: this.id, path });
  }

  remove(path: string, isDir: boolean): Promise<void> {
    return call('sftp_remove', { id: this.id, path, isDir });
  }

  rename(from: string, to: string): Promise<void> {
    return call('sftp_rename', { id: this.id, from, to });
  }

  stat(path: string): Promise<FileEntry> {
    return call('sftp_stat', { id: this.id, path });
  }

  // Rust 直接回原始字节，这边拿到的是 ArrayBuffer
  async readFile(path: string, maxBytes: number, onProgress?: (p: TransferProgress) => void): Promise<Uint8Array> {
    const progress = new Channel<TransferProgress>();
    progress.onmessage = (p) => onProgress?.(p);
    return new Uint8Array(await call<ArrayBuffer>('sftp_read', { id: this.id, path, maxBytes, onProgress: progress }));
  }

  async upload(remotePath: string, data: Blob, onProgress?: (p: TransferProgress) => void): Promise<void> {
    const progress = new Channel<TransferProgress>();
    progress.onmessage = (p) => onProgress?.(p);
    // 文件内容作为原始字节正文发出，不转 JSON 数组；路径可能含非 ASCII，放请求头前先编码
    const bytes = new Uint8Array(await data.arrayBuffer());
    await invoke('sftp_upload', bytes, {
      headers: {
        [SESSION_HEADER]: this.id,
        [PATH_HEADER]: encodeURIComponent(remotePath),
        [PROGRESS_HEADER]: progress.toJSON(),
      },
    }).catch(rethrow);
  }

  download(remotePath: string, onProgress?: (p: TransferProgress) => void): Promise<string> {
    const progress = new Channel<TransferProgress>();
    progress.onmessage = (p) => onProgress?.(p);
    return call('sftp_download', { id: this.id, path: remotePath, onProgress: progress });
  }

  downloadDir(remotePath: string, onProgress?: (p: TransferProgress) => void): Promise<string> {
    const progress = new Channel<TransferProgress>();
    progress.onmessage = (p) => onProgress?.(p);
    return call('sftp_download_dir', { id: this.id, path: remotePath, onProgress: progress });
  }

  packDownload(dir: string, names: string[], onProgress?: (p: TransferProgress) => void): Promise<string[]> {
    const progress = new Channel<TransferProgress>();
    progress.onmessage = (p) => onProgress?.(p);
    return call('sftp_pack_download', { id: this.id, dir, names, onProgress: progress });
  }

  chmod(path: string, mode: number, scope: PermScope): Promise<void> {
    return call('sftp_chmod', { id: this.id, path, mode, scope });
  }

  removeFast(paths: string[]): Promise<void> {
    return call('ssh_remove_fast', { id: this.id, paths });
  }

  private enqueue(op: () => Promise<unknown>): void {
    this.chain = this.chain.then(op).catch((err: unknown) => {
      console.error(`[ssh ${this.id}]`, err);
    });
  }
}

/** 加密保险箱，开锁的钥匙在系统钥匙串里，见 src-tauri/src/secrets.rs */
const secrets: SecretStore = {
  available: true,
  get: (id) => call<string | null>('secret_get', { id }),
  set: (id, secret) => call('secret_set', { id, secret }),
  remove: (id) => call('secret_remove', { id }),
};

/**
 * 调试版和所有者的正式版共用本机数据（应用标识相同），两边同时同步会互相覆盖，所以调试版不开同步。
 * `tauri dev` 走 vite 开发服务器，DEV 一定为 true；scripts/mac-preview.sh 用的 `tauri build --debug`
 * 由 Tauri CLI 设 TAURI_ENV_DEBUG=true（正式的 `tauri build` 不设），要经 vite.config.ts 的 envPrefix 才进得来
 */
const DEBUG_BUILD = import.meta.env.DEV || import.meta.env.TAURI_ENV_DEBUG === 'true';

/**
 * 云同步的加解密，见 src-tauri/src/sync.rs。保险箱钥匙、同步密码派生出的包裹钥匙、机密原文都留在 Rust 里，
 * 这边只拿到登录凭据和密文。没给的盐和参数显式传 null，和 key_inspect 的写法一致
 */
const sync: SyncPlatform = {
  deviceName: () => call<string>('sync_device_name'),
  derive: (password, account, salt, kdf) =>
    call<{ salt: string; kdf: KdfParams; authKey: string }>('sync_derive', {
      password,
      account,
      salt: salt ?? null,
      kdf: kdf ?? null,
    }),
  wrapKey: () => call<string>('sync_wrap_key'),
  adoptKey: (wrapped) => call('sync_adopt_key', { wrapped }),
  seal: (items) => call<string[]>('sync_seal', { items }),
  open: (items) => call<(string | null)[]>('sync_open', { items }),
  secretDigests: () => call<Record<string, string>>('sync_secret_digests'),
  sealSecret: (id, aad) => call<string | null>('sync_seal_secret', { id, aad }),
  openSecret: (id, aad, data) => call<boolean>('sync_open_secret', { id, aad, data }),
  moveSecret: (from, to) => call('sync_move_secret', { from, to }),
  keyCheck: () => call<string | null>('sync_key_check'),
  disabledReason: DEBUG_BUILD ? '调试版不启动云同步：调试版和正式版共用本机数据，同时同步会互相覆盖。' : undefined,
};

export const tauriBackend: SshBackend = {
  async connect(opts: ConnectOptions, handlers) {
    const onEvent = new Channel<ShellEvent>();
    onEvent.onmessage = (msg) => {
      if (msg instanceof ArrayBuffer) handlers.onData(new Uint8Array(msg));
      else if (msg instanceof Uint8Array) handlers.onData(msg);
      else handlers.onExit(msg.exit, msg.reason ?? null);
    };
    const reply = await invoke<ConnectReply>('ssh_connect', { opts, onEvent }).catch(connectError);
    return new TauriSession(reply.id, reply.fingerprint);
  },
  secrets,
  sync,
  // WKWebView 不处理 <a download>，交给 Rust 写进"下载"目录
  saveFile: (name, data) =>
    invoke<string>('save_download', data, { headers: { 'x-name': encodeURIComponent(name) } }).catch(rethrow),
  async findLocalConfigs() {
    return toLocalConfigs(await call<LocalConfigReply[]>('import_find_local'));
  },
  async findLocalCommands() {
    return toLocalConfigs(await call<LocalConfigReply[]>('import_find_local_commands'));
  },
  // 网页内核读不了云盘里“仅在线”的文件，弹框、读文件都交给 Rust（src-tauri/src/local_file.rs）
  pickPrivateKeyFile: () => call<LocalTextFile | null>('local_pick_key_file'),
  inspectPrivateKey: (privateKey, passphrase) =>
    call<PrivateKeyInfo>('key_inspect', { privateKey, passphrase: passphrase || null }),
  editorWindow: {
    open: (background) => call('editor_window_open', { background }),
    post: (message) => void emitTo(EDITOR_LABEL, EDITOR_MSG, message).catch(() => {}),
    listen: (handler) => listenHere(EDITOR_MSG, handler),
  },
  // 先让 Rust 拦下关闭，问完点了关闭再真的关（src-tauri/src/windows.rs）
  onCloseRequested: (handler) =>
    listenHere('main-close-requested', () => {
      void handler().then((ok) => ok && invoke('main_close_confirmed').catch(() => {}));
    }),
  managerWindow: {
    open: (background) => call('manager_window_open', { background }),
    preload: (background) => void invoke('manager_window_preload', { background }).catch(() => {}),
    post: (message) => void emitTo(MANAGER_LABEL, MANAGER_MSG, message).catch(() => {}),
    listen: (handler) => listenHere(MANAGER_MSG, handler),
  },
};

// ---------- 独立窗口：编辑器（docs/specs/remote-edit.md）、连接管理器（docs/specs/manager-window.md） ----------
// 和 src-tauri/src/windows.rs 对应。几个窗口加载同一个页面，按窗口标签决定显示哪个界面

const MAIN_LABEL = 'main';
const EDITOR_LABEL = 'editor';
const MANAGER_LABEL = 'manager';
const EDITOR_MSG = 'editor-msg';
const MANAGER_MSG = 'manager-msg';
const STORE_SYNC = 'store-sync';

export type WindowKind = 'main' | 'editor' | 'manager';

export function windowKind(): WindowKind {
  const label = getCurrentWebviewWindow().label;
  return label === EDITOR_LABEL ? 'editor' : label === MANAGER_LABEL ? 'manager' : 'main';
}

/** 只收发给本窗口的事件。listen 是异步注册的，取消时等它注册完 */
function listenHere(event: string, handler: (payload: unknown) => void): () => void {
  const off = getCurrentWebviewWindow().listen(event, (e) => handler(e.payload));
  return () => void off.then((f) => f());
}

export const editorHost: EditorWindowHost = {
  post: (message) => void emitTo(MAIN_LABEL, EDITOR_MSG, message).catch(() => {}),
  listen: (handler) => listenHere(EDITOR_MSG, handler),
  setDirty: (dirty) => void invoke('editor_set_dirty', { dirty }).catch(() => {}),
  onQuitRequested: (handler) => listenHere('editor-quit-requested', () => handler()),
  quit: () => void invoke('editor_quit').catch(() => {}),
  onCloseRequested: (handler) => {
    const off = getCurrentWindow().onCloseRequested(async (e) => {
      if (!(await handler())) e.preventDefault();
    });
    return () => void off.then((f) => f());
  },
  close: () => void getCurrentWindow().destroy(),
};

export const managerHost: ManagerWindowHost = {
  post: (message) => void emitTo(MAIN_LABEL, MANAGER_MSG, message).catch(() => {}),
  listen: (handler) => listenHere(MANAGER_MSG, handler),
  // 藏起来，不真的关（src-tauri/src/windows.rs）
  close: () => void invoke('window_hide').catch(() => {}),
  focusMain: () => void invoke('main_window_focus').catch(() => {}),
};

/** 一个窗口写了本地数据，发给所有窗口；自己发的不处理（core/storage.ts） */
export const storageSync: StorageSync = {
  publish: (key, json) => void emit(STORE_SYNC, { from: getCurrentWebviewWindow().label, key, json }).catch(() => {}),
  subscribe: (handler) => {
    const me = getCurrentWebviewWindow().label;
    const off = listen<{ from: string; key: string; json: string }>(STORE_SYNC, (e) => {
      if (e.payload.from !== me) handler(e.payload.key, e.payload.json);
    });
    return () => void off.then((f) => f());
  },
};
