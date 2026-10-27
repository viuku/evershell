import type { KdfParams, RecordAad, SecretStore, SyncPlatform } from '../types';
import { cyrb53 } from '../core/sync/digest';
import { formatHlc } from '../core/sync/hlc';

// 云同步的假实现，给网页版 ?mock 和单元测试用（docs/specs/sync.md「客户端」）。
//
// 假平台不加密，只把内容和附加数据、钥匙编号一起 base64 包一层；解的时候照样核对附加数据和钥匙，
// 附加数据任何一项不同、钥匙不对都解不开，免得假实现掩盖引擎的 bug。
// 假服务器照接口表在内存里实现，作为 fetch 提供；刷新页面数据就没了。
//
// 预览时的约定：服务器地址含 invite → 注册要邀请码 evershell；含 closed → 关闭注册；含 offline → 连不上。
// 每个假服务器都预置一个账号 demo（同步密码 demo1234），里面有几台服务器和快捷命令，用来看「登录并开启同步」的合并结果。

/** 假保险箱存编号的条目；sync. 开头，不参与同步 */
const VAULT_ID_ENTRY = 'sync.vault-id';

const DEFAULT_KDF: KdfParams = { alg: 'argon2id', mKib: 64 * 1024, t: 3, p: 1 };

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function fromBase64(b64: string): string | null {
  try {
    const bin = atob(b64);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

function randomBase64(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return btoa(String.fromCharCode(...buf));
}

function fakeHash(...parts: string[]): string {
  const s = parts.join('\0');
  return cyrb53(s).toString(16).padStart(14, '0') + cyrb53(s, 1).toString(16).padStart(14, '0');
}

function aadString(aad: RecordAad): string {
  return ['evershell/sync/v1/record', aad.account, aad.collection, aad.id, aad.hlc, aad.deleted ? '1' : '0'].join('\0');
}

/** 假“加密”：内容、附加数据、钥匙编号一起包起来 */
export function mockSeal(key: string, aad: RecordAad, plain: string): string {
  return toBase64(JSON.stringify({ v: 'mock-seal', key: fakeHash('key-id', key), aad: aadString(aad), plain }));
}

/** 假“解密”：附加数据或钥匙对不上返回 null */
export function mockOpen(key: string, aad: RecordAad, data: string): string | null {
  const text = fromBase64(data);
  if (text === null) return null;
  try {
    const o = JSON.parse(text) as { v?: string; key?: string; aad?: string; plain?: unknown };
    if (o.v !== 'mock-seal' || o.key !== fakeHash('key-id', key) || o.aad !== aadString(aad) || typeof o.plain !== 'string') return null;
    return o.plain;
  } catch {
    return null;
  }
}

/** 和真平台一样是 32 字节的 base64，真服务端校验这个格式（services/sync/test/client-e2e.test.ts 用假平台连真服务端） */
function fakeKey32(...parts: string[]): string {
  const hex = [0, 1, 2].map((i) => fakeHash(String(i), ...parts)).join('').slice(0, 64);
  let bin = '';
  for (let i = 0; i < 64; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(bin);
}

function deriveRoot(password: string, account: string, salt: string): { authKey: string; kek: string } {
  const root = fakeHash('root', password, account.trim().toLowerCase(), salt);
  return { authKey: fakeKey32('auth', root), kek: fakeHash('kek', root) };
}

function wrapWith(kek: string, key: string): string {
  return toBase64(JSON.stringify({ v: 'mock-wrap', check: fakeHash('wrap', kek), key }));
}

function kdfOk(k: KdfParams): boolean {
  return k.alg === 'argon2id' && k.mKib >= 8 * 1024 && k.mKib <= 1024 * 1024 && k.t >= 1 && k.t <= 10 && k.p >= 1 && k.p <= 4;
}

/** 假平台要能列出保险箱里的条目（真平台在 Rust 里列） */
export interface MockVault extends SecretStore {
  ids(): string[];
}

export function memoryVault(initial: Record<string, string> = {}): MockVault & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    available: true,
    map,
    ids: () => [...map.keys()],
    get: async (id) => map.get(id) ?? null,
    set: async (id, v) => void map.set(id, v),
    remove: async (id) => void map.delete(id),
  };
}

export interface MockSyncPlatform extends SyncPlatform {
  /** 测试用：当前的保险箱钥匙 */
  readonly vaultKey: () => string | null;
  /** 测试用：模拟保险箱重建（条目全没了，连带保险箱编号）；sameKey 为 true 时钥匙串里的钥匙还在、钥匙不变 */
  readonly simulateVaultRebuild: (opts?: { sameKey?: boolean }) => void;
  /** 测试用：模拟旧版本把保险箱整份重写（条目都保留，旧版本不认识的顶层字段丢了）。编号在条目里，所以钥匙校验值不变 */
  readonly simulateOldBuildRewrite: () => Promise<void>;
}

/** 和 Rust 那边一样的检查（apps/desktop/src-tauri/src/sync.rs）：普通记录的加解密不收机密 */
function rejectSecrets(items: { aad: RecordAad }[]): void {
  if (items.some((it) => it.aad.collection === 'secret')) throw new Error('机密记录须经保险箱加解密');
}

/** 机密条目和附加数据里的身份要对得上，免得用别的 id 的附加数据把条目挪走 */
function checkSecretAad(id: string, aad: RecordAad): void {
  if (aad.collection !== 'secret' || aad.id !== id) throw new Error('机密条目和同步记录的标识不匹配');
}

export function createMockSyncPlatform(
  vault: MockVault,
  opts: { fetch?: typeof fetch; deviceName?: string; deriveDelayMs?: number } = {},
): MockSyncPlatform {
  let vaultKey: string | null = null;
  let kek: string | null = null;
  const ensureKey = () => (vaultKey ??= randomBase64(32));
  const syncable = (id: string) => id !== 'known_hosts' && !id.startsWith('sync.');

  return {
    vaultKey: () => vaultKey,
    simulateVaultRebuild: (o) => {
      for (const id of vault.ids()) void vault.remove(id);
      if (!o?.sameKey) vaultKey = randomBase64(32);
    },
    async simulateOldBuildRewrite() {
      const entries: [string, string][] = [];
      for (const id of vault.ids()) {
        const v = await vault.get(id);
        if (v !== null) entries.push([id, v]);
      }
      for (const [id] of entries) await vault.remove(id);
      for (const [id, v] of entries.reverse()) await vault.set(id, v);
    },
    fetch: opts.fetch,
    async deviceName() {
      return opts.deviceName ?? 'MacBook Pro';
    },
    async derive(password, account, salt, kdf) {
      const params = kdf ?? DEFAULT_KDF;
      if (!kdfOk(params)) throw new Error('服务器提供的密钥参数超出允许范围');
      if (opts.deriveDelayMs) await delay(opts.deriveDelayMs);
      const s = salt ?? randomBase64(16);
      const d = deriveRoot(password, account, s);
      kek = d.kek;
      return { salt: s, kdf: params, authKey: d.authKey };
    },
    async wrapKey() {
      if (!kek) throw new Error('请重新输入同步密码');
      return wrapWith(kek, ensureKey());
    },
    async adoptKey(wrapped) {
      if (!kek) throw new Error('请重新输入同步密码');
      const text = fromBase64(wrapped);
      const o = text ? (JSON.parse(text) as { v?: string; check?: string; key?: string }) : null;
      if (!o || o.v !== 'mock-wrap' || o.check !== fakeHash('wrap', kek) || typeof o.key !== 'string') {
        throw new Error('无法解开云端的保险箱钥匙');
      }
      kek = null;
      // 假保险箱存的是原文，换钥匙不用重新加密；摘要跟着钥匙变，和真平台一样
      vaultKey = o.key;
    },
    async seal(items) {
      rejectSecrets(items);
      const key = ensureKey();
      return items.map((it) => mockSeal(key, it.aad, it.plain));
    },
    async open(items) {
      rejectSecrets(items);
      const key = vaultKey;
      return items.map((it) => (key ? mockOpen(key, it.aad, it.data) : null));
    },
    async secretDigests() {
      const key = ensureKey();
      const out: Record<string, string> = {};
      for (const id of vault.ids()) {
        if (!syncable(id)) continue;
        const v = await vault.get(id);
        // 和真平台一样是对原文的带钥匙哈希：原文相同摘要就相同，换了钥匙全部会变
        if (v !== null) out[id] = fakeHash('digest', key, v);
      }
      return out;
    },
    async sealSecret(id, aad) {
      checkSecretAad(id, aad);
      // 墓碑加密空内容，条目不在也行
      if (aad.deleted) return mockSeal(ensureKey(), aad, '');
      const v = await vault.get(id);
      return v === null ? null : mockSeal(ensureKey(), aad, v);
    },
    async openSecret(id, aad, data) {
      checkSecretAad(id, aad);
      if (!vaultKey) return false;
      const plain = mockOpen(vaultKey, aad, data);
      if (plain === null) return false;
      if (aad.deleted) await vault.remove(id);
      else await vault.set(id, plain);
      return true;
    },
    async moveSecret(from, to) {
      const v = await vault.get(from);
      if (v === null) return;
      // to 已经有了就不覆盖，只删掉 from
      if ((await vault.get(to)) === null) await vault.set(to, v);
      await vault.remove(from);
    },
    async keyCheck() {
      if (!vaultKey) return null;
      // 和 Rust 一样，校验值里混进保险箱的随机编号：重建过就变，哪怕钥匙没变。
      // 编号存在保险箱的一个条目里（旧版本重写保险箱时条目会保留），没有就新起一个
      let id = await vault.get(VAULT_ID_ENTRY);
      if (id === null) {
        id = randomBase64(8);
        await vault.set(VAULT_ID_ENTRY, id);
      }
      return fakeHash('key-check', vaultKey, id);
    },
  };
}

// ---------- 假同步服务器 ----------

interface StoredRecord {
  collection: string;
  id: string;
  hlc: string;
  deleted: boolean;
  data: string;
  seq: number;
}

interface Account {
  name: string;
  authKey: string;
  salt: string;
  kdf: KdfParams;
  wrappedKey: string;
  seq: number;
  records: Map<string, StoredRecord>;
}

interface Session {
  account: string;
  deviceId: string;
  deviceName: string;
  platform: string;
  lastSeenAt: number;
}

export interface MockSyncServerOptions {
  registration?: 'invite' | 'open' | 'closed';
  invite?: string;
  now?: () => number;
  /** 每个账号的空间（字节） */
  quotaBytes?: number;
  /** 每个请求多等一会儿，预览时像真的网络 */
  delayMs?: number;
}

const HLC_RE = /^(\d{15})-[0-9a-f]{4}-[0-9a-f]{16}$/;
const COLLECTION_RE = /^[a-z][a-z-]{0,31}$/;
const ID_RE = /^[\x21-\x7e]{1,200}$/;
const HISTORY_KEEP = 1000;

type Reply = { status: number; body?: unknown };

function err(status: number, error: string, message = error): Reply {
  return { status, body: { error, message } };
}

export class MockSyncServer {
  readonly accounts = new Map<string, Account>();
  readonly sessions = new Map<string, Session>();
  private failures = new Map<string, number[]>();
  /** 测试用：为 true 时 fetch 直接抛错，像断网 */
  offline = false;
  /** 测试用：下一个请求直接回这个 */
  failNext: { status: number; body?: unknown; text?: string } | null = null;
  /** 测试用：收到的请求，[方法, 路径] */
  readonly requests: [string, string][] = [];
  readonly fetch: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly opts: MockSyncServerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.fetch = (input, init) => this.handleFetch(input, init);
  }

  private async handleFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (this.opts.delayMs) await delay(this.opts.delayMs);
    if (this.offline) throw new TypeError('Failed to fetch');
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^.*?\/v1\//, '/v1/');
    this.requests.push([method, path]);
    const cors = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
    if (this.failNext) {
      const f = this.failNext;
      this.failNext = null;
      return new Response(f.text ?? JSON.stringify(f.body ?? { error: 'internal', message: 'internal' }), { status: f.status, headers: cors });
    }
    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let body: unknown = undefined;
    if (init?.body != null) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        return new Response(JSON.stringify({ error: 'invalid', message: 'bad json' }), { status: 400, headers: cors });
      }
    }
    const auth = new Headers(init?.headers).get('authorization');
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const r = this.route(method, path, url.searchParams, body, token);
    return new Response(r.status === 204 ? null : JSON.stringify(r.body ?? {}), { status: r.status, headers: cors });
  }

  private route(method: string, path: string, query: URLSearchParams, body: unknown, token: string | null): Reply {
    const b = (body ?? {}) as Record<string, unknown>;
    if (method === 'GET' && path === '/v1/info') return { status: 200, body: { service: 'evershell-sync', version: 1, registration: this.opts.registration ?? 'open' } };
    if (method === 'POST' && path === '/v1/prelogin') {
      const name = String(b.account ?? '');
      const acc = this.accounts.get(name);
      // 账号不存在也给稳定的假盐，免得被拿来试探哪些账号存在
      return { status: 200, body: acc ? { salt: acc.salt, kdf: acc.kdf } : { salt: btoa(fakeHash('salt', name).slice(0, 16)), kdf: DEFAULT_KDF } };
    }
    if (method === 'POST' && path === '/v1/register') return this.register(b);
    if (method === 'POST' && path === '/v1/login') return this.login(b);

    const session = token ? this.sessions.get(token) : undefined;
    if (!session || !token) return err(401, 'unauthorized');
    session.lastSeenAt = this.now();
    const acc = this.accounts.get(session.account)!;

    if (method === 'POST' && path === '/v1/logout') {
      this.sessions.delete(token);
      return { status: 204 };
    }
    if (method === 'GET' && path === '/v1/account') {
      const devices = new Map<string, Session>();
      for (const s of this.sessions.values()) if (s.account === acc.name) devices.set(s.deviceId, s);
      let bytes = 0;
      for (const r of acc.records.values()) bytes += r.data.length;
      return {
        status: 200,
        body: {
          account: acc.name,
          usage: { bytes, records: acc.records.size },
          quota: { bytes: this.opts.quotaBytes ?? 50 * 1024 * 1024 },
          devices: [...devices.values()].map((s) => ({
            id: s.deviceId,
            name: s.deviceName,
            platform: s.platform,
            lastSeenAt: s.lastSeenAt,
            current: s.deviceId === session.deviceId,
          })),
        },
      };
    }
    if (method === 'PATCH' && path === '/v1/device') {
      if (typeof b.name !== 'string' || !b.name.trim()) return err(400, 'invalid');
      for (const s of this.sessions.values()) if (s.account === acc.name && s.deviceId === session.deviceId) s.deviceName = b.name;
      return { status: 204 };
    }
    const del = /^\/v1\/devices\/(.+)$/.exec(path);
    if (method === 'DELETE' && del) {
      const id = decodeURIComponent(del[1]!);
      if (id === session.deviceId) return err(400, 'invalid');
      for (const [t, s] of this.sessions) if (s.account === acc.name && s.deviceId === id) this.sessions.delete(t);
      return { status: 204 };
    }
    if (method === 'POST' && path === '/v1/password') {
      if (typeof b.authKey !== 'string' || typeof b.salt !== 'string' || typeof b.wrappedKey !== 'string' || !b.kdf) return err(400, 'invalid');
      acc.authKey = b.authKey;
      acc.salt = b.salt;
      acc.kdf = b.kdf as KdfParams;
      acc.wrappedKey = b.wrappedKey;
      for (const [t, s] of this.sessions) if (s.account === acc.name && t !== token) this.sessions.delete(t);
      return { status: 204 };
    }
    if (method === 'POST' && path === '/v1/records') return this.push(acc, b);
    if (method === 'GET' && path === '/v1/records') {
      const since = Number(query.get('since') ?? 0) || 0;
      const limit = Math.min(1000, Math.max(1, Number(query.get('limit') ?? 500) || 500));
      const all = [...acc.records.values()].filter((r) => r.seq > since).sort((x, y) => x.seq - y.seq);
      const page = all.slice(0, limit);
      return { status: 200, body: { records: page.map((r) => ({ ...r })), seq: acc.seq, more: all.length > limit } };
    }
    return err(404, 'not_found');
  }

  private register(b: Record<string, unknown>): Reply {
    const mode = this.opts.registration ?? 'open';
    if (mode === 'closed') return err(403, 'registration_closed');
    if (mode === 'invite' && b.invite !== (this.opts.invite ?? 'evershell')) return err(403, 'bad_invite');
    const name = b.account;
    const device = b.device as Record<string, unknown> | undefined;
    if (typeof name !== 'string' || !name || typeof b.authKey !== 'string' || typeof b.salt !== 'string' || typeof b.wrappedKey !== 'string' || !b.kdf || !device) {
      return err(400, 'invalid');
    }
    if (this.accounts.has(name)) return err(409, 'account_exists');
    this.accounts.set(name, { name, authKey: b.authKey, salt: b.salt, kdf: b.kdf as KdfParams, wrappedKey: b.wrappedKey, seq: 0, records: new Map() });
    return { status: 201, body: { token: this.newSession(name, device) } };
  }

  private login(b: Record<string, unknown>): Reply {
    const name = String(b.account ?? '');
    const now = this.now();
    const recent = (this.failures.get(name) ?? []).filter((t) => now - t < 15 * 60_000);
    if (recent.length >= 10) return err(429, 'too_many_attempts');
    const acc = this.accounts.get(name);
    const device = b.device as Record<string, unknown> | undefined;
    if (!acc || b.authKey !== acc.authKey || !device) {
      this.failures.set(name, [...recent, now]);
      return err(401, 'bad_credentials');
    }
    return { status: 200, body: { token: this.newSession(name, device), wrappedKey: acc.wrappedKey } };
  }

  private newSession(account: string, device: Record<string, unknown>): string {
    const token = randomBase64(32).replace(/[+/=]/g, '');
    this.sessions.set(token, {
      account,
      deviceId: String(device.id ?? ''),
      deviceName: String(device.name ?? ''),
      platform: String(device.platform ?? ''),
      lastSeenAt: this.now(),
    });
    return token;
  }

  private push(acc: Account, b: Record<string, unknown>): Reply {
    const records = b.records;
    if (!Array.isArray(records) || records.length > 500) return err(400, 'invalid');
    for (const r of records as Record<string, unknown>[]) {
      if (
        !r ||
        typeof r.collection !== 'string' ||
        !COLLECTION_RE.test(r.collection) ||
        typeof r.id !== 'string' ||
        !ID_RE.test(r.id) ||
        typeof r.hlc !== 'string' ||
        !HLC_RE.test(r.hlc) ||
        typeof r.deleted !== 'boolean' ||
        typeof r.data !== 'string' ||
        r.data.length > 64 * 1024
      ) {
        return err(400, 'invalid');
      }
      if (Number(r.hlc.slice(0, 15)) > this.now() + 10 * 60_000) return err(400, 'clock_skew');
    }
    let bytes = 0;
    for (const r of acc.records.values()) bytes += r.data.length;
    for (const r of records as StoredRecord[]) bytes += r.data.length - (acc.records.get(`${r.collection}/${r.id}`)?.data.length ?? 0);
    if (this.opts.quotaBytes !== undefined && bytes > this.opts.quotaBytes) return err(413, 'quota_exceeded');
    const results = (records as StoredRecord[]).map((r) => {
      const key = `${r.collection}/${r.id}`;
      const existing = acc.records.get(key);
      if (existing && !(r.hlc > existing.hlc)) return { status: 'stale', hlc: existing.hlc };
      acc.records.set(key, { collection: r.collection, id: r.id, hlc: r.hlc, deleted: r.deleted, data: r.data, seq: ++acc.seq });
      return { status: 'ok' };
    });
    // 服务器替 history 只留最新 1000 条
    const history = [...acc.records.values()].filter((r) => r.collection === 'history').sort((x, y) => (x.hlc < y.hlc ? 1 : -1));
    for (const r of history.slice(HISTORY_KEEP)) acc.records.delete(`history/${r.id}`);
    return { status: 200, body: { seq: acc.seq, results } };
  }

  // ---------- 测试用 ----------

  /** 某条记录现在的样子 */
  record(account: string, collection: string, id: string): StoredRecord | undefined {
    const r = this.accounts.get(account)?.records.get(`${collection}/${id}`);
    return r && { ...r };
  }

  /** 模拟被篡改的服务器：把一条旧版本当作新数据重新发出去（给一个新序号） */
  replay(account: string, old: StoredRecord): void {
    const acc = this.accounts.get(account)!;
    acc.records.set(`${old.collection}/${old.id}`, { ...old, seq: ++acc.seq });
  }

  /** 整个账号的快照，配合 restore 模拟服务器恢复备份 */
  snapshot(account: string): Account {
    const acc = this.accounts.get(account)!;
    return { ...acc, records: new Map([...acc.records].map(([k, r]) => [k, { ...r }])) };
  }

  restore(account: string, snap: Account): void {
    const acc = this.accounts.get(account)!;
    acc.seq = snap.seq;
    acc.records = new Map([...snap.records].map(([k, r]) => [k, { ...r }]));
  }

  /** 预置一个有数据的账号，用来看「登录并开启同步」的合并结果 */
  seedDemo(account = 'demo', password = 'demo1234'): void {
    if (this.accounts.has(account)) return;
    const salt = btoa(fakeHash('demo-salt', account).slice(0, 16));
    const { authKey, kek } = deriveRoot(password, account, salt);
    const key = btoa(fakeHash('demo-vault-key', account));
    const acc: Account = { name: account, authKey, salt, kdf: DEFAULT_KDF, wrappedKey: wrapWith(kek, key), seq: 0, records: new Map() };
    const device = 'de00000000000001';
    const at = this.now() - 86_400_000;
    let n = 0;
    const put = (collection: string, id: string, value: unknown) => {
      const hlc = formatHlc(at, n++, device);
      const aad = { account, collection, id, hlc, deleted: false };
      acc.records.set(`${collection}/${id}`, { collection, id, hlc, deleted: false, data: mockSeal(key, aad, JSON.stringify(value)), seq: ++acc.seq });
    };
    const advanced = { jumpServerId: null, proxy: 'none', proxyHost: '', proxyPort: 1080, keepAliveSecs: 30, encoding: 'UTF-8', termType: 'xterm-256color' };
    const folder = { id: 'dir_demo_cloud', name: '云端示例', parentId: null, createdAt: at, updatedAt: at, deletedAt: null };
    put('folder', folder.id, folder);
    const servers: [string, string, string][] = [
      ['srv_demo_web', 'cloud-web-01', '198.51.100.21'],
      ['srv_demo_db', 'cloud-db-01', '198.51.100.22'],
      ['srv_demo_cache', 'cloud-cache-01', '198.51.100.23'],
    ];
    for (const [id, name, host] of servers) {
      put('server', id, {
        id,
        parentId: folder.id,
        name,
        host,
        port: 22,
        user: 'root',
        note: '',
        proto: 'ssh',
        auth: 'password',
        keyId: null,
        keyLabel: null,
        advanced,
        forwards: [],
        createdAt: at,
        updatedAt: at,
        deletedAt: null,
      });
    }
    put('snippet', 'snp_demo_1', { id: 'snp_demo_1', name: '查看磁盘', cmd: 'df -h', group: '常用', updatedAt: at });
    put('snippet', 'snp_demo_2', { id: 'snp_demo_2', name: '最近日志', cmd: 'journalctl -n 100', group: '云端示例', updatedAt: at });
    put('meta', 'snippet-groups', ['常用', '云端示例']);
    this.accounts.set(account, acc);
  }
}

/** 预览用：按服务器地址分开的假服务器，地址里的关键字决定行为（见文件开头） */
export function createPreviewSyncFetch(): typeof fetch {
  const servers = new Map<string, MockSyncServer>();
  const serverFor = (base: string) => {
    let s = servers.get(base);
    if (!s) {
      const registration = /closed/i.test(base) ? 'closed' : /invite/i.test(base) ? 'invite' : 'open';
      s = new MockSyncServer({ registration, invite: 'evershell', delayMs: 250 });
      s.seedDemo();
      servers.set(base, s);
    }
    return s;
  };
  return async (input, init) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const base = href.replace(/\/v1\/.*$/, '');
    if (/offline/i.test(base)) {
      await delay(400);
      throw new TypeError('Failed to fetch');
    }
    return serverFor(base).fetch(input, init);
  };
}
