// 同步服务的接口测试：node:sqlite 内存库 + 直接调 Hono 的 app.request，不起端口、不联网。
// D1 和 node:sqlite 共用 store-sql.ts 里的同一套 SQL，这里测到的就是 D1 上跑的语句。

import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, readConfig, type Config, type Resolved } from '../src/app.ts';
import type { Store } from '../src/store.ts';
import { sqliteStore } from '../src/store-sqlite.ts';

const PEPPER = 'test-pepper-0123456789abcdef-0123456789';
const MIN = 60_000;
const START = Date.UTC(2026, 9, 28, 12, 0, 0);

type Body = Record<string, unknown> | unknown[] | string;

function setup(over: Partial<Config> & { pullMaxBytes?: number } = {}) {
  let clock = START;
  const raw = new DatabaseSync(':memory:');
  const { store } = sqliteStore(raw);
  const { pullMaxBytes, ...rest } = over;
  const config: Config = { pepper: PEPPER, inviteCode: '', quotaBytes: 50 * 1024 * 1024, ...rest };
  const app = createApp(() => ({ ok: true, deps: { store, config, now: () => clock, pullMaxBytes } }));

  async function call(method: string, path: string, opts: { body?: Body; token?: string; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const body = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
    const res = await app.request(path, { method, headers, body });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: (text ? JSON.parse(text) : null) as any };
  }

  async function register(account: string, dev = 1, extra: Record<string, unknown> = {}) {
    const res = await call('POST', '/v1/register', { body: registration(account, dev, extra) });
    expect(res.status, JSON.stringify(res.json)).toBe(201);
    return res.json.token as string;
  }

  async function login(account: string, dev = 2, key = authKey(1)) {
    return call('POST', '/v1/login', { body: { account, authKey: key, device: device(dev) } });
  }

  const push = (token: string, records: unknown[]) => call('POST', '/v1/records', { token, body: { records } });
  const pull = (token: string, query = '') => call('GET', `/v1/records${query}`, { token });

  return {
    app,
    raw,
    config,
    call,
    register,
    login,
    push,
    pull,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

// ---- 测试数据 ----

function b64(bytes: number, seed = 1): string {
  let s = '';
  for (let i = 0; i < bytes; i++) s += String.fromCharCode((i * 31 + seed * 7) & 0xff);
  return btoa(s);
}
const authKey = (seed: number) => b64(32, seed);
const salt = (seed: number) => b64(16, seed);
const KDF = { alg: 'argon2id', mKib: 65536, t: 3, p: 1 };
const device = (n: number) => ({ id: n.toString(16).padStart(16, '0'), name: `设备 ${n}`, platform: 'macos' });
const registration = (account: string, dev = 1, extra: Record<string, unknown> = {}) => ({
  account,
  authKey: authKey(1),
  salt: salt(1),
  kdf: KDF,
  wrappedKey: b64(72, 9),
  device: device(dev),
  ...extra,
});
const DEV_A = '3f9a1c2b7d4e5f60';
const hlc = (ms: number, c = 0, dev = DEV_A) => `${String(ms).padStart(15, '0')}-${c.toString(16).padStart(4, '0')}-${dev}`;
/** 长度为 n（4 的倍数）的合法 base64 */
const data = (n: number, ch = 'A') => ch.repeat(n);
const rec = (id: string, ms: number, extra: Record<string, unknown> = {}) => ({
  collection: 'server',
  id,
  hlc: hlc(ms),
  deleted: false,
  data: data(8),
  ...extra,
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- 配置 ----

describe('配置', () => {
  it('PEPPER 必填，且不能太短', () => {
    expect(readConfig({})).toEqual({ ok: false, message: '同步服务配置不完整：未设置 PEPPER' });
    expect(readConfig({ PEPPER: '' }).ok).toBe(false);
    const short = readConfig({ PEPPER: 'dev' });
    expect(short.ok).toBe(false);
    expect(!short.ok && short.message).toContain('32 字节');
  });

  it('INVITE_CODE 和 QUOTA_MB', () => {
    const base = readConfig({ PEPPER });
    expect(base).toEqual({ ok: true, config: { pepper: PEPPER, inviteCode: undefined, quotaBytes: 50 * 1024 * 1024 } });
    const open = readConfig({ PEPPER, INVITE_CODE: '' });
    expect(open.ok && open.config.inviteCode).toBe('');
    const quota = readConfig({ PEPPER, QUOTA_MB: '10' });
    expect(quota.ok && quota.config.quotaBytes).toBe(10 * 1024 * 1024);
    expect(readConfig({ PEPPER, QUOTA_MB: 'abc' }).ok).toBe(false);
    expect(readConfig({ PEPPER, QUOTA_MB: '0' }).ok).toBe(false);
  });

  it('配置不全时每个请求都回 500 并写明原因（Workers 版的行为）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApp(() => readConfig({}) as Resolved);
    const res = await app.request('/v1/info');
    expect(res.status).toBe(500);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toEqual({ error: 'misconfigured', message: '同步服务配置不完整：未设置 PEPPER' });
    expect(spy).toHaveBeenCalled();
  });

  it('schema.sql 和 D1 的第一个迁移建的表一致', () => {
    const strip = (s: string) =>
      s
        .split('\n')
        .filter((l) => !l.startsWith('--'))
        .join('\n')
        .trim();
    const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
    const migration = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8');
    expect(strip(migration)).toBe(strip(schema));
  });
});

// ---- 注册、登录 ----

describe('注册', () => {
  it('GET /info 报告注册方式', async () => {
    for (const [inviteCode, registration] of [
      [undefined, 'closed'],
      ['', 'open'],
      ['secret-code', 'invite'],
    ] as const) {
      const t = setup({ inviteCode });
      const res = await t.call('GET', '/v1/info');
      expect(res.json).toEqual({ service: 'evershell-sync', version: 1, registration });
    }
  });

  it('开放注册：返回令牌，账号名去空白转小写，重名报 account_exists', async () => {
    const t = setup();
    const res = await t.call('POST', '/v1/register', { body: registration('  Ops ') });
    expect(res.status).toBe(201);
    expect(res.json.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const me = await t.call('GET', '/v1/account', { token: res.json.token });
    expect(me.json.account).toBe('ops');

    const dup = await t.call('POST', '/v1/register', { body: registration('OPS', 2) });
    expect(dup.status).toBe(409);
    expect(dup.json).toEqual({ error: 'account_exists', message: '该账号已存在' });
  });

  it('关闭注册：registration_closed', async () => {
    const t = setup({ inviteCode: undefined });
    const res = await t.call('POST', '/v1/register', { body: registration('ops') });
    expect(res.status).toBe(403);
    expect(res.json).toEqual({ error: 'registration_closed', message: '该服务器未开放注册' });
  });

  it('要邀请码：不填、填错报 bad_invite，填对才能注册；邀请码先于账号是否存在检查', async () => {
    const t = setup({ inviteCode: 'secret-code' });
    for (const invite of [undefined, '', 'secret-cod', 'secret-code ', 123]) {
      const res = await t.call('POST', '/v1/register', { body: registration('ops', 1, { invite }) });
      expect(res.status).toBe(403);
      expect(res.json).toEqual({ error: 'bad_invite', message: '邀请码不正确' });
    }
    await t.register('ops', 1, { invite: 'secret-code' });
    const again = await t.call('POST', '/v1/register', { body: registration('ops', 2, { invite: 'wrong' }) });
    expect(again.json.error).toBe('bad_invite');
    const dup = await t.call('POST', '/v1/register', { body: registration('ops', 2, { invite: 'secret-code' }) });
    expect(dup.json.error).toBe('account_exists');
  });

  it('库里不存原样的登录凭据和令牌', async () => {
    const t = setup();
    const token = await t.register('ops');
    const dump = JSON.stringify([
      t.raw.prepare('SELECT * FROM accounts').all(),
      t.raw.prepare('SELECT * FROM sessions').all(),
    ]);
    expect(dump).not.toContain(authKey(1));
    expect(dump).not.toContain(token);
    const [acc] = t.raw.prepare('SELECT verifier FROM accounts').all() as { verifier: string }[];
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(authKey(1))));
    expect(acc.verifier).toBe(Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join(''));
  });
});

describe('prelogin', () => {
  it('已有账号返回注册时的盐和参数', async () => {
    const t = setup();
    const kdf = { alg: 'argon2id', mKib: 32768, t: 4, p: 2, extra: 'dropped' };
    await t.register('ops', 1, { salt: salt(5), kdf });
    const res = await t.call('POST', '/v1/prelogin', { body: { account: ' OPS ' } });
    expect(res.json).toEqual({ salt: salt(5), kdf: { alg: 'argon2id', mKib: 32768, t: 4, p: 2 } });
  });

  it('不存在的账号返回稳定的假盐：HMAC(PEPPER, "salt:" + 账号) 前 16 字节，参数用默认值', async () => {
    const t = setup();
    const a = await t.call('POST', '/v1/prelogin', { body: { account: 'ghost' } });
    const b = await t.call('POST', '/v1/prelogin', { body: { account: '  GHOST ' } });
    const c = await t.call('POST', '/v1/prelogin', { body: { account: 'ghost2' } });
    expect(a.status).toBe(200);
    expect(a.json).toEqual(b.json);
    expect(a.json.salt).not.toBe(c.json.salt);
    expect(a.json.kdf).toEqual(KDF);
    // 和真实的盐长得一样：16 字节的标准 base64
    expect(a.json.salt).toMatch(/^[A-Za-z0-9+/]{22}==$/);

    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('salt:ghost')));
    expect(a.json.salt).toBe(btoa(String.fromCharCode(...mac.slice(0, 16))));

    // 换了 PEPPER 假盐也跟着变，别的部署算不出来
    const other = setup({ pepper: `${PEPPER}-other` });
    const d = await other.call('POST', '/v1/prelogin', { body: { account: 'ghost' } });
    expect(d.json.salt).not.toBe(a.json.salt);
  });
});

describe('登录', () => {
  it('凭据正确返回令牌和包裹好的钥匙；错了或账号不存在都是 bad_credentials', async () => {
    const t = setup();
    await t.register('ops');
    const ok = await t.login(' Ops ');
    expect(ok.status).toBe(200);
    expect(ok.json.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ok.json.wrappedKey).toBe(b64(72, 9));

    const wrong = await t.login('ops', 2, authKey(2));
    expect(wrong.status).toBe(401);
    expect(wrong.json).toEqual({ error: 'bad_credentials', message: '账号或同步密码不正确' });
    const ghost = await t.login('ghost');
    expect(ghost.status).toBe(401);
    expect(ghost.json.error).toBe('bad_credentials');
  });

  it('同一账号 15 分钟内失败 10 次后拒绝登录，凭据对了也不行；过了 15 分钟恢复', async () => {
    const t = setup();
    await t.register('ops');
    for (let i = 0; i < 10; i++) {
      expect((await t.login('ops', 2, authKey(2))).status).toBe(401);
      t.advance(1000);
    }
    const blocked = await t.login('OPS');
    expect(blocked.status).toBe(429);
    expect(blocked.json).toEqual({ error: 'too_many_attempts', message: '登录失败次数过多，请 15 分钟后重试' });
    // 别的账号不受影响
    await t.register('dev', 5);
    expect((await t.login('dev', 6)).status).toBe(200);

    t.advance(15 * MIN - 10_000);
    expect((await t.login('ops')).status).toBe(200);
  });

  it('不存在的账号也限流；登录成功后清零', async () => {
    const t = setup();
    for (let i = 0; i < 10; i++) await t.login('ghost');
    expect((await t.login('ghost')).status).toBe(429);

    await t.register('ops');
    for (let i = 0; i < 9; i++) await t.login('ops', 2, authKey(2));
    expect((await t.login('ops')).status).toBe(200);
    for (let i = 0; i < 10; i++) expect((await t.login('ops', 2, authKey(2))).status).toBe(401);
    expect((await t.login('ops')).status).toBe(429);
  });

  it('同一台设备再次登录顶掉旧令牌，设备列表里只有一条', async () => {
    const t = setup();
    const first = await t.register('ops', 1);
    const second = (await t.login('ops', 1)).json.token as string;
    expect((await t.call('GET', '/v1/account', { token: first })).status).toBe(401);
    const me = await t.call('GET', '/v1/account', { token: second });
    expect(me.json.devices).toHaveLength(1);
  });
});

// ---- 令牌和设备 ----

describe('令牌', () => {
  it('没有、格式不对、不认识的令牌都回 unauthorized', async () => {
    const t = setup();
    const cases: Record<string, string>[] = [
      {},
      { authorization: 'Bearer abc' },
      { authorization: 'Basic eDp5' },
      { authorization: `Bearer ${'A'.repeat(43)}` },
    ];
    for (const headers of cases) {
      const res = await t.call('GET', '/v1/account', { headers });
      expect(res.status).toBe(401);
      expect(res.json).toEqual({ error: 'unauthorized', message: '登录已失效，请重新登录' });
    }
  });

  it('退出登录吊销当前令牌', async () => {
    const t = setup();
    const token = await t.register('ops');
    const other = (await t.login('ops', 2)).json.token as string;
    expect((await t.call('POST', '/v1/logout', { token })).status).toBe(204);
    expect((await t.call('GET', '/v1/account', { token })).status).toBe(401);
    expect((await t.call('POST', '/v1/logout', { token })).status).toBe(401);
    expect((await t.call('GET', '/v1/account', { token: other })).status).toBe(200);
  });

  it('移除设备吊销那台设备的令牌；不能移除本机', async () => {
    const t = setup();
    const mine = await t.register('ops', 1);
    const theirs = (await t.login('ops', 2)).json.token as string;
    const self = await t.call('DELETE', `/v1/devices/${device(1).id}`, { token: mine });
    expect(self.status).toBe(400);
    expect(self.json.error).toBe('invalid');
    expect((await t.call('DELETE', '/v1/devices/not-a-device', { token: mine })).status).toBe(400);

    expect((await t.call('DELETE', `/v1/devices/${device(2).id}`, { token: mine })).status).toBe(204);
    expect((await t.call('GET', '/v1/account', { token: theirs })).status).toBe(401);
    const me = await t.call('GET', '/v1/account', { token: mine });
    expect(me.json.devices.map((d: { id: string }) => d.id)).toEqual([device(1).id]);
    // 已经不在的设备再删一次也是 204
    expect((await t.call('DELETE', `/v1/devices/${device(2).id}`, { token: mine })).status).toBe(204);
  });

  it('改密码：换掉凭据、盐和钥匙，其他令牌失效，当前令牌还能用', async () => {
    const t = setup();
    const a = await t.register('ops', 1);
    const b = (await t.login('ops', 2)).json.token as string;
    const c = (await t.login('ops', 3)).json.token as string;
    const kdf = { alg: 'argon2id', mKib: 131072, t: 2, p: 1 };
    const res = await t.call('POST', '/v1/password', {
      token: a,
      body: { authKey: authKey(7), salt: salt(7), kdf, wrappedKey: b64(72, 7) },
    });
    expect(res.status).toBe(204);
    expect((await t.call('GET', '/v1/account', { token: a })).status).toBe(200);
    expect((await t.call('GET', '/v1/account', { token: b })).status).toBe(401);
    expect((await t.call('GET', '/v1/account', { token: c })).status).toBe(401);

    expect((await t.login('ops', 2)).status).toBe(401);
    const fresh = await t.login('ops', 2, authKey(7));
    expect(fresh.status).toBe(200);
    expect(fresh.json.wrappedKey).toBe(b64(72, 7));
    const pre = await t.call('POST', '/v1/prelogin', { body: { account: 'ops' } });
    expect(pre.json).toEqual({ salt: salt(7), kdf });

    const bad = await t.call('POST', '/v1/password', { token: a, body: { authKey: authKey(8), salt: 'x', kdf, wrappedKey: b64(72, 8) } });
    expect(bad.status).toBe(400);
  });
});

describe('账号和设备', () => {
  it('GET /account 返回用量、额度和设备', async () => {
    const t = setup({ quotaBytes: 1234567 });
    const a = await t.register('ops', 1);
    t.advance(1000);
    await t.login('ops', 2);
    await t.push(a, [rec('x', START, { data: data(12) }), rec('y', START, { data: data(20) })]);
    const me = await t.call('GET', '/v1/account', { token: a });
    expect(me.json).toEqual({
      account: 'ops',
      usage: { bytes: 32, records: 2 },
      quota: { bytes: 1234567 },
      devices: [
        { id: device(2).id, name: '设备 2', platform: 'macos', lastSeenAt: START + 1000, current: false },
        { id: device(1).id, name: '设备 1', platform: 'macos', lastSeenAt: START, current: true },
      ],
    });
  });

  it('PATCH /device 改本机名称', async () => {
    const t = setup();
    const a = await t.register('ops', 1);
    expect((await t.call('PATCH', '/v1/device', { token: a, body: { name: '  办公室 iMac ' } })).status).toBe(204);
    const me = await t.call('GET', '/v1/account', { token: a });
    expect(me.json.devices[0].name).toBe('办公室 iMac');
    for (const name of ['', '   ', 'x'.repeat(65), 'a\u0007b', 42]) {
      expect((await t.call('PATCH', '/v1/device', { token: a, body: { name } })).status).toBe(400);
    }
  });

  it('最后在线时间超过 5 分钟才更新', async () => {
    const t = setup();
    const a = await t.register('ops', 1);
    const seen = async () => (await t.call('GET', '/v1/account', { token: a })).json.devices[0].lastSeenAt;
    t.advance(4 * MIN);
    expect(await seen()).toBe(START);
    t.advance(MIN);
    expect(await seen()).toBe(START);
    t.advance(1);
    expect(await seen()).toBe(START + 5 * MIN + 1);
  });
});

// ---- 推送和拉取 ----

describe('推送', () => {
  it('后写的赢：旧的、一样的时间戳回 stale 并带上服务器的时间戳', async () => {
    const t = setup();
    const a = await t.register('ops');
    const first = await t.push(a, [rec('s1', 1000, { data: data(8, 'B') })]);
    expect(first.json).toEqual({ seq: 1, results: [{ status: 'ok' }] });

    const older = await t.push(a, [rec('s1', 900)]);
    expect(older.json).toEqual({ seq: 2, results: [{ status: 'stale', hlc: hlc(1000) }] });
    const same = await t.push(a, [rec('s1', 1000)]);
    expect(same.json.results).toEqual([{ status: 'stale', hlc: hlc(1000) }]);

    // 毫秒、计数都一样时按设备 id 决胜
    const tie = await t.push(a, [rec('s1', 1000, { hlc: hlc(1000, 0, 'ffffffffffffffff'), data: data(8, 'C') })]);
    expect(tie.json.results).toEqual([{ status: 'ok' }]);

    const tomb = await t.push(a, [rec('s1', 2000, { deleted: true, data: data(4, 'D') })]);
    expect(tomb.json.results).toEqual([{ status: 'ok' }]);

    const got = await t.pull(a);
    expect(got.json).toEqual({
      records: [{ collection: 'server', id: 's1', hlc: hlc(2000), deleted: true, data: 'DDDD', seq: tomb.json.seq }],
      seq: tomb.json.seq,
      more: false,
    });
  });

  it('一批里有的写进去有的 stale，结果按顺序对应', async () => {
    const t = setup();
    const a = await t.register('ops');
    await t.push(a, [rec('a', 500), rec('b', 500)]);
    const res = await t.push(a, [rec('a', 400), rec('c', 400), rec('b', 600), { ...rec('a', 1), collection: 'snippet' }]);
    expect(res.json).toEqual({
      seq: 6,
      results: [{ status: 'stale', hlc: hlc(500) }, { status: 'ok' }, { status: 'ok' }, { status: 'ok' }],
    });
    const got = await t.pull(a);
    expect(got.json.records.map((r: { collection: string; id: string; seq: number }) => `${r.collection}/${r.id}@${r.seq}`)).toEqual([
      'server/a@1',
      'server/c@4',
      'server/b@5',
      'snippet/a@6',
    ]);
  });

  it('空推送返回当前 seq', async () => {
    const t = setup();
    const a = await t.register('ops');
    await t.push(a, [rec('a', 1)]);
    expect((await t.push(a, [])).json).toEqual({ seq: 1, results: [] });
  });

  it('时间戳比服务器快 10 分钟以上整批拒收', async () => {
    const t = setup();
    const a = await t.register('ops');
    const res = await t.push(a, [rec('a', START), rec('b', START + 10 * MIN + 1)]);
    expect(res.status).toBe(400);
    expect(res.json).toEqual({ error: 'clock_skew', message: '设备时间与服务器相差过大，请校准系统时间' });
    expect((await t.pull(a)).json.records).toEqual([]);
    expect((await t.push(a, [rec('b', START + 10 * MIN)])).status).toBe(200);
  });

  it('空间限制：超额拒收整批；改写同样大小、改小、删除照常；拒收的不占空间', async () => {
    const t = setup({ quotaBytes: 1000 });
    const a = await t.register('ops');
    const usage = async () => (await t.call('GET', '/v1/account', { token: a })).json.usage;

    expect((await t.push(a, [rec('a', 1, { data: data(600) })])).status).toBe(200);
    const over = await t.push(a, [rec('b', 1, { data: data(100) }), rec('c', 1, { data: data(400) })]);
    expect(over.status).toBe(413);
    expect(over.json).toEqual({ error: 'quota_exceeded', message: '云端空间已用完' });
    expect(await usage()).toEqual({ bytes: 600, records: 1 });

    expect((await t.push(a, [rec('a', 2, { data: data(600) })])).status).toBe(200);
    expect((await t.push(a, [rec('a', 3, { data: data(1000) })])).status).toBe(200);
    expect(await usage()).toEqual({ bytes: 1000, records: 1 });
    expect((await t.push(a, [rec('b', 1, { data: data(4) })])).status).toBe(413);
    // 旧版本不会写进去，也就不占空间
    expect((await t.push(a, [rec('a', 1, { data: data(4000) })])).json.results).toEqual([{ status: 'stale', hlc: hlc(3) }]);

    // 额度调小以后已经超了，改小、删除仍然可以，变大不行
    t.config.quotaBytes = 500;
    expect((await t.push(a, [rec('a', 4, { data: data(800) })])).status).toBe(200);
    expect((await t.push(a, [rec('n', 4, { data: data(4) })])).status).toBe(413);
    expect((await t.push(a, [rec('a', 5, { deleted: true, data: data(40) })])).status).toBe(200);
    expect(await usage()).toEqual({ bytes: 40, records: 1 });
  });

  it('history 只留最新的 1000 条，空间跟着减', async () => {
    const t = setup();
    const a = await t.register('ops');
    const hist = (i: number) => ({
      collection: 'history',
      id: `h${String(i).padStart(4, '0')}`,
      hlc: hlc(START - 100_000 + i),
      deleted: false,
      data: data(8),
    });
    const all = Array.from({ length: 1005 }, (_, i) => hist(i));
    await t.push(a, [rec('keep', 1, { data: data(16) }), ...all.slice(0, 499)]);
    await t.push(a, all.slice(499, 999));
    const last = await t.push(a, all.slice(999));
    expect(last.json.results).toEqual(Array(6).fill({ status: 'ok' }));

    const me = await t.call('GET', '/v1/account', { token: a });
    expect(me.json.usage).toEqual({ records: 1001, bytes: 16 + 1000 * 8 });
    const page1 = await t.pull(a, '?limit=1000');
    const page2 = await t.pull(a, `?since=${page1.json.seq}&limit=1000`);
    expect(page2.json.more).toBe(false);
    const ids = page1.json.records.concat(page2.json.records);
    expect(ids).toHaveLength(1001);
    const historyIds = new Set(ids.filter((r: { collection: string }) => r.collection === 'history').map((r: { id: string }) => r.id));
    expect(historyIds.size).toBe(1000);
    for (let i = 0; i < 5; i++) expect(historyIds.has(hist(i).id)).toBe(false);
    expect(historyIds.has(hist(5).id)).toBe(true);
    expect(ids.some((r: { id: string }) => r.id === 'keep')).toBe(true);

    // 比现有 1000 条都旧的一条：写进去马上被挤掉，仍算成功
    const old = await t.push(a, [hist(-1)]);
    expect(old.json.results).toEqual([{ status: 'ok' }]);
    expect((await t.call('GET', '/v1/account', { token: a })).json.usage).toEqual({ records: 1001, bytes: 16 + 1000 * 8 });
  });
});

describe('拉取', () => {
  it('按 seq 分页：since、limit、more；被改写的记录挪到后面', async () => {
    const t = setup();
    const a = await t.register('ops');
    await t.push(a, Array.from({ length: 25 }, (_, i) => rec(`r${String(i).padStart(2, '0')}`, 100 + i)));

    const p1 = await t.pull(a, '?limit=10');
    expect(p1.json.records.map((r: { seq: number }) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(p1.json).toMatchObject({ seq: 10, more: true });
    const p2 = await t.pull(a, '?since=10&limit=10');
    expect(p2.json.records[0]).toEqual({ collection: 'server', id: 'r10', hlc: hlc(110), deleted: false, data: data(8), seq: 11 });
    expect(p2.json).toMatchObject({ seq: 20, more: true });
    const p3 = await t.pull(a, '?since=20&limit=10');
    expect(p3.json.records).toHaveLength(5);
    expect(p3.json).toMatchObject({ seq: 25, more: false });
    expect((await t.pull(a, '?since=25')).json).toEqual({ records: [], seq: 25, more: false });

    await t.push(a, [rec('r03', 999)]);
    const p4 = await t.pull(a, '?since=25');
    expect(p4.json.records.map((r: { id: string; seq: number }) => `${r.id}@${r.seq}`)).toEqual(['r03@26']);
    // r03 原来的 seq 4 空出来了，从头拉不会再出现两次
    const full = await t.pull(a);
    expect(full.json.records).toHaveLength(25);
    expect(full.json.seq).toBe(26);
  });

  it('limit 默认 500、最多 1000', async () => {
    const t = setup();
    const a = await t.register('ops');
    for (let k = 0; k < 3; k++) {
      await t.push(a, Array.from({ length: 400 }, (_, i) => rec(`r${k}-${i}`, 100 + i)));
    }
    const def = await t.pull(a);
    expect(def.json.records).toHaveLength(500);
    expect(def.json.more).toBe(true);
    const max = await t.pull(a, '?limit=5000');
    expect(max.json.records).toHaveLength(1000);
    expect(max.json).toMatchObject({ seq: 1000, more: true });
  });

  it('一页的数据量超过上限时提前截断，一条很大的记录也能单独取到', async () => {
    const t = setup({ pullMaxBytes: 100 });
    const a = await t.register('ops');
    await t.push(a, [rec('a', 1, { data: data(40) }), rec('b', 1, { data: data(40) }), rec('c', 1, { data: data(40) })]);
    await t.push(a, [rec('big', 1, { data: data(200) }), rec('d', 1, { data: data(4) })]);

    const p1 = await t.pull(a);
    expect(p1.json.records.map((r: { id: string }) => r.id)).toEqual(['a', 'b']);
    expect(p1.json).toMatchObject({ seq: 2, more: true });
    const p2 = await t.pull(a, '?since=2');
    expect(p2.json.records.map((r: { id: string }) => r.id)).toEqual(['c']);
    expect(p2.json).toMatchObject({ seq: 3, more: true });
    const p3 = await t.pull(a, '?since=3');
    expect(p3.json.records.map((r: { id: string }) => r.id)).toEqual(['big']);
    expect(p3.json).toMatchObject({ seq: 4, more: true });
    const p4 = await t.pull(a, '?since=4');
    expect(p4.json).toMatchObject({ seq: 5, more: false });
    expect(p4.json.records.map((r: { id: string }) => r.id)).toEqual(['d']);
  });

  it('参数不对回 invalid', async () => {
    const t = setup();
    const a = await t.register('ops');
    for (const q of ['?limit=0', '?limit=abc', '?since=-1', '?since=1.5', '?limit=', '?since=1e3']) {
      const res = await t.pull(a, q);
      expect(res.status, q).toBe(400);
      expect(res.json.error).toBe('invalid');
    }
  });
});

describe('账号之间的隔离', () => {
  it('记录、seq、用量、设备互不影响', async () => {
    const t = setup();
    const a = await t.register('alice', 1);
    const b = await t.register('bob', 2);
    await t.push(a, [rec('x', 2000, { data: 'AAAA' }), rec('y', 2000)]);
    const pushed = await t.push(b, [rec('x', 1000, { data: 'BBBB' })]);
    expect(pushed.json).toEqual({ seq: 1, results: [{ status: 'ok' }] });

    expect((await t.pull(a)).json.records.map((r: { data: string }) => r.data)).toEqual(['AAAA', data(8)]);
    expect((await t.pull(b)).json.records).toEqual([
      { collection: 'server', id: 'x', hlc: hlc(1000), deleted: false, data: 'BBBB', seq: 1 },
    ]);
    expect((await t.call('GET', '/v1/account', { token: b })).json.usage).toEqual({ bytes: 4, records: 1 });

    // bob 删不掉 alice 的设备
    expect((await t.call('DELETE', `/v1/devices/${device(1).id}`, { token: b })).status).toBe(204);
    expect((await t.call('GET', '/v1/account', { token: a })).status).toBe(200);
    const bobDevices = (await t.call('GET', '/v1/account', { token: b })).json.devices;
    expect(bobDevices.map((d: { id: string }) => d.id)).toEqual([device(2).id]);
  });
});

// ---- 输入校验、CORS、出错 ----

describe('输入校验', () => {
  it('注册表单的各个字段', async () => {
    const t = setup();
    const bad: Record<string, unknown>[] = [
      { account: '' },
      { account: '   ' },
      { account: 'x'.repeat(65) },
      { account: 'a\u0000b' },
      { account: 42 },
      { authKey: 'short' },
      { authKey: b64(32).replace('=', '') },
      { authKey: b64(33) },
      { salt: 'abc' },
      { salt: b64(17) },
      { kdf: { ...KDF, alg: 'argon2i' } },
      { kdf: { ...KDF, mKib: 1024 } },
      { kdf: { ...KDF, mKib: 2 * 1024 * 1024 } },
      { kdf: { ...KDF, t: 0 } },
      { kdf: { ...KDF, t: 11 } },
      { kdf: { ...KDF, p: 5 } },
      { kdf: { ...KDF, mKib: 65536.5 } },
      { kdf: '{"alg":"argon2id"}' },
      { wrappedKey: 'not base64!' },
      { wrappedKey: '' },
      { wrappedKey: 'A'.repeat(1028) },
      { device: undefined },
      { device: { ...device(1), id: 'XYZ' } },
      { device: { ...device(1), id: '3F9A1C2B7D4E5F60' } },
      { device: { ...device(1), name: '' } },
      { device: { ...device(1), platform: 'mac os' } },
    ];
    for (const extra of bad) {
      const res = await t.call('POST', '/v1/register', { body: registration('ops', 1, extra) });
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(res.json.error).toBe('invalid');
      expect(typeof res.json.message).toBe('string');
    }
    // 账号名最长 64 个字符，按字符算不按字节
    await t.register('运维'.repeat(32));
  });

  it('请求体不是 JSON 对象', async () => {
    const t = setup();
    for (const body of ['{oops', '[]', '"ops"', 'null', '']) {
      const res = await t.call('POST', '/v1/login', { body, headers: { 'content-type': 'application/json' } });
      expect(res.status, body).toBe(400);
      expect(res.json.error).toBe('invalid');
      expect(res.json.message).not.toContain('oops');
    }
  });

  it('推送的每条记录', async () => {
    const t = setup();
    const a = await t.register('ops');
    const bad: unknown[] = [
      null,
      'record',
      { ...rec('a', 1), collection: 'Server' },
      { ...rec('a', 1), collection: '1server' },
      { ...rec('a', 1), collection: 'known_host' },
      { ...rec('a', 1), collection: 'a'.repeat(33) },
      { ...rec('a', 1), id: '' },
      { ...rec('a', 1), id: 'a b' },
      { ...rec('a', 1), id: 'é' },
      { ...rec('a', 1), id: 'x'.repeat(201) },
      { ...rec('a', 1), id: 7 },
      { ...rec('a', 1), hlc: '1-2-3' },
      { ...rec('a', 1), hlc: hlc(1).toUpperCase() },
      { ...rec('a', 1), hlc: `${hlc(1)}0` },
      { ...rec('a', 1), deleted: 'false' },
      { ...rec('a', 1), deleted: undefined },
      { ...rec('a', 1), data: '' },
      { ...rec('a', 1), data: 'abc' },
      { ...rec('a', 1), data: 'ab=c' },
      { ...rec('a', 1), data: 'A'.repeat(64 * 1024 + 4) },
      { ...rec('a', 1), data: null },
    ];
    for (const r of bad) {
      const res = await t.push(a, [r]);
      expect(res.status, JSON.stringify(r)?.slice(0, 80)).toBe(400);
      expect(res.json.error).toBe('invalid');
    }
    // 边界上的合法值
    const edge = await t.push(a, [
      { ...rec('a', 1), collection: `k${'-'.repeat(31)}`, id: '~'.repeat(200), data: 'A'.repeat(64 * 1024) },
      { ...rec('!', 1), collection: 'known-host' },
    ]);
    expect(edge.status).toBe(200);

    expect((await t.call('POST', '/v1/records', { token: a, body: { records: 'x' } })).status).toBe(400);
    expect((await t.call('POST', '/v1/records', { token: a, body: {} })).status).toBe(400);
    const tooMany = await t.push(a, Array.from({ length: 501 }, (_, i) => rec(`m${i}`, 1)));
    expect(tooMany.status).toBe(400);
    expect(tooMany.json.message).toContain('500');
    const dup = await t.push(a, [rec('d', 1), rec('d', 2)]);
    expect(dup.status).toBe(400);
    expect((await t.pull(a)).json.records).toHaveLength(2);
  });

  it('请求体超过 4 MiB 回 413', async () => {
    const t = setup();
    const a = await t.register('ops');
    const huge = JSON.stringify({ records: [{ ...rec('a', 1), data: 'A'.repeat(4 * 1024 * 1024) }] });
    const res = await t.call('POST', '/v1/records', { token: a, body: huge });
    expect(res.status).toBe(413);
    expect(res.json.error).toBe('invalid');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('接近 4 MiB 的推送分块写入（D1 每个参数最多 2 MB）', async () => {
    const t = setup();
    const a = await t.register('ops');
    const records = Array.from({ length: 60 }, (_, i) => rec(`big${i}`, 1, { data: 'A'.repeat(64 * 1024) }));
    const res = await t.push(a, records);
    expect(res.status).toBe(200);
    expect(res.json.seq).toBe(60);
    expect(res.json.results.every((r: { status: string }) => r.status === 'ok')).toBe(true);
    const got = await t.pull(a, '?limit=1000');
    const all = [...got.json.records];
    let since = got.json.seq;
    let more = got.json.more;
    while (more) {
      const next = await t.pull(a, `?since=${since}&limit=1000`);
      all.push(...next.json.records);
      since = next.json.seq;
      more = next.json.more;
    }
    expect(all.map((r: { id: string; seq: number }) => `${r.id}@${r.seq}`)).toEqual(records.map((r, i) => `${r.id}@${i + 1}`));
  });
});

describe('CORS', () => {
  it('OPTIONS 预检直接回 204', async () => {
    const t = setup();
    const res = await t.app.request('/v1/records', {
      method: 'OPTIONS',
      headers: { origin: 'tauri://localhost', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toBe('authorization,content-type');
    expect(res.headers.get('access-control-allow-methods')).toContain('PATCH');
    expect(res.headers.get('access-control-allow-methods')).toContain('DELETE');
  });

  it('正常响应和出错响应都带 CORS 头', async () => {
    const t = setup();
    const token = await t.register('ops');
    const cases = [
      await t.call('GET', '/v1/info'),
      await t.call('GET', '/v1/account', { token }),
      await t.call('GET', '/v1/account'),
      await t.call('GET', '/v1/nothing'),
      await t.call('POST', '/v1/login', { body: '{' }),
      await t.call('POST', '/v1/logout', { token }),
    ];
    expect(cases.map((r) => r.status)).toEqual([200, 200, 401, 404, 400, 204]);
    for (const r of cases) expect(r.headers.get('access-control-allow-origin')).toBe('*');
    expect(cases[3].json).toEqual({ error: 'not_found', message: '接口不存在' });
  });
});

describe('内部错误', () => {
  it('回 500，日志里没有请求体和凭据', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const broken = new Proxy({} as Store, {
      get: () => async () => {
        throw new Error('disk I/O error');
      },
    });
    const config: Config = { pepper: PEPPER, inviteCode: '', quotaBytes: 1 };
    const app = createApp(() => ({ ok: true, deps: { store: broken, config } }));
    const res = await app.request('/v1/register', { method: 'POST', body: JSON.stringify(registration('ops')) });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal', message: '同步服务内部错误，请稍后重试' });
    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).toContain('disk I/O error');
    expect(logged).not.toContain(authKey(1));
    expect(logged).not.toContain(b64(72, 9));
  });
});
