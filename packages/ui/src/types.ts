// 界面与后端之间的接口。桌面端（Tauri，apps/desktop/src/tauri-backend.ts）
// 和网页端（WASM + 中转，apps/web/src/wasm-backend.ts）各实现一份，界面只依赖这里。

export type AuthConfig =
  | { type: 'password'; password: string }
  | { type: 'key'; privateKey: string; passphrase?: string };

export interface ConnectOptions {
  host: string;
  port: number;
  user: string;
  auth: AuthConfig;
  cols: number;
  rows: number;
}

export interface ShellHandlers {
  onData(data: Uint8Array): void;
  onExit(code: number | null): void;
}

/** 一次监控采样。数值都是原始单位（字节、0–100 的百分比），格式化交给界面。 */
export interface MonitorSnapshot {
  /** 服务器不是 Linux、或采集命令失败时为 false，此时其余字段无意义 */
  supported: boolean;
  uptimeSecs: number;
  load: [number, number, number];
  cpuPercent: number;
  cpuCores: number;
  memTotal: number;
  memUsed: number;
  swapTotal: number;
  swapUsed: number;
  /** 各网卡（不含 lo）的速率；第一次采样还算不出速率，为空数组 */
  net: { iface: string; rxPerSec: number; txPerSec: number }[];
  /** 按内存占用从高到低，最多 10 个 */
  procs: { name: string; memBytes: number; cpuPercent: number }[];
  /** 真实文件系统的挂载点（不含 tmpfs、overlay 等） */
  disks: { mount: string; size: number; avail: number }[];
  /** 本机到服务器的往返延迟；测不出时为 null */
  latencyMs: number | null;
}

export interface FileEntry {
  name: string;
  kind: 'dir' | 'file' | 'link';
  size: number;
  /** 修改时间，Unix 秒 */
  mtime: number;
  /** 形如 drwxr-xr-x */
  perm: string;
  /** 用户名；拿不到时为 uid 数字的字符串 */
  owner: string;
}

export interface TransferProgress {
  done: number;
  total: number;
}

export interface SshSession {
  readonly hostKeyFingerprint: string | null;
  /** 同步调用、不等待，但实现必须保证按调用顺序发出 */
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): void;

  /** 开始周期采样，返回停止函数。同一会话同一时间只会有一个监听 */
  watchMonitor(onSnapshot: (s: MonitorSnapshot) => void, intervalMs: number): () => void;

  /** 登录用户的家目录（绝对路径） */
  homeDir(): Promise<string>;
  listDir(path: string): Promise<FileEntry[]>;
  mkdir(path: string): Promise<void>;
  remove(path: string, isDir: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  upload(remotePath: string, data: Blob, onProgress?: (p: TransferProgress) => void): Promise<void>;
  /** 桌面端保存到“下载”目录并返回本地路径；网页端交给浏览器下载并返回文件名 */
  download(remotePath: string, onProgress?: (p: TransferProgress) => void): Promise<string>;
}

/** 密码、私钥这类机密的保存位置。桌面端是系统钥匙串，网页端不支持。 */
export interface SecretStore {
  /** 为 false 时界面不提供“记住密码”，每次连接都询问 */
  readonly available: boolean;
  get(id: string): Promise<string | null>;
  set(id: string, secret: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface SshBackend {
  connect(opts: ConnectOptions, handlers: ShellHandlers): Promise<SshSession>;
  readonly secrets: SecretStore;
  /** 把本地生成的文件（如导出的连接）存给用户：桌面端存进“下载”目录并返回完整路径；网页端交给浏览器下载并返回文件名 */
  saveFile(name: string, data: Uint8Array): Promise<string>;
}
