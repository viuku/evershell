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

/**
 * 采样时顺带多取哪些数据。只在开着对应标签页时打开：进程和网络连接的数据量大，一直取会加重服务器负担。
 * 和 crates/ssh-core/src/monitor.rs 的 `MonitorDetail` 对应
 */
export interface MonitorDetail {
  /** 全部进程（含用户、命令行、程序位置），给进程标签页 */
  procs: boolean;
  /** 监听端口和连接，给网络标签页 */
  sockets: boolean;
}

/** CPU 时间按用途分的百分比，加起来是 100 */
export interface CpuDetail {
  user: number;
  nice: number;
  system: number;
  idle: number;
  /** 等硬盘读写 */
  iowait: number;
  /** 硬件中断 */
  irq: number;
  /** 软件中断 */
  softirq: number;
  /** 虚拟机被宿主机拿去跑别的机器的时间（top 里的 st） */
  steal: number;
}

/** 一块网卡（含 lo）的累计收发量和速率 */
export interface IfaceStat {
  iface: string;
  rxBytes: number;
  txBytes: number;
  /** 第一次采样、或这块网卡刚出现时算不出速率，为 null */
  rxPerSec: number | null;
  txPerSec: number | null;
}

/** 进程标签页的一行 */
export interface ProcDetail {
  pid: number;
  /** 用户名；拿不到时为空字符串 */
  user: string;
  /** /proc/<pid>/stat 里的进程名，最长 15 个字符 */
  name: string;
  /** 完整命令行；内核线程没有，为空字符串。服务器给的文本，控制字符已换成空格 */
  cmdline: string;
  /** 程序文件的位置；内核线程、或没有权限看别的用户的进程时为空字符串 */
  exe: string;
  memBytes: number;
  /** 和 MonitorSnapshot.procs 的 cpuPercent 一样，100 表示占满一个核 */
  cpuPercent: number;
}

/** 网络标签页的一行：一个监听的地址和端口，或者一个进程主动连出去的连接汇总 */
export interface SocketRow {
  /** 不是 root 登录时看不到别的用户的进程，为 null */
  pid: number | null;
  /** 进程名；看不到时为空字符串 */
  name: string;
  /** 监听的地址，如 0.0.0.0、::、127.0.0.1；主动连出去的那一行为 null */
  listenIp: string | null;
  /** 监听的端口；主动连出去的那一行为 null */
  port: number | null;
  /** 有几个不同的对方 IP */
  ips: number;
  /** 几条已建立的连接 */
  conns: number;
  /** 这些连接的上传、下载速率，字节/秒；第一次采样为 0 */
  txPerSec: number;
  rxPerSec: number;
}

export interface SocketTable {
  /** 服务器上没有 ss 命令时为 false，rows 为空 */
  available: boolean;
  rows: SocketRow[];
}

/** 型号相同的一组 CPU */
export interface CpuGroup {
  /** 型号；/proc/cpuinfo 里没有时为空字符串 */
  model: string;
  /** 物理 CPU 颗数；拿不到时为 null */
  sockets: number | null;
  /** 每颗几个核心；拿不到时为 null */
  coresPerSocket: number | null;
  /** 逻辑 CPU 数（线程数），也就是 top 里看到的 CPU 个数 */
  threads: number;
  /** 当前主频（这组的平均），MHz；拿不到时为 null */
  mhz: number | null;
  /** 缓存，原样取 /proc/cpuinfo 的写法，如“16384 KB”；拿不到时为 null */
  cache: string | null;
  bogomips: number | null;
}

/** 不怎么变的系统信息，打开系统信息标签页时取一次。拿不到的项为空字符串 */
export interface SystemInfo {
  /** 发行版，如 Ubuntu 24.04 LTS */
  os: string;
  /** uname -s，如 Linux */
  kernel: string;
  /** uname -r，如 6.8.0-110-generic */
  kernelRelease: string;
  /** uname -m，如 x86_64 */
  arch: string;
  hostname: string;
  cpus: CpuGroup[];
}

/** 一次监控采样。数值都是原始单位（字节、0–100 的百分比），格式化交给界面。 */
export interface MonitorSnapshot {
  /** 服务器不是 Linux、或采集命令失败时为 false，此时其余字段无意义 */
  supported: boolean;
  uptimeSecs: number;
  load: [number, number, number];
  cpuPercent: number;
  /** CPU 时间按用途分；第一次采样为 null */
  cpuDetail: CpuDetail | null;
  cpuCores: number;
  memTotal: number;
  memUsed: number;
  swapTotal: number;
  swapUsed: number;
  /** 各网卡（不含 lo）的速率；第一次采样还算不出速率，为空数组 */
  net: { iface: string; rxPerSec: number; txPerSec: number }[];
  /** 全部网卡（含 lo）的累计收发量和速率，给系统信息标签页 */
  ifaces: IfaceStat[];
  /**
   * 内存前 10 和 CPU 前 10 的并集（最多 20 个），按内存从高到低，界面按用户选的列重排后取前 10。
   * cpuPercent 是两次采样之间的占用，和 top 一样 100 表示占满一个核，可以超过 100；第一次采样为 0。
   */
  procs: { pid: number; name: string; memBytes: number; cpuPercent: number }[];
  /** 真实文件系统的挂载点（不含 tmpfs、overlay 等）。device 如 /dev/vda1，fsType 如 ext4，拿不到时为空字符串 */
  disks: { mount: string; size: number; used: number; avail: number; device: string; fsType: string }[];
  /** 打开了 MonitorDetail.procs 才有：全部进程，顺序不定；否则为 null */
  allProcs: ProcDetail[] | null;
  /** 打开了 MonitorDetail.sockets 才有；否则为 null */
  sockets: SocketTable | null;
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
  /** 改采样时顺带多取哪些数据，改了马上采一次；没在采样时先记下，下次开始采样时用 */
  setMonitorDetail(detail: MonitorDetail): void;
  /** 取一次系统信息（发行版、内核、CPU 型号这些不怎么变的） */
  systemInfo(): Promise<SystemInfo>;

  /** 登录用户的家目录（绝对路径） */
  homeDir(): Promise<string>;
  listDir(path: string): Promise<FileEntry[]>;
  mkdir(path: string): Promise<void>;
  remove(path: string, isDir: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** 一个文件或目录的信息，跟着符号链接走；服务器没给用户名时 owner 是 uid */
  stat(path: string): Promise<FileEntry>;
  /** 整个文件读进内存，给编辑器用；比 maxBytes 大就报错，不读 */
  readFile(path: string, maxBytes: number, onProgress?: (p: TransferProgress) => void): Promise<Uint8Array>;
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

/** 用户在本机选的一个文本文件 */
export interface LocalTextFile {
  name: string;
  text: string;
}

/** 认出来的私钥，见 crates/ssh-core/src/keys.rs */
export interface PrivateKeyInfo {
  /** RSA、ED25519、ECDSA、DSA… */
  algorithm: string;
  bits: number;
  /** 公钥指纹 SHA256:… */
  fingerprint: string;
  /** 设了口令 */
  encrypted: boolean;
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
  /**
   * 选私钥文件，由后端读出内容。取消返回 null，读不了抛错（文案直接给用户看）。
   * 桌面端用：网页内核读不了 OneDrive、iCloud 里“仅在线”的文件，选了没反应（docs/handbook/pitfalls.md）。
   * 没有这项的平台（网页端）用浏览器的选文件框
   */
  pickPrivateKeyFile?: () => Promise<LocalTextFile | null>;
  /**
   * 认私钥的类型、长度和指纹；是公钥、要口令、口令不对、认不出来时抛错（文案直接给用户看）。
   * 私钥库要用（docs/specs/key-library.md）；网页端不保存私钥，没有这项
   */
  inspectPrivateKey?: (privateKey: string, passphrase?: string) => Promise<PrivateKeyInfo>;
  /**
   * 点了主窗口的关闭按钮（桌面端）：handler 返回 true 才真的关，用来先问一句“确定关闭窗口吗”。
   * 返回取消函数。网页端关页签由浏览器管，没有这项
   */
  onCloseRequested?(handler: () => Promise<boolean>): () => void;
  /**
   * 独立的编辑窗口（docs/specs/remote-edit.md），主窗口这一头。
   * 没有这项的平台（网页端）编辑器在主窗口里浮着
   */
  editorWindow?: WindowLink;
  /**
   * 独立的连接管理器窗口（docs/specs/manager-window.md），主窗口这一头。
   * 没有这项的平台（网页端）连接管理器是主窗口里的弹窗
   */
  managerWindow?: WindowLink;
}

/** 主窗口这一头：打开某个独立窗口、和它收发消息。消息内容由 core/remote-edit.ts、core/manager-link.ts 定 */
export interface WindowLink {
  /**
   * 打开窗口，已经开着就切到前面。background 是界面现在的底色（#rrggbb）：
   * 新窗口里的网页画出来之前先露出这个颜色，深色模式下不会先白一下
   */
  open(background?: string): Promise<void>;
  /** 先在后台把窗口建好、藏着，之后 open 时直接亮出来，不用等它加载（连接管理器用） */
  preload?(background?: string): void;
  post(message: unknown): void;
  /** 返回取消函数 */
  listen(handler: (message: unknown) => void): () => void;
}

/** 连接管理器窗口这一头 */
export interface ManagerWindowHost {
  post(message: unknown): void;
  listen(handler: (message: unknown) => void): () => void;
  /** 关掉连接管理器窗口（桌面端其实是藏起来，下次打开不用再加载） */
  close(): void;
  /** 把主窗口切到前面（连接是在主窗口里开的） */
  focusMain(): void;
}

/**
 * 几个窗口共用本地数据时，一个窗口写了，通知其他窗口换成新内容（见 core/storage.ts）。
 * 只有桌面端有多个窗口；浏览器多开页签靠自带的 storage 事件，不用这个
 */
export interface StorageSync {
  publish(key: string, json: string): void;
  /** 收别的窗口写的；返回取消函数 */
  subscribe(handler: (key: string, json: string) => void): () => void;
}

/** 编辑窗口这一头，只在有独立编辑窗口的平台上有 */
export interface EditorWindowHost {
  post(message: unknown): void;
  listen(handler: (message: unknown) => void): () => void;
  /** 告诉平台编辑窗口里有没有没保存的修改：主窗口要关时据此决定先别关 */
  setDirty(dirty: boolean): void;
  /** 主窗口要关、编辑窗口里还有没保存的：让编辑窗口问一下。返回取消函数 */
  onQuitRequested(handler: () => void): () => void;
  /** 问完了（保存了或不要了），把编辑窗口和主窗口一起关掉 */
  quit(): void;
  /** 点了编辑窗口的关闭按钮。handler 返回 false 就不关。返回取消函数 */
  onCloseRequested(handler: () => Promise<boolean>): () => void;
  /** 关掉编辑窗口（不再问） */
  close(): void;
}
