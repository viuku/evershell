// 云同步给界面看的类型和错误。单独放一个文件，引擎和界面接口都从这里拿，免得 index.ts 和引擎互相引用

export type SyncState = 'off' | 'syncing' | 'ok' | 'offline' | 'error' | 'relogin';

/** 各样数据的条数；同步窗口的“同步内容”和开启完成框里的数字都用它 */
export interface SyncCounts {
  servers: number;
  folders: number;
  keys: number;
  snippets: number;
  history: number;
  recents: number;
  knownHosts: number;
}

export interface SyncStatus {
  state: SyncState;
  /** 上次成功同步的时间（毫秒） */
  lastSyncAt: number | null;
  /** 同步失败、离线时给人看的原因，其他状态为空串 */
  message: string;
  /** 下面三项没开同步时为 null */
  server: string | null;
  account: string | null;
  deviceName: string | null;
  /** 本机现有的条数（不含已删除的） */
  counts: SyncCounts;
}

export interface SyncDevice {
  id: string;
  name: string;
  /** 'macos' | 'windows' | 'linux' | 'web' | … */
  platform: string;
  lastSeenAt: number;
  current: boolean;
}

/** 开启同步的结果，完成框里的那句话由 describeEnableResult 拼 */
export interface EnableResult {
  mode: 'register' | 'login';
  /** 本机发上去的 */
  uploaded: SyncCounts;
  /** 从云端取回、写进本机的 */
  downloaded: SyncCounts;
  /** 本机和云端完全相同、合并成一份的 */
  merged: SyncCounts;
}

/** 错误代码见 docs/specs/sync.md 的接口表，另有 'network'（连不上）、'unsupported'（平台不支持）、'invalid'（表单不对）。message 直接给用户看 */
export class SyncError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

export function emptyCounts(): SyncCounts {
  return { servers: 0, folders: 0, keys: 0, snippets: 0, history: 0, recents: 0, knownHosts: 0 };
}
