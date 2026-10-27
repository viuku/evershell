import type { KdfParams } from '../../types';
import { isHlc } from './hlc';
import { SyncError } from './model';

// 同步服务器接口的封装（docs/specs/sync.md「接口（v1）」）。服务器给的一切都当不可信输入：
// 返回的格式先校验；服务器的 message 不拿来给用户看（可能被冒充的服务器写成钓鱼文字），只认错误代码。

export interface WireRecord {
  collection: string;
  id: string;
  hlc: string;
  deleted: boolean;
  data: string;
}

export interface PulledRecord extends WireRecord {
  seq: number;
}

export interface DeviceInfo {
  id: string;
  name: string;
  platform: string;
}

export interface AccountInfo {
  account: string;
  devices: { id: string; name: string; platform: string; lastSeenAt: number; current: boolean }[];
}

export type Registration = 'invite' | 'open' | 'closed';

/** 一次请求最多等多久；退出登录另给短的 */
const TIMEOUT_MS = 30_000;

/** 去掉首尾空白、末尾的斜杠 */
export function normalizeServer(server: string): string {
  return server.trim().replace(/\/+$/, '');
}

/** 账号名一律去掉首尾空白、转小写（FinalShell 出过大小写不一致导致解不开的问题） */
export function normalizeAccount(account: string): string {
  return account.trim().toLowerCase();
}

/** 服务器给的 KDF 参数要在范围内才用，免得被设成一个能把电脑内存吃光的数 */
export function kdfInRange(kdf: unknown): kdf is KdfParams {
  if (!kdf || typeof kdf !== 'object') return false;
  const k = kdf as Record<string, unknown>;
  const int = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
  return k.alg === 'argon2id' && int(k.mKib, 8 * 1024, 1024 * 1024) && int(k.t, 1, 10) && int(k.p, 1, 4);
}

function badResponse(): SyncError {
  return new SyncError('bad_response', '服务器返回的数据格式不正确');
}

function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

export class SyncClient {
  private readonly fetchFn: typeof fetch;

  constructor(
    readonly base: string,
    fetchFn: typeof fetch,
    public token: string | null = null,
  ) {
    // 不能当方法调全局 fetch（浏览器里会报 Illegal invocation），包一层
    this.fetchFn = (input, init) => fetchFn(input, init);
  }

  private async call(method: string, path: string, body?: unknown, opts: { auth?: boolean; timeoutMs?: number } = {}): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (opts.auth !== false) {
      if (!this.token) throw new SyncError('unauthorized', '登录已失效');
      headers.authorization = `Bearer ${this.token}`;
    }
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs ?? TIMEOUT_MS) : null;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/v1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl?.signal,
      });
    } catch (e) {
      console.warn('[sync] 请求失败', e);
      throw new SyncError('network', '无法连接同步服务器');
    } finally {
      if (timer) clearTimeout(timer);
    }
    let text = '';
    try {
      text = await res.text();
    } catch {
      throw new SyncError('network', '无法连接同步服务器');
    }
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }
    if (res.ok) {
      if (res.status === 204) return null;
      if (json === undefined) throw new SyncError('not_evershell', '该地址不是 EverShell 同步服务');
      return json;
    }
    throw errorFrom(res.status, json, text);
  }

  async info(): Promise<{ registration: Registration }> {
    const r = (await this.call('GET', '/info', undefined, { auth: false })) as Record<string, unknown> | null;
    if (!r || r.service !== 'evershell-sync') throw new SyncError('not_evershell', '该地址不是 EverShell 同步服务');
    if (r.version !== 1) throw new SyncError('version', '同步服务的版本不受支持');
    const registration = r.registration === 'invite' || r.registration === 'open' ? r.registration : 'closed';
    return { registration };
  }

  async prelogin(account: string): Promise<{ salt: string; kdf: KdfParams }> {
    const r = (await this.call('POST', '/prelogin', { account }, { auth: false })) as Record<string, unknown> | null;
    if (!r || !isStr(r.salt)) throw badResponse();
    if (!kdfInRange(r.kdf)) throw new SyncError('bad_kdf', '服务器提供的密钥参数超出允许范围');
    return { salt: r.salt, kdf: r.kdf };
  }

  async register(body: {
    account: string;
    invite?: string;
    authKey: string;
    salt: string;
    kdf: KdfParams;
    wrappedKey: string;
    device: DeviceInfo;
  }): Promise<{ token: string }> {
    const r = (await this.call('POST', '/register', body, { auth: false })) as Record<string, unknown> | null;
    if (!r || !isStr(r.token) || !r.token) throw badResponse();
    return { token: r.token };
  }

  async login(body: { account: string; authKey: string; device: DeviceInfo }): Promise<{ token: string; wrappedKey: string }> {
    const r = (await this.call('POST', '/login', body, { auth: false })) as Record<string, unknown> | null;
    if (!r || !isStr(r.token) || !r.token || !isStr(r.wrappedKey)) throw badResponse();
    return { token: r.token, wrappedKey: r.wrappedKey };
  }

  async logout(timeoutMs?: number): Promise<void> {
    await this.call('POST', '/logout', undefined, { timeoutMs });
  }

  async account(): Promise<AccountInfo> {
    const r = (await this.call('GET', '/account')) as Record<string, unknown> | null;
    if (!r || !Array.isArray(r.devices)) throw badResponse();
    const devices: AccountInfo['devices'] = [];
    for (const d of r.devices as unknown[]) {
      if (!d || typeof d !== 'object') continue;
      const x = d as Record<string, unknown>;
      if (!isStr(x.id)) continue;
      devices.push({
        id: x.id,
        name: isStr(x.name) ? x.name : '',
        platform: isStr(x.platform) ? x.platform : '',
        lastSeenAt: typeof x.lastSeenAt === 'number' ? x.lastSeenAt : 0,
        current: x.current === true,
      });
    }
    return { account: isStr(r.account) ? r.account : '', devices };
  }

  async renameDevice(name: string): Promise<void> {
    await this.call('PATCH', '/device', { name });
  }

  async removeDevice(id: string): Promise<void> {
    await this.call('DELETE', `/devices/${encodeURIComponent(id)}`);
  }

  async changePassword(body: { authKey: string; salt: string; kdf: KdfParams; wrappedKey: string }): Promise<void> {
    await this.call('POST', '/password', body);
  }

  async push(records: WireRecord[]): Promise<{ status: 'ok' | 'stale'; hlc?: string }[]> {
    const r = (await this.call('POST', '/records', { records })) as Record<string, unknown> | null;
    if (!r || !Array.isArray(r.results) || r.results.length !== records.length) throw badResponse();
    return (r.results as unknown[]).map((x) => {
      const o = (x ?? {}) as Record<string, unknown>;
      if (o.status !== 'ok' && o.status !== 'stale') throw badResponse();
      return { status: o.status, hlc: isHlc(o.hlc) ? o.hlc : undefined };
    });
  }

  async pull(since: number, limit = 500): Promise<{ records: PulledRecord[]; seq: number; more: boolean }> {
    const r = (await this.call('GET', `/records?since=${since}&limit=${limit}`)) as Record<string, unknown> | null;
    if (!r || !Array.isArray(r.records) || typeof r.seq !== 'number') throw badResponse();
    const records: PulledRecord[] = [];
    for (const x of r.records as unknown[]) {
      const o = (x ?? {}) as Record<string, unknown>;
      // 格式不对的单条跳过，不影响别的；序号不对就整页不认
      if (typeof o.seq !== 'number' || !Number.isFinite(o.seq)) throw badResponse();
      if (!isStr(o.collection) || !isStr(o.id) || !isHlc(o.hlc) || typeof o.deleted !== 'boolean' || !isStr(o.data)) {
        records.push({ collection: '', id: '', hlc: '', deleted: false, data: '', seq: o.seq });
        continue;
      }
      records.push({ collection: o.collection, id: o.id, hlc: o.hlc, deleted: o.deleted, data: o.data, seq: o.seq });
    }
    return { records, seq: r.seq, more: r.more === true };
  }
}

/** HTTP 错误转成 SyncError：代码以服务器的 error 字段为准，额度用完（429、Cloudflare 1027 页面）记成 rate_limited */
function errorFrom(status: number, json: unknown, text: string): SyncError {
  const raw = json && typeof json === 'object' ? (json as Record<string, unknown>).error : undefined;
  const known = typeof raw === 'string' && /^[a-z_]{1,40}$/.test(raw) ? raw : null;
  if (known === 'too_many_attempts') return new SyncError(known, reasonFor(known));
  if (status === 429 || (!known && /\b10(27|15)\b/.test(text))) return new SyncError('rate_limited', reasonFor('rate_limited'));
  if (status === 401 && (!known || known === 'unauthorized')) return new SyncError('unauthorized', reasonFor('unauthorized'));
  // 服务器的 invalid（请求格式不对）和表单检查的 invalid 分开；不认识的代码按 HTTP 状态说
  const code = known === 'invalid' ? 'bad_request' : known && SERVER_CODES.has(known) ? known : `http_${status}`;
  return new SyncError(code, reasonFor(code));
}

/** 接口表里列出的错误代码 */
const SERVER_CODES = new Set([
  'bad_credentials',
  'too_many_attempts',
  'account_exists',
  'bad_invite',
  'registration_closed',
  'unauthorized',
  'quota_exceeded',
  'clock_skew',
]);

/** 本身就是整句、原样给用户看的错误代码（表单检查、平台不支持、状态不对） */
const FINAL_CODES = new Set(['invalid', 'unsupported', 'state']);

/** 错误代码对应的原因（不带“××失败：”），状态栏的明细直接用它 */
export function reasonFor(code: string): string {
  switch (code) {
    case 'network':
      return '无法连接同步服务器';
    case 'rate_limited':
      return '同步服务器的请求额度已用完，稍后将自动重试';
    case 'not_evershell':
      return '该地址不是 EverShell 同步服务';
    case 'version':
      return '同步服务的版本不受支持';
    case 'bad_response':
      return '服务器返回的数据格式不正确';
    case 'bad_credentials':
      return '账号或同步密码不正确';
    case 'too_many_attempts':
      return '尝试次数过多，请 15 分钟后重试';
    case 'account_exists':
      return '该账号已存在';
    case 'bad_invite':
      return '邀请码不正确';
    case 'registration_closed':
      return '该服务器未开放注册';
    case 'unauthorized':
      return '登录已失效，请重新登录';
    case 'quota_exceeded':
      return '云端空间已满';
    case 'clock_skew':
      return '本机时间与服务器相差过大，请校准系统时间';
    case 'bad_request':
      return '服务器拒绝处理该请求';
    case 'bad_kdf':
      return '服务器提供的密钥参数超出允许范围';
    case 'decrypt':
      return '部分数据无法解密';
    case 'too_large':
      return '部分数据过大，无法上传';
    case 'vault_reset':
      return '本机保险箱已重建，请重新登录同步';
    case 'keychain':
      return '无法读取本机保险箱钥匙，稍后将自动重试';
    default: {
      const http = /^http_(\d{3})$/.exec(code);
      return http ? `服务器返回错误（HTTP ${http[1]}）` : `服务器返回错误（${code}）`;
    }
  }
}

/** 给用户看的整句：连不上的写「无法连接同步服务器：原因」，其他写「操作失败：原因」 */
export function messageFor(op: string, err: unknown): string {
  if (err instanceof SyncError) {
    if (FINAL_CODES.has(err.code)) return err.message;
    if (err.code === 'network') return `无法连接同步服务器：${networkReason()}`;
    if (err.code === 'not_evershell' || err.code === 'version' || err.code === 'rate_limited') return `无法连接同步服务器：${reasonFor(err.code)}`;
    return `${op}失败：${reasonFor(err.code)}`;
  }
  // 平台（Rust）报的错，文案本身就是中文
  const detail = err instanceof Error && err.message ? err.message : '未知错误';
  return `${op}失败：${detail}`;
}

/** 转成给用户看的 SyncError，代码不变 */
export function userError(op: string, err: unknown): SyncError {
  if (err instanceof SyncError && FINAL_CODES.has(err.code)) return err;
  return new SyncError(err instanceof SyncError ? err.code : 'platform', messageFor(op, err));
}

function networkReason(): string {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return '网络未连接';
  return '网络错误或服务器无响应';
}

/** 状态归类：连不上、额度用完 → 离线；令牌没了 → 需重新登录；其他 → 同步失败 */
export function classify(err: unknown): 'offline' | 'relogin' | 'error' {
  if (err instanceof SyncError) {
    if (err.code === 'network' || err.code === 'rate_limited') return 'offline';
    // 保险箱重建过：也要重新登录（重新登录时换回云端的钥匙、把机密拉回来）
    if (err.code === 'unauthorized' || err.code === 'vault_reset') return 'relogin';
  }
  return 'error';
}

/** 状态栏明细用的原因 */
export function statusReason(err: unknown): string {
  if (err instanceof SyncError) return FINAL_CODES.has(err.code) ? err.message : reasonFor(err.code);
  return err instanceof Error && err.message ? err.message : '未知错误';
}
