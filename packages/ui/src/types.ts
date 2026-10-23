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
  /** 服务器指纹记录（OpenSSH known_hosts 格式，见 core/known-hosts.ts）。对不上时 connect 抛 HostKeyError */
  knownHosts: string;
}

/** 一把服务器公钥，和 crates/ssh-core/src/known_hosts.rs 的 HostKey 对应 */
export interface HostKeyInfo {
  /** 如 ssh-ed25519 */
  algorithm: string;
  /** SHA256: 开头，和 ssh-keygen -l 一样 */
  fingerprint: string;
  /** known_hosts 一行里主机名后面的部分 */
  openssh: string;
}

/** 指纹记录里和这台服务器有关的一行 */
export interface KnownHostEntry {
  key: HostKeyInfo;
  /** 记录里原样的这一行 */
  line: string;
  /** 没有通配和排除，删掉不影响别的服务器 */
  exact: boolean;
}

/** 指纹校验没通过的情况，和 Rust 的 HostKeyProblem 对应 */
export type HostKeyProblem =
  | { kind: 'unknown'; host: string; port: number; key: HostKeyInfo; otherTypes: KnownHostEntry[] }
  | { kind: 'changed'; host: string; port: number; key: HostKeyInfo; recorded: KnownHostEntry[] }
  | { kind: 'revoked'; host: string; port: number; key: HostKeyInfo };

const HOST_KEY_MESSAGE: Record<HostKeyProblem['kind'], string> = {
  unknown: '需要确认主机密钥',
  changed: '主机密钥已改变，已取消连接',
  revoked: '主机密钥已被吊销，已取消连接',
};

/** 主机密钥没通过校验，连接在发送密码之前就停下了 */
export class HostKeyError extends Error {
  constructor(readonly problem: HostKeyProblem) {
    super(HOST_KEY_MESSAGE[problem.kind]);
    this.name = 'HostKeyError';
  }
}

export interface ShellHandlers {
  /** 远端输出。画完后要用 SshSession.ack 回执，否则后端积压到上限就不再送（见 core/output-ack.ts） */
  onData(data: Uint8Array): void;
  /** 会话结束。reason 是整条连接断掉的原因（心跳超时、服务器断开、网络出错），正常退出时为 null */
  onExit(code: number | null, reason: string | null): void;
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
  /** 回执已经画完的输出字节数。不用排队，可以随时调 */
  ack(bytes: number): void;
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

/** 密码、私钥这类机密的保存位置。桌面端是加密的保险箱（钥匙在系统钥匙串里），网页端不支持。 */
export interface SecretStore {
  /** 为 false 时界面不提供“记住密码”，每次连接都询问 */
  readonly available: boolean;
  get(id: string): Promise<string | null>;
  set(id: string, secret: string): Promise<void>;
  remove(id: string): Promise<void>;
}

/** 别的 SSH 软件默认存配置的位置，以及在那里读到的文件。一键导入用，见 core/importers/local.ts */
export interface LocalConfigFiles {
  /** 来源，取值同 core/importers/types.ts 的 ImportSource；不认识的界面会忽略 */
  source: string;
  /** 给用户看的位置，如 ~/Library/FinalShell/conn */
  location: string;
  /** 相对路径带所在文件夹名，和浏览器选文件夹时一样；位置不存在时为空 */
  files: { path: string; bytes: Uint8Array }[];
  /** 位置在、但读不了的原因 */
  error: string | null;
}

export interface SshBackend {
  connect(opts: ConnectOptions, handlers: ShellHandlers): Promise<SshSession>;
  readonly secrets: SecretStore;
  /** 把本地生成的文件（如导出的连接）存给用户：桌面端存进“下载”目录并返回完整路径；网页端交给浏览器下载并返回文件名 */
  saveFile(name: string, data: Uint8Array): Promise<string>;
  /**
   * 一键导入：到本机各 SSH 软件默认存配置的位置读文件，只返回本平台查过的来源。
   * 读哪些位置由后端决定，不接受路径。网页端读不了本机文件，不提供。
   */
  findLocalConfigs?(): Promise<LocalConfigFiles[]>;
}
