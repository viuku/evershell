import type { RecordAad, SecretStore, SyncPlatform } from '../../types';
import type { Store } from '../store';
import { SyncClient, classify, reasonFor, statusReason, type PulledRecord, type WireRecord } from './client';
import {
  COLLECTIONS,
  COLLECTIONS_VERSION,
  belowMark,
  countField,
  countLocal,
  isCollection,
  isLive,
  knownHostSnapshot,
  parseKnownHost,
  plainCollections,
  writeKnownHosts,
  MARK_IDS,
  type KnownHostLines,
  type PlainCollection,
  type StoreName,
  type SyncStores,
} from './collections';
import { digest, knownHostId } from './digest';
import { HybridClock, parseHlc } from './hlc';
import { detectChanges, isNewer, ledgerGet, ledgerSet, pendingKey, splitPendingKey } from './ledger';
import { SyncError, emptyCounts, type SyncCounts, type SyncState, type SyncStatus } from './model';
import { SESSION_SECRET, type StateHolder, type SyncStateV1 } from './state';

// 同步引擎（docs/specs/sync.md「同步引擎」）：发现本机改动、一轮同步（先推后拉）、调度、状态。
// 所有依赖从构造函数进来，正式的单例在 index.ts 里组装；测试里两个模拟客户端各建一个，数据互不相干。

export const INTERVAL_MS = 30_000;
export const DEBOUNCE_MS = 1_500;
export const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000];
/** 窗口来回切换时不要每次都同步 */
const FOCUS_THROTTLE_MS = 5_000;
const PUSH_BATCH = 500;
const PULL_LIMIT = 500;
/** 服务器每条最多 64 KiB、每次请求最多 4 MiB，留点余量 */
const MAX_DATA = 64 * 1024;
const MAX_BODY = 3 * 1024 * 1024;
/** 存下的时钟比现在快这么多，就当系统时间被改回来了，把时钟拨回现在 */
const CLOCK_AHEAD_MS = 60_000;
export const VAULT_RESET_MESSAGE = '本机保险箱已重建，请重新登录同步';

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface EngineDeps {
  platform: SyncPlatform;
  secrets: SecretStore;
  stores: SyncStores;
  knownHosts: KnownHostLines;
  state: StateHolder;
  status: Store<SyncStatus>;
  /** 不给就用平台的假服务器或全局 fetch */
  fetch?: typeof fetch;
  now?: () => number;
  timers?: Timers;
  /** navigator.onLine；测试里可以关掉网络 */
  online?: () => boolean;
  /** 设备平台：'macos' | 'windows' | 'linux' | 'web' | … */
  platformName?: string;
  /** 开着同步时先把还没落盘的默认数据写下来（快捷命令的默认几条每次启动 id 都不一样） */
  materialize?: () => void;
}

/** sync. 开头的（同步自己的登录凭据）和 known_hosts（走 known-host 集合）不同步 */
export function syncableSecret(id: string): boolean {
  return id !== 'known_hosts' && !id.startsWith('sync.');
}

export function aadFor(account: string, collection: string, id: string, hlc: string, deleted: boolean): RecordAad {
  return { account, collection, id, hlc, deleted };
}

export function detectPlatform(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  const s = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  if (/Mac|darwin/i.test(s)) return 'macos';
  if (/Win/i.test(s)) return 'windows';
  if (/Linux|X11/i.test(s)) return 'linux';
  return 'unknown';
}

/** 解密、校验一批远端的普通记录（机密不在这里）。返回值与输入一一对应：null 表示解不开或内容不对，'skip' 表示不认识、不用管 */
export async function decodeRecords(
  platform: SyncPlatform,
  account: string,
  records: PulledRecord[],
  byName: Map<string, PlainCollection>,
): Promise<(unknown | null | 'skip')[]> {
  if (!records.length) return [];
  const opened = await platform.open(records.map((r) => ({ aad: aadFor(account, r.collection, r.id, r.hlc, r.deleted), data: r.data })));
  const out: (unknown | null | 'skip')[] = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    const plain = opened[i];
    if (typeof plain !== 'string') {
      out.push(null);
      continue;
    }
    if (r.deleted) {
      // 墓碑：内容为空，值记 undefined 和“解不开”区分
      out.push(undefined);
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(plain);
    } catch {
      out.push(null);
      continue;
    }
    if (r.collection === 'known-host') {
      const v = parseKnownHost(raw);
      out.push(v && (await knownHostId(v.line)) === r.id ? v : null);
      continue;
    }
    if (r.collection === 'meta' && !['snippet-groups', ...MARK_IDS].includes(r.id)) {
      // 更新版本加的 meta，不认识就不管
      out.push('skip');
      continue;
    }
    const col = byName.get(r.collection);
    out.push(col ? col.parse(r.id, raw) : 'skip');
  }
  return out;
}

export class SyncEngine {
  readonly platform: SyncPlatform;
  readonly secrets: SecretStore;
  readonly stores: SyncStores;
  readonly knownHosts: KnownHostLines;
  readonly status: Store<SyncStatus>;
  readonly fetchFn: typeof fetch;
  readonly now: () => number;
  readonly platformName: string;
  readonly collections: PlainCollection[];
  readonly byName: Map<string, PlainCollection>;
  private readonly timers: Timers;
  private readonly online: () => boolean;
  private readonly byStore = new Map<StoreName, PlainCollection[]>();

  private st: SyncStateV1 | null = null;
  /** 同步状态是更新版本写的：不同步、不写回 */
  private future = false;
  private token: string | null = null;
  private clock: HybridClock | null = null;
  private pending = new Set<string>();
  private running: Promise<void> | null = null;
  private timer: unknown = null;
  private timerAt = Infinity;
  private failures = 0;
  private reloginNeeded = false;
  /** 这次启动以来有记录解不开（数据坏了或被篡改，重试也没用），状态一直显示同步失败 */
  private undecryptable = false;
  private tooLarge = false;
  /** 正在写远端来的数据：清空检测不当成用户点了「清空」 */
  private applying = false;
  private started = false;
  private unsubs: (() => void)[] = [];
  private prevLen = { history: 0, recents: 0 };
  private knownHostCount = 0;
  private lastRoundAt = -Infinity;

  constructor(private readonly deps: EngineDeps) {
    this.platform = deps.platform;
    this.secrets = deps.secrets;
    this.stores = deps.stores;
    this.knownHosts = deps.knownHosts;
    this.status = deps.status;
    const f = deps.fetch ?? deps.platform.fetch ?? globalThis.fetch;
    this.fetchFn = (input, init) => f(input, init);
    this.now = deps.now ?? (() => Date.now());
    this.timers = deps.timers ?? realTimers;
    this.online = deps.online ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
    this.platformName = deps.platformName ?? detectPlatform();
    this.collections = plainCollections(deps.stores, {
      get: () => this.st?.marks ?? {},
      set: (name, at) => {
        if (this.st) this.st.marks[name] = at;
      },
    });
    this.byName = new Map(this.collections.map((c) => [c.name, c]));
    for (const c of this.collections) {
      for (const s of c.stores) this.byStore.set(s, [...(this.byStore.get(s) ?? []), c]);
    }
  }

  // ---------- 生命周期 ----------

  /** 主窗口启动时：读同步状态，开着同步就开始定时同步 */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    for (const name of Object.keys(this.stores) as StoreName[]) {
      this.unsubs.push(this.stores[name].subscribe(() => this.onStoreChange(name)));
    }
    this.prevLen = { history: this.stores.history.get().length, recents: this.stores.recents.get().length };
    this.refreshCounts();
    const loaded = this.deps.state.load();
    if (loaded === 'future') {
      this.future = true;
      this.setState('error', '同步状态由较新版本的 EverShell 写入，请升级到最新版本后再同步');
    } else if (loaded) {
      this.load(loaded);
      this.persist();
      this.deps.materialize?.();
      this.setState('syncing', '');
      const token = await this.secrets.get(SESSION_SECRET).catch(() => null);
      if (!this.started || this.st !== loaded) return;
      if (token) {
        this.token = token;
        this.schedule(0);
      } else {
        // 令牌没了多半是保险箱重建过（令牌也存在里面），查一下好给出原因；查不了就不给原因
        const reset = await this.vaultLooksReset().catch(() => false);
        if (!this.started || this.st !== loaded) return;
        this.markRelogin(reset ? VAULT_RESET_MESSAGE : '');
      }
    }
    await this.refreshKnownHostCount();
  }

  stop(): void {
    this.started = false;
    this.clearTimer();
    for (const off of this.unsubs) off();
    this.unsubs = [];
  }

  get active(): boolean {
    return !!this.st && !this.future;
  }

  /** 同步状态在、但是更新版本写的 */
  get isFuture(): boolean {
    return this.future;
  }

  get session(): Readonly<SyncStateV1> | null {
    return this.st;
  }

  get sessionToken(): string | null {
    return this.token;
  }

  get needsRelogin(): boolean {
    return this.reloginNeeded;
  }

  client(server?: string, token?: string | null): SyncClient {
    return new SyncClient(server ?? this.st?.server ?? '', this.fetchFn, token === undefined ? this.token : token);
  }

  /** 开启同步（注册、登录完成后）：存下状态和令牌。不跑同步，调用方接着 syncNow */
  async activate(state: SyncStateV1, token: string): Promise<void> {
    // 令牌先存：存不进保险箱就什么都不变
    await this.secrets.set(SESSION_SECRET, token);
    this.load(state);
    this.future = false;
    this.token = token;
    this.reloginNeeded = false;
    this.failures = 0;
    this.undecryptable = false;
    this.tooLarge = false;
    this.deps.materialize?.();
    this.persist();
    this.setState('syncing', '');
  }

  /** 退出登录：删掉同步状态和令牌，本机数据不动 */
  async deactivate(): Promise<void> {
    this.clearTimer();
    this.st = null;
    this.token = null;
    this.clock = null;
    this.pending = new Set();
    this.future = false;
    this.reloginNeeded = false;
    this.failures = 0;
    this.undecryptable = false;
    this.tooLarge = false;
    this.deps.state.clear();
    await this.secrets.remove(SESSION_SECRET).catch(() => {});
    this.status.set((prev) => ({ ...prev, state: 'off', message: '', lastSyncAt: null, server: null, account: null, deviceName: null }));
  }

  /**
   * 重新登录成功：换上新令牌、记下新的钥匙校验值，接着同步。
   * resetSecrets：保险箱重建过，机密的账本作废、游标归零，先把云端的机密拉回来，不把本机缺的当成删除
   */
  async resume(token: string, opts: { keyCheck: string | null; resetSecrets: boolean }): Promise<void> {
    const st = this.st;
    if (!st) return;
    await this.secrets.set(SESSION_SECRET, token);
    if (this.st !== st) return;
    this.token = token;
    this.reloginNeeded = false;
    this.failures = 0;
    st.keyCheck = opts.keyCheck;
    if (opts.resetSecrets) {
      // known_hosts 也存在保险箱里，重建后一样没了，一起作废
      delete st.ledger.secret;
      delete st.ledger['known-host'];
      for (const key of [...this.pending]) if (key.startsWith('secret/') || key.startsWith('known-host/')) this.pending.delete(key);
      st.cursor = 0;
      st.secretsResync = true;
    }
    st.vaultReset = false;
    this.persist();
    this.setState('syncing', '');
    this.schedule(0);
  }

  markRelogin(message = ''): void {
    if (!this.st) return;
    this.reloginNeeded = true;
    this.clearTimer();
    this.setState('relogin', message);
  }

  /** 解密失败的记录出现过：状态显示同步失败 */
  flagUndecryptable(): void {
    this.undecryptable = true;
    if (this.st && !this.reloginNeeded) this.setState('error', reasonFor('decrypt'));
  }

  setDeviceName(name: string): void {
    if (!this.st) return;
    this.st.deviceName = name;
    this.persist();
    this.status.set((prev) => ({ ...prev, deviceName: name }));
  }

  newHlc(): string {
    if (!this.clock) throw new Error('同步未开启');
    return this.clock.tick();
  }

  private load(state: SyncStateV1): void {
    this.st = state;
    this.clock = new HybridClock(state.deviceId, state.clock, this.now);
    this.pending = new Set(state.pending);
    if (state.collectionsVersion < COLLECTIONS_VERSION) {
      state.cursor = 0;
      state.collectionsVersion = COLLECTIONS_VERSION;
    }
    this.fixClockIfAhead();
  }

  /**
   * 存下的时钟比现在快一分钟以上（系统时间曾经调快、后来改回来了）：拨回现在，待上传的重新取时间戳，
   * 不然服务器一直以「时间太快」拒收。只在读入状态和服务器报时间太快时做，平时快一点是见过别的设备的时间戳，属正常
   */
  private fixClockIfAhead(): boolean {
    const st = this.st;
    if (!st || !this.clock) return false;
    const now = this.now();
    if (this.clock.snapshot().ms <= now + CLOCK_AHEAD_MS) return false;
    // 不拨到见过的远端时间戳以下：之后本机的改动一定比已经拉到的新
    const seen = st.maxSeen ? parseHlc(st.maxSeen) : null;
    const base = seen && seen.ms > now ? { ms: seen.ms, c: seen.c } : { ms: now, c: 0 };
    if (base.ms >= this.clock.snapshot().ms) return false;
    const clock = new HybridClock(st.deviceId, base, this.now);
    this.clock = clock;
    for (const key of this.pending) {
      const k = splitPendingKey(key);
      const e = k && ledgerGet(st.ledger, k.collection, k.id);
      if (k && e) ledgerSet(st.ledger, k.collection, k.id, [clock.tick(), e[1]]);
    }
    return true;
  }

  private alive(st: SyncStateV1): boolean {
    return this.st === st && !this.future;
  }

  private persist(): void {
    const st = this.st;
    // 停掉以后（例如开发时 React 重挂载、换了一个新引擎）还没结束的那一轮不再写，免得拿旧状态盖掉新的
    if (!st || this.future || !this.clock || !this.started) return;
    st.clock = this.clock.snapshot();
    st.pending = [...this.pending];
    this.deps.state.save(st);
  }

  // ---------- 状态 ----------

  private setState(state: SyncState, message: string): void {
    const st = this.st;
    this.status.set((prev) => ({
      ...prev,
      state,
      message,
      lastSyncAt: st?.lastSyncAt ?? null,
      server: st?.server ?? null,
      account: st?.account ?? null,
      deviceName: st?.deviceName ?? null,
    }));
  }

  private refreshCounts(): void {
    const counts = countLocal(this.stores, this.knownHostCount);
    this.status.set((prev) => (sameCounts(prev.counts, counts) ? prev : { ...prev, counts }));
  }

  private async refreshKnownHostCount(): Promise<void> {
    try {
      this.knownHostCount = (await this.knownHosts.lines()).length;
    } catch {
      return;
    }
    this.refreshCounts();
  }

  // ---------- 发现本机改动 ----------

  private onStoreChange(name: StoreName): void {
    this.refreshCounts();
    let cleared = false;
    if (name === 'history' || name === 'recents') {
      const len = this.stores[name].get().length;
      const prev = this.prevLen[name];
      this.prevLen[name] = len;
      // 「清空」现在只是把数组清掉，挤出去不会清空，所以整份从有变成没有就是用户点了清空
      if (this.st && !this.future && !this.applying && prev > 0 && len === 0) {
        this.st.marks[name === 'history' ? 'history-cleared' : 'recents-cleared'] = this.now();
        cleared = true;
      }
    }
    if (!this.st || this.future) return;
    const cols = [...(this.byStore.get(name) ?? [])];
    if (cleared) cols.push(this.byName.get('meta')!);
    if (this.scanPlain(cols) || cleared) {
      this.persist();
      this.scheduleSoon();
    }
  }

  /** 前端数据的集合和账本比；有变化返回 true */
  private scanPlain(cols: PlainCollection[] = this.collections): boolean {
    const st = this.st;
    const clock = this.clock;
    if (!st || !clock) return false;
    const tick = () => clock.tick();
    let changed = false;
    for (const c of cols) {
      const digests = new Map<string, string>();
      for (const [id, v] of c.snapshot()) digests.set(id, digest(v));
      if (detectChanges(st.ledger, this.pending, c.name, digests, tick, c.tombstones).length) changed = true;
    }
    return changed;
  }

  /** 全部比一遍：前端数据、known_hosts、保险箱。每轮同步前都跑，防止漏掉通知（保险箱和 known_hosts 没有通知） */
  async scanAll(): Promise<void> {
    const st = this.st;
    if (!st || !this.clock || this.future) return;
    this.scanPlain();
    // 重建后重新登录的那一轮，先拉云端的机密和 known_hosts 回来再比
    const resync = st.secretsResync;
    const kh = await knownHostSnapshot(this.knownHosts);
    const rawDigests = await this.platform.secretDigests();
    const secretDigests = Object.fromEntries(Object.entries(rawDigests).filter(([id]) => syncableSecret(id)));
    // 保险箱重建过时本机的机密和 known_hosts 都没了，比出来全是删除：先停下，绝不发这两样的墓碑
    if (await this.vaultLooksReset({ secretCount: Object.keys(secretDigests).length, knownHostCount: kh.size })) {
      if (this.alive(st)) {
        st.vaultReset = true;
        this.persist();
      }
      throw new SyncError('vault_reset', VAULT_RESET_MESSAGE);
    }
    if (!this.alive(st) || !this.clock) return;
    const clock = this.clock;
    const tick = () => clock.tick();
    this.knownHostCount = kh.size;
    this.refreshCounts();
    const khDigests = new Map<string, string>();
    for (const [id, v] of kh) khDigests.set(id, digest(v));
    if (!resync) {
      detectChanges(st.ledger, this.pending, 'known-host', khDigests, tick, true);
      detectChanges(st.ledger, this.pending, 'secret', new Map(Object.entries(secretDigests)), tick, true);
    }
    this.persist();
  }

  /**
   * 保险箱是不是重建过（或被清空）：
   * - 已经发现过、还没重新登录；
   * - 钥匙校验值和登录时记下的对不上（换了钥匙，或平台给的保险箱编号变了）；
   * - 兜底：账本里有机密（或 known_hosts），本机一条都没有了，而且登录令牌也不在保险箱里。
   *   令牌和它们存在同一个保险箱里，用户自己删光密码时令牌还在，所以不会把正常的删除当成重建。
   * 读不出来（钥匙串一时读不了、和平台通信出错）不算重建：抛错，这一轮按普通失败退避重试。
   * 误判成重建的代价很大（重新登录后本机的旧机密会盖掉云端更新的），只有真的对不上、或根本没有钥匙才算
   */
  async vaultLooksReset(found?: { secretCount: number; knownHostCount: number }): Promise<boolean> {
    const st = this.st;
    if (!st) return false;
    if (st.vaultReset) return true;
    let check: string | null;
    try {
      check = await this.platform.keyCheck();
    } catch (e) {
      console.warn('[sync] 读取保险箱钥匙校验值失败', e);
      throw new SyncError('keychain', reasonFor('keychain'));
    }
    if (check === null || check !== st.keyCheck) return true;
    const liveSecrets = liveCount(st.ledger.secret);
    const liveKnownHosts = liveCount(st.ledger['known-host']);
    if (!liveSecrets && !liveKnownHosts) return false;
    const counts = found ?? {
      secretCount: Object.keys(await this.platform.secretDigests()).filter(syncableSecret).length,
      knownHostCount: (await this.knownHosts.lines()).length,
    };
    const emptied = (liveSecrets > 0 && counts.secretCount === 0) || (liveKnownHosts > 0 && counts.knownHostCount === 0);
    if (!emptied) return false;
    return (await this.secrets.get(SESSION_SECRET)) === null;
  }

  /** 记下见过的远端时间戳：拨上本机时钟，并留下最大的一个，拨回时钟时不拨到它以下 */
  private observe(st: SyncStateV1, hlc: string): void {
    this.clock?.observe(hlc);
    if (!st.maxSeen || hlc > st.maxSeen) st.maxSeen = hlc;
  }

  /** 第一次登录在开启以后才写进本机的云端机密：写完重新取摘要记账 */
  async recordSecretsApplied(records: { id: string; hlc: string; deleted: boolean }[]): Promise<void> {
    const st = this.st;
    if (!st || !records.length) return;
    const digests = await this.platform.secretDigests();
    if (!this.alive(st)) return;
    for (const r of records) {
      this.observe(st, r.hlc);
      ledgerSet(st.ledger, 'secret', r.id, [r.hlc, r.deleted ? null : (digests[r.id] ?? null)]);
      this.pending.delete(pendingKey('secret', r.id));
    }
    this.persist();
  }

  /** 待上传里现有的条数（墓碑、回收站里的不算），给完成框用 */
  pendingCounts(): SyncCounts {
    const counts = emptyCounts();
    const snaps = new Map<string, Map<string, unknown>>();
    for (const key of this.pending) {
      const k = splitPendingKey(key);
      if (!k) continue;
      const field = countField(k.collection);
      const entry = this.st && ledgerGet(this.st.ledger, k.collection, k.id);
      if (!field || !entry || entry[1] === null) continue;
      const col = this.byName.get(k.collection);
      if (col) {
        let snap = snaps.get(col.name);
        if (!snap) snaps.set(col.name, (snap = col.snapshot()));
        if (!isLive(snap.get(k.id))) continue;
      }
      counts[field]++;
    }
    return counts;
  }

  // ---------- 一轮同步 ----------

  /** 立即同步一轮；正在同步时等这一轮结束。出错不抛，看状态 */
  syncNow(): Promise<void> {
    return this.round(true);
  }

  private round(manual: boolean): Promise<void> {
    if (this.running) return this.running;
    const p = this.runRound(manual).finally(() => {
      if (this.running === p) this.running = null;
    });
    this.running = p;
    return p;
  }

  private async runRound(manual: boolean): Promise<void> {
    const st = this.st;
    if (!st || this.future || this.reloginNeeded || !this.token) return;
    this.clearTimer();
    if (!this.online()) {
      this.setState('offline', '网络未连接');
      this.schedule(INTERVAL_MS);
      return;
    }
    this.lastRoundAt = this.now();
    // 后台每 30 秒一轮时不把「已同步」闪成「正在同步…」
    if (manual || this.status.get().state !== 'ok') this.setState('syncing', '');
    try {
      await this.scanAll();
      if (!this.alive(st)) return;
      await this.push(st);
      const rewound = await this.pullAll(st);
      if (!this.alive(st)) return;
      let resynced = false;
      if (st.secretsResync) {
        // 云端的机密拉回来了，现在才比本机的：云端没有的才上传
        st.secretsResync = false;
        this.persist();
        await this.scanAll();
        resynced = true;
      }
      if (rewound || resynced) await this.push(st);
      if (!this.alive(st)) return;
      st.lastSyncAt = this.now();
      this.persist();
      this.failures = 0;
      if (this.undecryptable) this.setState('error', reasonFor('decrypt'));
      else if (this.tooLarge) this.setState('error', reasonFor('too_large'));
      else this.setState('ok', '');
      this.schedule(this.pending.size ? DEBOUNCE_MS : INTERVAL_MS);
    } catch (e) {
      if (!this.alive(st)) return;
      this.persist();
      const kind = classify(e);
      if (kind === 'relogin') {
        this.markRelogin(e instanceof SyncError && e.code === 'vault_reset' ? VAULT_RESET_MESSAGE : '');
        return;
      }
      if (kind === 'error') console.warn('[sync] 同步失败', e);
      this.failures++;
      this.setState(kind, statusReason(e));
      this.schedule(BACKOFF_MS[Math.min(this.failures - 1, BACKOFF_MS.length - 1)]!);
    }
  }

  /** 推送；服务器说时间太快、而存下的时钟确实比现在快时，拨回时钟重推一次 */
  private async push(st: SyncStateV1): Promise<void> {
    try {
      await this.pushPending(st);
    } catch (e) {
      if (!(e instanceof SyncError && e.code === 'clock_skew' && this.alive(st) && this.fixClockIfAhead())) throw e;
      this.persist();
      await this.pushPending(st);
    }
  }

  private async pushPending(st: SyncStateV1): Promise<void> {
    // 每批推完都会从待上传里去掉；推的过程中又改了的会再推一次。上限只是防万一
    for (let guard = 0; guard < 10_000 && this.alive(st); guard++) {
      const batch = await this.buildBatch(st);
      if (!batch.length || !this.alive(st)) return;
      const results = await this.client().push(batch.map((b) => b.wire));
      if (!this.alive(st)) return;
      results.forEach((r, i) => {
        const w = batch[i]!.wire;
        // stale：服务器上已有更新的，拉取时会拿回来。推的时候本机又改了（账本时间戳变了）就留着下次推
        const entry = ledgerGet(st.ledger, w.collection, w.id);
        if (!entry || entry[0] === w.hlc) this.pending.delete(pendingKey(w.collection, w.id));
        void r;
      });
      this.persist();
    }
  }

  /** 取一批待上传的、加密好。普通记录在同一个同步段里读内容和账本，保证内容和时间戳对得上 */
  private async buildBatch(st: SyncStateV1): Promise<{ wire: WireRecord }[]> {
    this.scanPlain();
    const order = (c: string) => (COLLECTIONS as readonly string[]).indexOf(c);
    const keys = [...this.pending]
      .map((key) => ({ key, k: splitPendingKey(key) }))
      .sort((a, b) => order(a.k?.collection ?? '') - order(b.k?.collection ?? ''));
    const snaps = new Map<string, Map<string, unknown>>();
    type Item = { collection: string; id: string; hlc: string; deleted: boolean; plain: string | null };
    const items: Item[] = [];
    for (const { key, k } of keys) {
      if (items.length >= PUSH_BATCH) break;
      const entry = k && isCollection(k.collection) ? ledgerGet(st.ledger, k.collection, k.id) : undefined;
      if (!k || !entry) {
        this.pending.delete(key);
        continue;
      }
      const [hlc, d] = entry;
      const deleted = d === null;
      let plain: string | null = deleted ? '' : null;
      const col = this.byName.get(k.collection);
      if (!deleted && col) {
        let snap = snaps.get(col.name);
        if (!snap) snaps.set(col.name, (snap = col.snapshot()));
        const v = snap.get(k.id);
        // 刚扫描过，普通记录不会对不上；万一对不上就留到下一轮
        if (v === undefined) continue;
        plain = JSON.stringify(v);
      }
      items.push({ collection: k.collection, id: k.id, hlc, deleted, plain });
    }
    if (!items.length) return [];

    // known_hosts、机密不在前端，异步读；读的时候已经没了就改成墓碑
    const toTombstone = (it: Item) => {
      const e = ledgerGet(st.ledger, it.collection, it.id);
      if (!e || e[0] !== it.hlc || !this.clock) return;
      it.hlc = this.clock.tick();
      it.deleted = true;
      it.plain = '';
      ledgerSet(st.ledger, it.collection, it.id, [it.hlc, null]);
    };
    if (items.some((it) => it.collection === 'known-host' && it.plain === null)) {
      const kh = await knownHostSnapshot(this.knownHosts);
      for (const it of items) {
        if (it.collection !== 'known-host' || it.plain !== null) continue;
        const v = kh.get(it.id);
        if (v) it.plain = JSON.stringify(v);
        else toTombstone(it);
      }
    }
    // 机密（含墓碑）一律经保险箱加密，平台的 seal 不收 secret 集合
    const sealedSecrets = new Map<Item, string>();
    for (const it of items) {
      if (it.collection !== 'secret') continue;
      let data = it.deleted ? null : await this.platform.sealSecret(it.id, aadFor(st.account, 'secret', it.id, it.hlc, false));
      if (!it.deleted && data === null) toTombstone(it);
      if (it.deleted) data = await this.platform.sealSecret(it.id, aadFor(st.account, 'secret', it.id, it.hlc, true));
      if (data !== null) sealedSecrets.set(it, data);
    }
    if (!this.alive(st)) return [];
    const plainItems = items.filter((it) => it.collection !== 'secret' && it.plain !== null);
    const sealed = plainItems.length
      ? await this.platform.seal(plainItems.map((it) => ({ aad: aadFor(st.account, it.collection, it.id, it.hlc, it.deleted), plain: it.plain! })))
      : [];
    const dataOf = new Map<Item, string>(sealedSecrets);
    plainItems.forEach((it, i) => dataOf.set(it, sealed[i]!));

    const out: { wire: WireRecord }[] = [];
    let bytes = 0;
    for (const it of items) {
      const data = dataOf.get(it);
      if (data === undefined) continue;
      if (data.length > MAX_DATA) {
        // 服务器收不下：不推了，等内容变小（再改一次）时重新标为待上传
        this.pending.delete(pendingKey(it.collection, it.id));
        this.tooLarge = true;
        continue;
      }
      bytes += data.length + it.id.length + 120;
      if (out.length && bytes > MAX_BODY) break;
      out.push({ wire: { collection: it.collection, id: it.id, hlc: it.hlc, deleted: it.deleted, data } });
    }
    return out;
  }

  /** 拉 since=游标 直到 more=false。服务器序号比游标小（恢复过备份）就从 0 重拉，返回 true */
  private async pullAll(st: SyncStateV1): Promise<boolean> {
    const client = this.client();
    let rewound = false;
    for (let guard = 0; guard < 100_000; guard++) {
      const res = await client.pull(st.cursor, PULL_LIMIT);
      if (!this.alive(st)) return rewound;
      if (res.seq < st.cursor && !rewound) {
        // 服务器倒回去了：游标归零重拉，账本照常按时间戳判断，旧版本会被拒收。
        // 本机账本里有的都重新推一遍，补上服务器丢掉的那部分
        rewound = true;
        st.cursor = 0;
        for (const [collection, book] of Object.entries(st.ledger)) {
          for (const id of Object.keys(book)) this.pending.add(pendingKey(collection, id));
        }
        this.persist();
        continue;
      }
      await this.applyRemote(st, res.records);
      if (!this.alive(st)) return rewound;
      const last = res.records[res.records.length - 1];
      if (last) st.cursor = Math.max(st.cursor, last.seq);
      this.persist();
      if (!res.more || !res.records.length) break;
    }
    return rewound;
  }

  /** 应用一页远端记录：比账本新的才要；每个集合先更新账本再写数据，写入触发的改动发现看到的摘要就是一致的 */
  async applyRemote(st: SyncStateV1, records: PulledRecord[]): Promise<void> {
    const fresh: PulledRecord[] = [];
    const secretsIn: PulledRecord[] = [];
    for (const r of records) {
      // 不认识的集合是更新版本加的，跳过；游标照常往前走
      if (!r.collection || !isCollection(r.collection)) continue;
      if (r.collection === 'secret' && !syncableSecret(r.id)) continue;
      if (!isNewer(st.ledger, r.collection, r.id, r.hlc)) continue;
      (r.collection === 'secret' ? secretsIn : fresh).push(r);
    }
    const values = await decodeRecords(this.platform, st.account, fresh, this.byName);
    if (!this.alive(st)) return;

    const grouped = new Map<string, { r: PulledRecord; value: unknown }[]>();
    fresh.forEach((r, i) => {
      const v = values[i];
      if (v === 'skip') return;
      if (v === null) {
        this.undecryptable = true;
        return;
      }
      const list = grouped.get(r.collection) ?? [];
      list.push({ r, value: r.deleted ? null : v });
      grouped.set(r.collection, list);
    });

    // 水位线（meta）先应用，同一页里早于它的历史就不写了
    const knownHostItems: { r: PulledRecord; value: unknown }[] = [];
    this.applying = true;
    try {
      for (const name of ['meta', 'folder', 'key', 'server', 'snippet', 'history', 'recent', 'known-host']) {
        const items = grouped.get(name);
        if (!items) continue;
        // known_hosts 不在前端，写成功了才记账（见下）
        if (name === 'known-host') {
          knownHostItems.push(...items);
          continue;
        }
        const changes = new Map<string, unknown | null>();
        for (const { r, value } of items) {
          if (value !== null && belowMark(name, value, st.marks)) continue;
          this.observe(st, r.hlc);
          ledgerSet(st.ledger, name, r.id, [r.hlc, value === null ? null : digest(value)]);
          this.pending.delete(pendingKey(name, r.id));
          changes.set(r.id, value);
        }
        if (changes.size) this.byName.get(name)!.write(changes);
      }
    } finally {
      this.applying = false;
    }
    // 前端数据和账本一起落盘，再去等保险箱的写入；那边失败时游标不往前走，下一轮重拉这一页
    this.persist();

    if (knownHostItems.length) {
      const current = await knownHostSnapshot(this.knownHosts);
      // 保险箱重建后的那次重拉：本机已有的是重建后存的，不让云端的覆盖或删掉，留给之后的比较推上去
      const items = st.secretsResync ? knownHostItems.filter(({ r }) => !current.has(r.id)) : knownHostItems;
      const changes = new Map<string, { line: string } | null>();
      for (const { r, value } of items) changes.set(r.id, value as { line: string } | null);
      await writeKnownHosts(this.knownHosts, changes, current);
      if (!this.alive(st)) return;
      for (const { r, value } of items) {
        this.observe(st, r.hlc);
        ledgerSet(st.ledger, 'known-host', r.id, [r.hlc, value === null ? null : digest(value)]);
        this.pending.delete(pendingKey('known-host', r.id));
      }
      this.persist();
      void this.refreshKnownHostCount();
    }

    // 机密：解密后直接写进保险箱。摘要由平台算（对原文的带钥匙哈希），写完重新取，不自己算
    const applied: PulledRecord[] = [];
    if (st.secretsResync && secretsIn.length) {
      // 同上：重建后本机已有的机密不碰，只补本机没有的
      const existing = new Set(Object.keys(await this.platform.secretDigests()));
      for (let i = secretsIn.length - 1; i >= 0; i--) if (existing.has(secretsIn[i]!.id)) secretsIn.splice(i, 1);
    }
    for (const r of secretsIn) {
      const ok = await this.platform.openSecret(r.id, aadFor(st.account, 'secret', r.id, r.hlc, r.deleted), r.data);
      if (ok) applied.push(r);
      else this.undecryptable = true;
    }
    if (applied.length) {
      const digests = await this.platform.secretDigests();
      if (!this.alive(st)) return;
      for (const r of applied) {
        this.observe(st, r.hlc);
        ledgerSet(st.ledger, 'secret', r.id, [r.hlc, r.deleted ? null : (digests[r.id] ?? null)]);
        this.pending.delete(pendingKey('secret', r.id));
      }
      this.persist();
    }
  }

  // ---------- 调度 ----------

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.timerAt = Infinity;
  }

  private schedule(ms: number): void {
    this.clearTimer();
    if (!this.started || !this.st || this.future || this.reloginNeeded) return;
    this.timerAt = this.now() + ms;
    this.timer = this.timers.set(() => {
      this.timer = null;
      this.timerAt = Infinity;
      void this.round(false);
    }, ms);
  }

  /** 本机改了：1.5 秒后推一次。出错退避期间不提前，正在同步时这一轮结束后看待上传再排 */
  private scheduleSoon(): void {
    if (!this.started || !this.st || this.reloginNeeded || this.failures > 0 || this.running) return;
    if (this.timerAt - this.now() > DEBOUNCE_MS) this.schedule(DEBOUNCE_MS);
  }

  /** 窗口回到前台、网络恢复：立刻一轮 */
  wake(reason: 'focus' | 'online'): void {
    if (!this.started || !this.st || this.reloginNeeded || this.future || this.running) return;
    if (reason === 'focus' && this.now() - this.lastRoundAt < FOCUS_THROTTLE_MS) return;
    this.schedule(0);
  }
}

function liveCount(book: Record<string, [string, string | null]> | undefined): number {
  return book ? Object.values(book).filter((e) => e[1] !== null).length : 0;
}

function sameCounts(a: SyncCounts, b: SyncCounts): boolean {
  return (Object.keys(a) as (keyof SyncCounts)[]).every((k) => a[k] === b[k]);
}
