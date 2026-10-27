import type { Store } from '../store';
import { DEFAULT_ADVANCED, type FolderRecord, type HostsData, type ServerRecord } from '../hosts-store';
import type { KeyRecord, KeysData } from '../key-library';
import { DEFAULT_GROUP, type Snippet } from '../snippets-store';
import { HISTORY_MAX, type HistoryEntry } from '../history-store';
import { RECENTS_MAX, type RecentEntry } from '../recents-store';
import { knownHostId } from './digest';
import type { SyncCounts } from './model';
import type { Marks } from './state';

// 每样数据是一个“集合”（docs/specs/sync.md「同步什么」）。这里是各集合和现有存储之间的适配：
// 读出 id → 内容、校验远端内容、写入一批。机密（secret）不经前端，由引擎直接调平台接口，不在这里。

/** 引擎用到的几份数据。正式的是 core/ 里的单例，测试里每个模拟客户端各建一套 */
export interface SyncStores {
  hosts: Store<HostsData>;
  keys: Store<KeysData>;
  snippets: Store<Snippet[]>;
  groups: Store<string[]>;
  history: Store<HistoryEntry[]>;
  recents: Store<RecentEntry[]>;
}

export type StoreName = keyof SyncStores;

/** known_hosts 的读写，正式的是 KnownHostsStore */
export interface KnownHostLines {
  lines(): Promise<string[]>;
  editLines(edit: (lines: string[]) => string[]): Promise<void>;
}

/** 推送、应用时的先后：文件夹、私钥在服务器前面，水位线（meta）在历史前面也无妨，应用时单独先处理 */
export const COLLECTIONS = ['folder', 'key', 'server', 'secret', 'snippet', 'known-host', 'history', 'recent', 'meta'] as const;
export type CollectionName = (typeof COLLECTIONS)[number];
/** 上面这张表改了（加了集合）就加一：旧版本跳过的不认识的记录，升级后游标归零重新拉一遍才拿得到 */
export const COLLECTIONS_VERSION = 1;

export function isCollection(name: string): name is CollectionName {
  return (COLLECTIONS as readonly string[]).includes(name);
}

/** 内容在前端、能直接读写的集合 */
export interface PlainCollection {
  readonly name: CollectionName;
  /** 这几份数据变了要重新比一遍 */
  readonly stores: readonly StoreName[];
  /** 删除发不发墓碑：历史、最近连接挤出去不算删除 */
  readonly tombstones: boolean;
  /** 当前每条要同步的内容（摘要就按它算） */
  snapshot(): Map<string, unknown>;
  /** 校验解密出来的远端内容，返回写进本机后 snapshot 会读出的样子；不认识返回 null */
  parse(id: string, raw: unknown): unknown | null;
  /** 写入一批，值为 null 是删除 */
  write(changes: Map<string, unknown | null>): void;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function numOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 按 id 改一份列表：有的原位替换，null 的删掉，没有的追加在后面 */
export function upsertById<T extends { id: string }>(list: T[], changes: Map<string, T | null>): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of list) {
    if (!changes.has(item.id)) {
      out.push(item);
      continue;
    }
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const next = changes.get(item.id);
    if (next) out.push(next);
  }
  for (const [id, next] of changes) if (next && !seen.has(id)) out.push(next);
  return out;
}

/** 服务器记录里不同步的字段：每连一次就变，留在本机 */
export function stripServer(s: ServerRecord | Obj): Omit<ServerRecord, 'lastConnectedAt'> {
  const { lastConnectedAt: _skip, ...rest } = s as ServerRecord;
  return rest;
}

function parseFolder(id: string, raw: unknown): FolderRecord | null {
  if (!isObj(raw) || raw.id !== id || typeof raw.name !== 'string') return null;
  return {
    ...(raw as unknown as FolderRecord),
    parentId: strOrNull(raw.parentId),
    createdAt: numOr(raw.createdAt, 0),
    updatedAt: numOr(raw.updatedAt, 0),
    deletedAt: numOrNull(raw.deletedAt),
  };
}

function parseServer(id: string, raw: unknown): Omit<ServerRecord, 'lastConnectedAt'> | null {
  if (!isObj(raw) || raw.id !== id || typeof raw.host !== 'string') return null;
  // 字段补齐照 hosts-store 的 normalize，免得别的版本少了字段界面出错
  return stripServer({
    ...(raw as unknown as ServerRecord),
    parentId: strOrNull(raw.parentId),
    name: str(raw.name, raw.host),
    port: numOr(raw.port, 22) || 22,
    user: str(raw.user),
    note: str(raw.note),
    proto: raw.proto === 'rdp' ? 'rdp' : 'ssh',
    auth: raw.auth === 'key' ? 'key' : 'password',
    keyId: strOrNull(raw.keyId),
    keyLabel: strOrNull(raw.keyLabel),
    advanced: { ...DEFAULT_ADVANCED, ...(isObj(raw.advanced) ? raw.advanced : {}) },
    forwards: Array.isArray(raw.forwards) ? (raw.forwards as ServerRecord['forwards']) : [],
    createdAt: numOr(raw.createdAt, 0),
    updatedAt: numOr(raw.updatedAt, 0),
    deletedAt: numOrNull(raw.deletedAt),
  });
}

function parseKey(id: string, raw: unknown): KeyRecord | null {
  if (!isObj(raw) || raw.id !== id || typeof raw.name !== 'string') return null;
  return {
    ...(raw as unknown as KeyRecord),
    algorithm: str(raw.algorithm),
    bits: numOr(raw.bits, 0),
    fingerprint: strOrNull(raw.fingerprint),
    createdAt: numOr(raw.createdAt, 0),
    updatedAt: numOr(raw.updatedAt, 0),
    deletedAt: numOrNull(raw.deletedAt),
  };
}

function parseSnippet(id: string, raw: unknown): Snippet | null {
  if (!isObj(raw) || raw.id !== id || typeof raw.cmd !== 'string') return null;
  const { noEnter, ...rest } = raw as unknown as Snippet;
  const group = typeof raw.group === 'string' && raw.group.trim() ? raw.group : DEFAULT_GROUP;
  return { ...rest, name: str(raw.name), group, updatedAt: numOr(raw.updatedAt, 0), ...(noEnter === true ? { noEnter } : {}) };
}

function parseHistory(id: string, raw: unknown): HistoryEntry | null {
  if (!isObj(raw) || raw.id !== id || typeof raw.cmd !== 'string' || numOrNull(raw.at) === null) return null;
  return { ...(raw as unknown as HistoryEntry), target: str(raw.target) };
}

function parseAt(raw: unknown): { at: number } | null {
  if (!isObj(raw)) return null;
  const at = numOrNull(raw.at);
  return at === null ? null : { at };
}

export function parseGroups(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  return [...new Set(raw.filter((g): g is string => typeof g === 'string' && g.trim() !== ''))];
}

/** 历史、最近连接按时间新的在前排好，裁到本机上限 */
function sortByAtDesc<T extends { at: number }>(list: T[], max: number): T[] {
  return [...list].sort((a, b) => b.at - a.at).slice(0, max);
}

/** 水位线读写：存在同步状态里，引擎给 */
export interface MarksAccess {
  get(): Marks;
  set(name: keyof Marks, at: number): void;
}

export const META_GROUPS = 'snippet-groups';
export const MARK_IDS = ['history-cleared', 'recents-cleared'] as const;

export function plainCollections(stores: SyncStores, marks: MarksAccess): PlainCollection[] {
  const folder: PlainCollection = {
    name: 'folder',
    stores: ['hosts'],
    tombstones: true,
    snapshot: () => new Map(stores.hosts.get().folders.map((f) => [f.id, f])),
    parse: parseFolder,
    write(changes) {
      stores.hosts.set((d) => ({ ...d, folders: upsertById(d.folders, changes as Map<string, FolderRecord | null>) }));
    },
  };

  const server: PlainCollection = {
    name: 'server',
    stores: ['hosts'],
    tombstones: true,
    snapshot: () => new Map(stores.hosts.get().servers.map((s) => [s.id, stripServer(s)])),
    parse: parseServer,
    write(changes) {
      stores.hosts.set((d) => {
        const before = new Map(d.servers.map((s) => [s.id, s.lastConnectedAt]));
        // 远端记录不含 lastConnectedAt，保留本机的值
        const full = new Map<string, ServerRecord | null>();
        for (const [id, v] of changes) full.set(id, v ? { ...(v as ServerRecord), lastConnectedAt: before.get(id) ?? null } : null);
        return { ...d, servers: upsertById(d.servers, full) };
      });
    },
  };

  const key: PlainCollection = {
    name: 'key',
    stores: ['keys'],
    tombstones: true,
    snapshot: () => new Map(stores.keys.get().keys.map((k) => [k.id, k])),
    parse: parseKey,
    write(changes) {
      stores.keys.set((d) => ({ ...d, keys: upsertById(d.keys, changes as Map<string, KeyRecord | null>) }));
    },
  };

  const snippet: PlainCollection = {
    name: 'snippet',
    stores: ['snippets'],
    tombstones: true,
    snapshot: () => new Map(stores.snippets.get().map((s) => [s.id, s])),
    parse: parseSnippet,
    write(changes) {
      stores.snippets.set((list) => upsertById(list, changes as Map<string, Snippet | null>));
    },
  };

  const history: PlainCollection = {
    name: 'history',
    stores: ['history'],
    tombstones: false,
    snapshot: () => {
      const out = new Map<string, unknown>();
      for (const h of stores.history.get()) if (!out.has(h.id)) out.set(h.id, h);
      return out;
    },
    parse: parseHistory,
    write(changes) {
      stores.history.set((list) => sortByAtDesc(upsertById(list, changes as Map<string, HistoryEntry | null>), HISTORY_MAX));
    },
  };

  const recent: PlainCollection = {
    name: 'recent',
    stores: ['recents'],
    tombstones: false,
    snapshot: () => {
      const out = new Map<string, unknown>();
      for (const r of stores.recents.get()) if (!out.has(r.serverId)) out.set(r.serverId, { at: r.at });
      return out;
    },
    parse: (_id, raw) => parseAt(raw),
    write(changes) {
      stores.recents.set((list) => {
        const kept = list.filter((r) => !changes.has(r.serverId));
        for (const [serverId, v] of changes) if (v) kept.push({ serverId, at: (v as { at: number }).at });
        return sortByAtDesc(kept, RECENTS_MAX);
      });
    },
  };

  const meta: PlainCollection = {
    name: 'meta',
    stores: ['groups'],
    tombstones: false,
    snapshot: () => {
      const out = new Map<string, unknown>([[META_GROUPS, stores.groups.get()]]);
      const m = marks.get();
      for (const id of MARK_IDS) if (m[id] !== undefined) out.set(id, { at: m[id] });
      return out;
    },
    parse: (id, raw) => (id === META_GROUPS ? parseGroups(raw) : (MARK_IDS as readonly string[]).includes(id) ? parseAt(raw) : null),
    write(changes) {
      for (const [id, v] of changes) {
        // meta 不删
        if (v === null) continue;
        if (id === META_GROUPS) stores.groups.set(v as string[]);
        else if (id === 'history-cleared' || id === 'recents-cleared') applyMark(stores, marks, id, (v as { at: number }).at);
      }
    },
  };

  return [folder, key, server, snippet, history, recent, meta];
}

/** 记下水位线，并丢掉本机早于它（含）的记录 */
export function applyMark(stores: SyncStores, marks: MarksAccess, id: keyof Marks, at: number): void {
  marks.set(id, at);
  if (id === 'history-cleared') stores.history.set((list) => (list.some((h) => h.at <= at) ? list.filter((h) => h.at > at) : list));
  else stores.recents.set((list) => (list.some((r) => r.at <= at) ? list.filter((r) => r.at > at) : list));
}

/** 远端的历史、最近连接是不是早于水位线，早于的不要 */
export function belowMark(collection: string, value: unknown, marks: Marks): boolean {
  const at = (value as { at?: number } | null)?.at;
  if (typeof at !== 'number') return false;
  if (collection === 'history') return marks['history-cleared'] !== undefined && at <= marks['history-cleared'];
  if (collection === 'recent') return marks['recents-cleared'] !== undefined && at <= marks['recents-cleared'];
  return false;
}

// ---------- known_hosts：按行 ----------

export function parseKnownHost(raw: unknown): { line: string } | null {
  if (!isObj(raw) || typeof raw.line !== 'string' || raw.line.includes('\n') || raw.line.trim() === '') return null;
  return { line: raw.line };
}

export async function knownHostSnapshot(src: KnownHostLines): Promise<Map<string, { line: string }>> {
  const out = new Map<string, { line: string }>();
  for (const line of await src.lines()) {
    const id = await knownHostId(line);
    if (!out.has(id)) out.set(id, { line });
  }
  return out;
}

/** 删掉一些行、加上一些行（已有的不重复加）。删除按行的原文找，所以要给当前的 id → 行 */
export async function writeKnownHosts(
  src: KnownHostLines,
  changes: Map<string, { line: string } | null>,
  current: Map<string, { line: string }>,
): Promise<void> {
  const drop = new Set<string>();
  const add: string[] = [];
  for (const [id, v] of changes) {
    if (v) add.push(v.line);
    else {
      const line = current.get(id)?.line;
      if (line !== undefined) drop.add(line);
    }
  }
  if (!drop.size && !add.length) return;
  await src.editLines((lines) => {
    const out = lines.filter((l) => !drop.has(l));
    for (const l of add) if (!out.includes(l)) out.push(l);
    return out;
  });
}

// ---------- 条数 ----------

/** 本机现有的条数：服务器、文件夹、私钥不算回收站里的 */
export function countLocal(stores: SyncStores, knownHosts: number): SyncCounts {
  const hosts = stores.hosts.get();
  return {
    servers: hosts.servers.filter((s) => !s.deletedAt).length,
    folders: hosts.folders.filter((f) => !f.deletedAt).length,
    keys: stores.keys.get().keys.filter((k) => !k.deletedAt).length,
    snippets: stores.snippets.get().length,
    history: stores.history.get().length,
    recents: stores.recents.get().length,
    knownHosts,
  };
}

/** SyncCounts 里对应的那一项；机密、meta 不计数 */
export function countField(collection: string): keyof SyncCounts | null {
  switch (collection) {
    case 'server':
      return 'servers';
    case 'folder':
      return 'folders';
    case 'key':
      return 'keys';
    case 'snippet':
      return 'snippets';
    case 'history':
      return 'history';
    case 'recent':
      return 'recents';
    case 'known-host':
      return 'knownHosts';
    default:
      return null;
  }
}

/** 这条算不算“现有的”：回收站里的服务器、文件夹、私钥不算 */
export function isLive(value: unknown): boolean {
  return !(isObj(value) && typeof value.deletedAt === 'number');
}
