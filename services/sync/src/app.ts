// 同步服务的路由，接口定义见 docs/specs/sync.md「接口（v1）」。
// 这里只认 store.ts 的存储接口，Workers（D1）和 Node（node:sqlite）共用这一份。
// 哈希、HMAC、随机数都用 Web Crypto，两个运行时都有，不需要额外的依赖。
//
// 服务器只存密文。它看到的登录凭据是客户端从同步密码派生出来的 256 位随机值，
// 拿它解不开任何数据，所以这里不做慢哈希（Cloudflare 免费版每个请求也只有 10 ms CPU）。

import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import type { DeviceInfo, PushRecord, SessionRow, Store } from './store.ts';

export interface Config {
  pepper: string;
  /** undefined：关闭注册；空串：开放注册；其他：注册要填这个邀请码 */
  inviteCode: string | undefined;
  quotaBytes: number;
}

export interface Deps {
  store: Store;
  config: Config;
  /** 测试里用来拨时间 */
  now?: () => number;
  /** 一次拉取最多返回多少字节的记录数据，测试里调小 */
  pullMaxBytes?: number;
}

export type Resolved = { ok: true; deps: Deps } | { ok: false; message: string };

export interface ConfigVars {
  PEPPER?: string;
  INVITE_CODE?: string;
  QUOTA_MB?: string;
}

const MINUTE = 60_000;
const LAST_SEEN_INTERVAL = 5 * MINUTE;
const LOGIN_WINDOW = 15 * MINUTE;
const LOGIN_MAX_FAILURES = 10;
const CLOCK_SKEW_MAX = 10 * MINUTE;
const MAX_BODY = 4 * 1024 * 1024;
const MAX_RECORDS = 500;
const MAX_DATA = 64 * 1024;
const PULL_DEFAULT = 500;
const PULL_MAX = 1000;
// 单页数据量也设上限：1000 条接近 64 KiB 的记录会把 Workers 的 128 MB 内存撑爆，
// 那样客户端每次拉取都失败、永远卡在同一页
const PULL_MAX_BYTES = 4 * 1024 * 1024;
const DEFAULT_QUOTA_MB = 50;
const MIN_PEPPER_BYTES = 32;

/** 和客户端 crates/vault 的默认值一致；不存在的账号也返回它 */
const DEFAULT_KDF = { alg: 'argon2id', mKib: 64 * 1024, t: 3, p: 1 };

const MSG = {
  unauthorized: '登录已失效，请重新登录',
  badCredentials: '账号或同步密码不正确',
  tooManyAttempts: '登录失败次数过多，请 15 分钟后重试',
  accountExists: '该账号已存在',
  badInvite: '邀请码不正确',
  registrationClosed: '该服务器未开放注册',
  quotaExceeded: '云端空间已用完',
  clockSkew: '设备时间与服务器相差过大，请校准系统时间',
  tooLarge: '请求内容过大：单次最多 4 MB',
  notFound: '接口不存在',
  internal: '同步服务内部错误，请稍后重试',
};

type Status = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500;

class ApiError extends Error {
  readonly status: Status;
  readonly code: string;
  constructor(status: Status, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const fail = (status: Status, code: string, message: string): never => {
  throw new ApiError(status, code, message);
};
const invalid = (message: string): never => fail(400, 'invalid', message);

/** 读部署配置。PEPPER 没有默认值：用默认值等于所有部署共用一个，失去意义 */
export function readConfig(vars: ConfigVars): { ok: true; config: Config } | { ok: false; message: string } {
  const pepper = vars.PEPPER ?? '';
  if (pepper === '') return { ok: false, message: '同步服务配置不完整：未设置 PEPPER' };
  if (new TextEncoder().encode(pepper).length < MIN_PEPPER_BYTES) {
    return { ok: false, message: `同步服务配置错误：PEPPER 长度不能少于 ${MIN_PEPPER_BYTES} 字节` };
  }
  let quotaMb = DEFAULT_QUOTA_MB;
  const rawQuota = vars.QUOTA_MB?.trim();
  if (rawQuota) {
    quotaMb = /^\d{1,7}$/.test(rawQuota) ? Number(rawQuota) : 0;
    if (quotaMb < 1) return { ok: false, message: '同步服务配置错误：QUOTA_MB 必须是正整数' };
  }
  return { ok: true, config: { pepper, inviteCode: vars.INVITE_CODE, quotaBytes: quotaMb * 1024 * 1024 } };
}

type AppEnv = { Bindings: object; Variables: { deps: Deps; session: SessionRow } };

/** resolve 每个请求调一次：Workers 的绑定和机密要到请求里才拿得到 */
export function createApp<E extends object = object>(resolve: (env: E) => Resolved) {
  const app = new Hono<AppEnv>();
  type C = Context<AppEnv>;

  app.use(
    '*',
    cors({
      origin: '*',
      allowHeaders: ['authorization', 'content-type'],
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      // 预检也算 Workers 的请求次数，让浏览器缓存一天
      maxAge: 86400,
    }),
  );

  app.use('*', async (c, next) => {
    const r = resolve(c.env as E);
    if (!r.ok) {
      console.error(`[sync] ${r.message}`);
      return c.json({ error: 'misconfigured', message: r.message }, 500);
    }
    c.set('deps', r.deps);
    await next();
  });

  app.use('/v1/*', bodyLimit({ maxSize: MAX_BODY, onError: (c) => c.json({ error: 'invalid', message: MSG.tooLarge }, 413) }));

  const now = (c: C) => c.var.deps.now?.() ?? Date.now();

  const auth: MiddlewareHandler<AppEnv> = async (c, next) => {
    const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(c.req.header('authorization') ?? '');
    if (!m) return fail(401, 'unauthorized', MSG.unauthorized);
    const { store } = c.var.deps;
    const tokenHash = await sha256Hex(m[1]);
    const session = await store.findSession(tokenHash);
    if (!session) return fail(401, 'unauthorized', MSG.unauthorized);
    // 每个请求都写一次会很快用完 D1 免费版每天的写入额度
    const t = now(c);
    if (t - session.lastSeenAt > LAST_SEEN_INTERVAL) await store.touchSession(tokenHash, t);
    c.set('session', session);
    await next();
  };

  app.get('/v1/info', (c) => {
    const { inviteCode } = c.var.deps.config;
    const registration = inviteCode === undefined ? 'closed' : inviteCode === '' ? 'open' : 'invite';
    return c.json({ service: 'evershell-sync', version: 1, registration });
  });

  app.post('/v1/prelogin', async (c) => {
    const { store, config } = c.var.deps;
    const account = parseAccount((await readJson(c)).account);
    // 账号不存在时给一个由账号算出来的固定假盐，外人分不出账号在不在
    const fake = toBase64((await hmac(config.pepper, `salt:${account}`)).slice(0, 16));
    const found = await store.findAccount(account);
    if (found) return c.json({ salt: found.salt, kdf: JSON.parse(found.kdf) as unknown });
    return c.json({ salt: fake, kdf: DEFAULT_KDF });
  });

  app.post('/v1/register', async (c) => {
    const { store, config } = c.var.deps;
    if (config.inviteCode === undefined) fail(403, 'registration_closed', MSG.registrationClosed);
    const body = await readJson(c);
    const account = parseAccount(body.account);
    const authKey = parseAuthKey(body.authKey);
    const salt = parseSalt(body.salt);
    const kdf = parseKdf(body.kdf);
    const wrappedKey = parseWrappedKey(body.wrappedKey);
    const device = parseDevice(body.device);
    // 先查邀请码再查账号是否存在，没有邀请码的人试探不出哪些账号已注册
    if (config.inviteCode) {
      const invite = typeof body.invite === 'string' ? body.invite : '';
      if (!(await sameSecret(invite, config.inviteCode))) fail(403, 'bad_invite', MSG.badInvite);
    }
    const t = now(c);
    const verifier = toHex(await hmac(config.pepper, authKey));
    const id = await store.createAccount({ name: account, verifier, salt, kdf: JSON.stringify(kdf), wrappedKey, createdAt: t });
    if (id === null) return fail(409, 'account_exists', MSG.accountExists);
    const token = newToken();
    await store.createSession(id, account, await sha256Hex(token), device, t);
    return c.json({ token }, 201);
  });

  app.post('/v1/login', async (c) => {
    const { store, config } = c.var.deps;
    const body = await readJson(c);
    const account = parseAccount(body.account);
    const authKey = parseAuthKey(body.authKey);
    const device = parseDevice(body.device);
    const t = now(c);
    // 账号存不存在都计数，限流本身不泄露账号是否存在
    if ((await store.countLoginFailures(account, t - LOGIN_WINDOW)) >= LOGIN_MAX_FAILURES) {
      fail(429, 'too_many_attempts', MSG.tooManyAttempts);
    }
    const found = await store.findAccount(account);
    const verifier = toHex(await hmac(config.pepper, authKey));
    if (!found || !sameText(verifier, found.verifier)) {
      await store.addLoginFailure(account, t, t - LOGIN_WINDOW);
      return fail(401, 'bad_credentials', MSG.badCredentials);
    }
    const token = newToken();
    await store.createSession(found.id, account, await sha256Hex(token), device, t);
    return c.json({ token, wrappedKey: found.wrappedKey });
  });

  app.post('/v1/logout', auth, async (c) => {
    await c.var.deps.store.deleteSession(c.var.session.tokenHash);
    return c.body(null, 204);
  });

  app.get('/v1/account', auth, async (c) => {
    const { store, config } = c.var.deps;
    const session = c.var.session;
    const [usage, devices] = await Promise.all([store.usage(session.accountId), store.listDevices(session.accountId)]);
    return c.json({
      account: session.account,
      usage,
      quota: { bytes: config.quotaBytes },
      devices: devices.map((d) => ({ ...d, current: d.id === session.deviceId })),
    });
  });

  app.patch('/v1/device', auth, async (c) => {
    const name = parseDeviceName((await readJson(c)).name);
    const session = c.var.session;
    await c.var.deps.store.renameDevice(session.accountId, session.deviceId, name);
    return c.body(null, 204);
  });

  app.delete('/v1/devices/:id', auth, async (c) => {
    const id = c.req.param('id');
    if (!DEVICE_ID.test(id)) invalid('设备标识格式不正确');
    const session = c.var.session;
    if (id === session.deviceId) invalid('无法移除本机，请使用「退出登录」');
    // 设备不存在也回 204：结果一样，都是那台设备不再能同步
    await c.var.deps.store.deleteDeviceSessions(session.accountId, id);
    return c.body(null, 204);
  });

  app.post('/v1/password', auth, async (c) => {
    const { store, config } = c.var.deps;
    const body = await readJson(c);
    const authKey = parseAuthKey(body.authKey);
    const salt = parseSalt(body.salt);
    const kdf = parseKdf(body.kdf);
    const wrappedKey = parseWrappedKey(body.wrappedKey);
    const session = c.var.session;
    const verifier = toHex(await hmac(config.pepper, authKey));
    await store.changePassword(session.accountId, { verifier, salt, kdf: JSON.stringify(kdf), wrappedKey }, session.tokenHash);
    return c.body(null, 204);
  });

  app.post('/v1/records', auth, async (c) => {
    const { store, config } = c.var.deps;
    const raw = (await readJson(c)).records;
    if (!Array.isArray(raw)) return invalid('同步记录格式不正确');
    if (raw.length > MAX_RECORDS) invalid(`单次最多上传 ${MAX_RECORDS} 条记录`);
    const records = raw.map(parseRecord);
    const seen = new Set<string>();
    for (const r of records) {
      const key = `${r.collection}\0${r.id}`;
      if (seen.has(key)) invalid('同一批记录中有重复项');
      seen.add(key);
    }
    // 时间戳跑到服务器前面太多的记录会一直赢过别的设备的正常修改，直接拒收整批
    const latest = now(c) + CLOCK_SKEW_MAX;
    if (records.some((r) => Number(r.hlc.slice(0, 15)) > latest)) fail(400, 'clock_skew', MSG.clockSkew);
    const result = await store.pushRecords(c.var.session.accountId, records, config.quotaBytes);
    if (!result.ok) return fail(413, 'quota_exceeded', MSG.quotaExceeded);
    return c.json({ seq: result.seq, results: result.results });
  });

  app.get('/v1/records', auth, async (c) => {
    const since = parseCount(c.req.query('since'), 0, 15);
    const limit = Math.min(parseCount(c.req.query('limit'), PULL_DEFAULT, 7), PULL_MAX);
    if (limit < 1) invalid('拉取参数格式不正确');
    const { store, pullMaxBytes } = c.var.deps;
    return c.json(await store.pullRecords(c.var.session.accountId, since, limit, pullMaxBytes ?? PULL_MAX_BYTES));
  });

  app.notFound((c) => c.json({ error: 'not_found', message: MSG.notFound }, 404));

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.code, message: err.message }, err.status);
    // 只记错误类型和简短原因：请求体、令牌、记录内容一律不进日志
    const reason = err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : typeof err;
    console.error(`[sync] 内部错误 ${c.req.method} ${c.req.path} ${reason}`);
    return c.json({ error: 'internal', message: MSG.internal }, 500);
  });

  return app;
}

// ---- 输入校验：请求里的一切都当不可信输入 ----

const CONTROL = /\p{Cc}/u;
const DEVICE_ID = /^[0-9a-f]{16}$/;
const HLC = /^\d{15}-[0-9a-f]{4}-[0-9a-f]{16}$/;
// 客户端（crates/vault）统一用带补齐的标准 base64
const AUTH_KEY = /^[A-Za-z0-9+/]{43}=$/;
const SALT = /^[A-Za-z0-9+/]{22}==$/;

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

async function readJson(c: Context): Promise<Json> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    // 解析错误的原文里带着请求体片段，不往外传、也不记日志
    return invalid('请求内容不是有效的 JSON');
  }
  return isObject(body) ? body : invalid('请求内容格式不正确');
}

const isBase64 = (s: string) => s.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(s);

function parseText(v: unknown, what: string): string {
  if (typeof v !== 'string') return invalid(`${what}格式不正确`);
  const s = v.trim();
  const len = [...s].length;
  if (len < 1 || len > 64) invalid(`${what}长度应为 1～64 个字符`);
  if (CONTROL.test(s)) invalid(`${what}不能包含控制字符`);
  return s;
}

/** 和客户端一样去掉首尾空白、转小写，大小写不同的写法算同一个账号 */
const parseAccount = (v: unknown) => parseText(typeof v === 'string' ? v.toLowerCase() : v, '账号');
const parseDeviceName = (v: unknown) => parseText(v, '设备名称');

function parseAuthKey(v: unknown): string {
  return typeof v === 'string' && AUTH_KEY.test(v) ? v : invalid('登录凭据格式不正确');
}

function parseSalt(v: unknown): string {
  return typeof v === 'string' && SALT.test(v) ? v : invalid('密码派生参数格式不正确');
}

function parseWrappedKey(v: unknown): string {
  return typeof v === 'string' && v.length >= 4 && v.length <= 1024 && isBase64(v)
    ? v
    : invalid('保险箱钥匙的密文格式不正确');
}

/** 范围和客户端检查的一致；只存认识的四个字段 */
function parseKdf(v: unknown): typeof DEFAULT_KDF {
  const int = (x: unknown, min: number, max: number) => Number.isInteger(x) && (x as number) >= min && (x as number) <= max;
  if (!isObject(v) || v.alg !== 'argon2id' || !int(v.mKib, 8 * 1024, 1024 * 1024) || !int(v.t, 1, 10) || !int(v.p, 1, 4)) {
    return invalid('密码派生参数格式不正确');
  }
  return { alg: 'argon2id', mKib: v.mKib as number, t: v.t as number, p: v.p as number };
}

function parseDevice(v: unknown): DeviceInfo {
  if (!isObject(v)) return invalid('设备信息格式不正确');
  if (typeof v.id !== 'string' || !DEVICE_ID.test(v.id)) invalid('设备标识格式不正确');
  const name = parseDeviceName(v.name);
  if (typeof v.platform !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(v.platform)) {
    invalid('设备平台格式不正确');
  }
  return { id: v.id as string, name, platform: v.platform as string };
}

function parseRecord(v: unknown): PushRecord {
  if (!isObject(v)) return invalid('同步记录格式不正确');
  const { collection, id, hlc, deleted, data } = v;
  if (typeof collection !== 'string' || !/^[a-z][a-z-]{0,31}$/.test(collection)) invalid('同步记录的集合名称格式不正确');
  if (typeof id !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(id)) invalid('同步记录的 id 格式不正确');
  if (typeof hlc !== 'string' || !HLC.test(hlc)) invalid('同步记录的时间戳格式不正确');
  if (typeof deleted !== 'boolean') invalid('同步记录的删除标记格式不正确');
  if (typeof data !== 'string' || data.length === 0) return invalid('同步记录的数据格式不正确');
  if (data.length > MAX_DATA) invalid('单条记录不能超过 64 KB');
  if (!isBase64(data)) invalid('同步记录的数据格式不正确');
  return { collection: collection as string, id: id as string, hlc: hlc as string, deleted: deleted as boolean, data };
}

function parseCount(raw: string | undefined, fallback: number, maxDigits: number): number {
  if (raw === undefined) return fallback;
  return new RegExp(`^\\d{1,${maxDigits}}$`).test(raw) ? Number(raw) : invalid('拉取参数格式不正确');
}

// ---- Web Crypto 小工具 ----

const enc = new TextEncoder();
const hmacKeys = new Map<string, Promise<CryptoKey>>();

async function hmac(pepper: string, text: string): Promise<Uint8Array> {
  let key = hmacKeys.get(pepper);
  if (!key) {
    key = crypto.subtle.importKey('raw', enc.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    hmacKeys.set(pepper, key);
  }
  return new Uint8Array(await crypto.subtle.sign('HMAC', await key, enc.encode(text)));
}

async function sha256Hex(text: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text))));
}

/** 常数时间比较。crypto.subtle.timingSafeEqual 只有 Workers 有，Node 没有，所以自己写 */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

const sameText = (a: string, b: string) => sameBytes(enc.encode(a), enc.encode(b));

/** 邀请码长度不定，先各自哈希成等长再比，长度不同也不会提前返回 */
async function sameSecret(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([given, expected].map((s) => crypto.subtle.digest('SHA-256', enc.encode(s))));
  return sameBytes(new Uint8Array(a), new Uint8Array(b));
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
