import init, { WebSession } from '@evershell/ssh-wasm';
import { browserDownload, HostKeyError } from '@evershell/ui';
import type {
  ConnectOptions,
  FileEntry,
  HostKeyProblem,
  MonitorDetail,
  MonitorSnapshot,
  SecretStore,
  SshBackend,
  SshSession,
  SystemInfo,
  TransferProgress,
} from '@evershell/ui';

export type RelayConfig = { url: string; token: string };

let ready: Promise<unknown> | undefined;

/** wasm-bindgen 抛出的 JsError 是 Error 实例，这里统一成 Error 交给界面显示 */
function rethrow(err: unknown): never {
  throw err instanceof Error ? err : new Error(String(err));
}

/** 指纹没通过时 WASM 抛的是 { kind: 'hostKey', problem }，见 crates/ssh-wasm 的 connect */
function connectError(err: unknown): never {
  if (err && typeof err === 'object' && (err as { kind?: unknown }).kind === 'hostKey') {
    throw new HostKeyError((err as { problem: HostKeyProblem }).problem);
  }
  rethrow(err);
}

/** 浏览器里没有钥匙串，界面不提供"记住密码" */
const noSecrets: SecretStore = {
  available: false,
  get: async () => null,
  set: async () => {},
  remove: async () => {},
};

class WasmSession implements SshSession {
  readonly hostKeyFingerprint: string | null;

  constructor(private readonly inner: WebSession) {
    this.hostKeyFingerprint = inner.hostKeyFingerprint ?? null;
  }

  // 写操作在 WASM 里排进同一个队列，按调用顺序发出
  write(data: Uint8Array): void {
    this.inner.write(data);
  }

  ack(bytes: number): void {
    this.inner.ack(bytes);
  }

  resize(cols: number, rows: number): void {
    this.inner.resize(cols, rows);
  }

  close(): void {
    this.inner.close();
  }

  watchMonitor(onSnapshot: (s: MonitorSnapshot) => void, intervalMs: number): () => void {
    this.inner.startMonitor(intervalMs, onSnapshot);
    return () => this.inner.stopMonitor();
  }

  setMonitorDetail(detail: MonitorDetail): void {
    this.inner.setMonitorDetail(detail.procs, detail.sockets);
  }

  systemInfo(): Promise<SystemInfo> {
    return (this.inner.systemInfo() as Promise<SystemInfo>).catch(rethrow);
  }

  homeDir(): Promise<string> {
    return this.inner.homeDir().catch(rethrow);
  }

  listDir(path: string): Promise<FileEntry[]> {
    return (this.inner.listDir(path) as Promise<FileEntry[]>).catch(rethrow);
  }

  mkdir(path: string): Promise<void> {
    return this.inner.mkdir(path).catch(rethrow);
  }

  remove(path: string, isDir: boolean): Promise<void> {
    return this.inner.remove(path, isDir).catch(rethrow);
  }

  rename(from: string, to: string): Promise<void> {
    return this.inner.rename(from, to).catch(rethrow);
  }

  stat(path: string): Promise<FileEntry> {
    return (this.inner.stat(path) as Promise<FileEntry>).catch(rethrow);
  }

  readFile(path: string, maxBytes: number, onProgress?: (p: TransferProgress) => void): Promise<Uint8Array> {
    return this.inner.readFile(path, BigInt(maxBytes), onProgress).catch(rethrow);
  }

  async upload(remotePath: string, data: Blob, onProgress?: (p: TransferProgress) => void): Promise<void> {
    const bytes = new Uint8Array(await data.arrayBuffer());
    await this.inner.upload(remotePath, bytes, onProgress).catch(rethrow);
  }

  /** 字节取回后交给浏览器下载，返回文件名 */
  async download(remotePath: string, onProgress?: (p: TransferProgress) => void): Promise<string> {
    const bytes = await this.inner.download(remotePath, onProgress).catch(rethrow);
    const name = remotePath.split('/').filter(Boolean).pop() ?? 'download';
    // 拷一份，避免 SharedArrayBuffer 类型的歧义；wasm 返回的数组本来就是独立拷贝
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 等浏览器接手下载后再释放
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return name;
  }
}

/**
 * 网页版后端：SSH 协议在浏览器里的 WASM 中运行，经 WebSocket 中转连到服务器。
 * 中转（services/relay-node 或 relay-worker）只转发字节，看不到密码和私钥。
 */
export function createWasmBackend(getRelay: () => RelayConfig): SshBackend {
  return {
    async connect(opts: ConnectOptions, handlers): Promise<SshSession> {
      ready ??= init();
      await ready;

      const relay = getRelay();
      if (!relay.url) throw new Error('请先在顶部填写中转地址');
      const host = opts.host.includes(':') ? `[${opts.host}]` : opts.host;
      const url =
        `${relay.url.replace(/\/+$/, '')}/relay` +
        `?target=${encodeURIComponent(`${host}:${opts.port}`)}` +
        `&token=${encodeURIComponent(relay.token)}`;

      const key = opts.auth.type === 'key' ? opts.auth : null;
      const session = await WebSession.connect(
        url,
        opts.host,
        opts.port,
        opts.knownHosts,
        opts.user,
        opts.auth.type === 'password' ? opts.auth.password : null,
        key?.privateKey ?? null,
        key?.passphrase || null,
        opts.cols,
        opts.rows,
        handlers.onData,
        (code: number | null, reason: string | null) => handlers.onExit(code, reason),
      ).catch(connectError);

      return new WasmSession(session);
    },
    secrets: noSecrets,
    saveFile: async (name, data) => browserDownload(name, data),
  };
}
