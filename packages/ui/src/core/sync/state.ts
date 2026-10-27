import { isDeviceId, isHlc, type ClockState } from './hlc';
import type { Ledger, LedgerEntry } from './ledger';

// 本机的同步状态，存在 evershell.sync.v1（docs/specs/sync.md「本机存储」）。没开同步时没有这个键，退出登录时删掉。
// 读到更高的 version 不同步、不写回（docs/handbook/data.md 的格式规则）。

export const STATE_KEY = 'evershell.sync.v1';
/** 登录令牌存在保险箱的这个条目里；sync. 开头的条目本身不同步 */
export const SESSION_SECRET = 'sync.session';

/** 「清空」的水位线：这之前（含）的历史、最近连接都算清空了。meta 集合的 history-cleared / recents-cleared 两条记录的内容 */
export interface Marks {
  'history-cleared'?: number;
  'recents-cleared'?: number;
}

export interface SyncStateV1 {
  version: 1;
  server: string;
  /** 规范化后的账号名（去掉首尾空白、转小写） */
  account: string;
  deviceId: string;
  deviceName: string;
  cursor: number;
  clock: ClockState;
  ledger: Ledger;
  pending: string[];
  lastSyncAt: number | null;
  marks: Marks;
  /** 登录时保险箱钥匙的校验值（SyncPlatform.keyCheck）。对不上说明保险箱重建过，停下来重新登录，不把“机密都没了”当成删除发出去 */
  keyCheck: string | null;
  /** 保险箱重建后重新登录：机密的账本已清空、游标归零，这一轮先拉云端的机密回来，拉完才比本机的 */
  secretsResync: boolean;
  /** 写这份状态的引擎认识的集合版本；升级后认识了新集合，游标归零，把旧版本跳过的记录补上 */
  collectionsVersion: number;
  /** 发现保险箱重建过、还没重新登录（重启后也记得，重新登录时据此先拉云端的） */
  vaultReset: boolean;
  /** 见过的最大的远端时间戳：拨回时钟时不拨到它以下，本机之后的改动才一定比已经拉到的新 */
  maxSeen: string | null;
}

/** 'future' 表示是更新版本的 EverShell 写的，看不懂，也不能覆盖 */
export type LoadedState = SyncStateV1 | 'future' | null;

/** 引擎读写同步状态的地方：正式用 PersistentStore，测试用内存 */
export interface StateHolder {
  load(): LoadedState;
  save(state: SyncStateV1): void;
  clear(): void;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function normalizeLedger(raw: unknown): Ledger {
  const out: Ledger = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [collection, book] of Object.entries(raw as Record<string, unknown>)) {
    if (!book || typeof book !== 'object') continue;
    const entries: Record<string, LedgerEntry> = {};
    for (const [id, e] of Object.entries(book as Record<string, unknown>)) {
      if (Array.isArray(e) && isHlc(e[0]) && (typeof e[1] === 'string' || e[1] === null)) entries[id] = [e[0], e[1]];
    }
    out[collection] = entries;
  }
  return out;
}

function normalizeMarks(raw: unknown): Marks {
  const out: Marks = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  const h = num(r['history-cleared']);
  const c = num(r['recents-cleared']);
  if (h !== null) out['history-cleared'] = h;
  if (c !== null) out['recents-cleared'] = c;
  return out;
}

export function normalizeState(raw: unknown): LoadedState {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const version = num(r.version);
  if (version !== null && version > 1) return 'future';
  if (version !== 1) return null;
  if (typeof r.server !== 'string' || typeof r.account !== 'string' || !isDeviceId(r.deviceId)) return null;
  const clock = (r.clock ?? {}) as Record<string, unknown>;
  return {
    version: 1,
    server: r.server,
    account: r.account,
    deviceId: r.deviceId,
    deviceName: typeof r.deviceName === 'string' ? r.deviceName : '',
    cursor: Math.max(0, num(r.cursor) ?? 0),
    clock: { ms: num(clock.ms) ?? 0, c: num(clock.c) ?? 0 },
    ledger: normalizeLedger(r.ledger),
    pending: Array.isArray(r.pending) ? r.pending.filter((p): p is string => typeof p === 'string') : [],
    lastSyncAt: num(r.lastSyncAt),
    marks: normalizeMarks(r.marks),
    keyCheck: typeof r.keyCheck === 'string' ? r.keyCheck : null,
    secretsResync: r.secretsResync === true,
    collectionsVersion: num(r.collectionsVersion) ?? 0,
    vaultReset: r.vaultReset === true,
    maxSeen: isHlc(r.maxSeen) ? r.maxSeen : null,
  };
}

export function newState(opts: {
  server: string;
  account: string;
  deviceId: string;
  deviceName: string;
  keyCheck: string | null;
  collectionsVersion: number;
}): SyncStateV1 {
  return {
    version: 1,
    ...opts,
    cursor: 0,
    clock: { ms: 0, c: 0 },
    ledger: {},
    pending: [],
    lastSyncAt: null,
    marks: {},
    secretsResync: false,
    vaultReset: false,
    maxSeen: null,
  };
}

/** 测试和“重启”模拟用：存成 JSON 字符串，读的时候走同一个 normalize */
export class MemoryStateHolder implements StateHolder {
  json: string | null = null;

  load(): LoadedState {
    if (this.json == null) return null;
    try {
      return normalizeState(JSON.parse(this.json));
    } catch {
      return null;
    }
  }

  save(state: SyncStateV1): void {
    this.json = JSON.stringify(state);
  }

  clear(): void {
    this.json = null;
  }
}
