// 同步服务的存储接口。app.ts 只认这里的接口，不知道背后是 D1 还是 node:sqlite，
// 两种部署方式因此能共用同一份路由代码（docs/specs/sync.md「同步服务」）。

export interface AccountRow {
  id: number;
  name: string;
  /** HMAC-SHA256(PEPPER, 登录凭据)，十六进制 */
  verifier: string;
  salt: string;
  /** KDF 参数的 JSON 文本 */
  kdf: string;
  wrappedKey: string;
}

export interface NewAccount {
  name: string;
  verifier: string;
  salt: string;
  kdf: string;
  wrappedKey: string;
  createdAt: number;
}

export interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
}

export interface SessionRow {
  tokenHash: string;
  accountId: number;
  account: string;
  deviceId: string;
  lastSeenAt: number;
}

export interface DeviceRow extends DeviceInfo {
  lastSeenAt: number;
}

export interface PushRecord {
  collection: string;
  id: string;
  hlc: string;
  deleted: boolean;
  data: string;
}

export interface PulledRecord extends PushRecord {
  seq: number;
}

export type PushResult =
  | { ok: false; reason: 'quota_exceeded' }
  | { ok: true; seq: number; results: ({ status: 'ok' } | { status: 'stale'; hlc: string })[] };

export interface PullResult {
  records: PulledRecord[];
  seq: number;
  more: boolean;
}

export interface Store {
  findAccount(name: string): Promise<AccountRow | null>;
  /** 账号已存在时返回 null，不抛错 */
  createAccount(account: NewAccount): Promise<number | null>;
  /** 同一台设备再次登录时顶掉它的旧令牌，设备列表里一台设备只出现一次；顺带清掉这个账号的登录失败记录 */
  createSession(accountId: number, account: string, tokenHash: string, device: DeviceInfo, now: number): Promise<void>;
  findSession(tokenHash: string): Promise<SessionRow | null>;
  touchSession(tokenHash: string, now: number): Promise<void>;
  deleteSession(tokenHash: string): Promise<void>;
  deleteDeviceSessions(accountId: number, deviceId: string): Promise<void>;
  renameDevice(accountId: number, deviceId: string, name: string): Promise<void>;
  listDevices(accountId: number): Promise<DeviceRow[]>;

  countLoginFailures(account: string, since: number): Promise<number>;
  /** 记一次失败，顺带删掉 before 之前的旧记录，表不会越积越大 */
  addLoginFailure(account: string, at: number, before: number): Promise<void>;

  /** 换登录凭据和包裹好的钥匙，并吊销除 keepTokenHash 以外的所有令牌，在一个事务里完成 */
  changePassword(
    accountId: number,
    secret: { verifier: string; salt: string; kdf: string; wrappedKey: string },
    keepTokenHash: string,
  ): Promise<void>;

  usage(accountId: number): Promise<{ bytes: number; records: number }>;
  /** records 里不会有重复的（集合, id），调用方已经查过 */
  pushRecords(accountId: number, records: PushRecord[], quotaBytes: number): Promise<PushResult>;
  pullRecords(accountId: number, since: number, limit: number, maxBytes: number): Promise<PullResult>;
}
