import { HostKeyError } from '@evershell/ui';
import type {
  ConnectOptions,
  FileEntry,
  HostKeyProblem,
  MonitorSnapshot,
  SecretStore,
  SshBackend,
  SshSession,
  TransferProgress,
} from '@evershell/ui';
import { Channel, invoke } from '@tauri-apps/api/core';

// 与 src-tauri/src/commands.rs 对应
interface ConnectReply {
  id: string;
  fingerprint: string | null;
}

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
  // WKWebView 不处理 <a download>，交给 Rust 写进"下载"目录
  saveFile: (name, data) =>
    invoke<string>('save_download', data, { headers: { 'x-name': encodeURIComponent(name) } }).catch(rethrow),
};
