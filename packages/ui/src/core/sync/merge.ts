import type { FolderRecord, HostsData, ServerRecord } from '../hosts-store';
import type { KeyRecord, KeysData } from '../key-library';
import type { Snippet } from '../snippets-store';
import { HISTORY_MAX, type HistoryEntry } from '../history-store';
import { RECENTS_MAX, type RecentEntry } from '../recents-store';
import { META_GROUPS, belowMark, isLive, stripServer } from './collections';
import { digest } from './digest';
import { formatHlc } from './hlc';
import { emptyCounts, type SyncCounts } from './model';
import type { Marks } from './state';

// 第一次登录（账号里已有数据）时本机和云端的合并（docs/specs/sync.md「第一次同步和合并」第 3～6 步）。
// 纯函数：给本机数据和解密好的云端记录，算出合并后的本机数据、要挪的机密和完成框里的数字。
// 之后账本按云端记录建，再照常比一遍：本机赢的、本机独有的自然成为待上传。

/** 解密、校验过的云端记录。value 是 collections 的 parse 结果，墓碑为 null；机密不解密，带着密文给 openSecret */
export interface CloudRecord {
  collection: string;
  id: string;
  hlc: string;
  deleted: boolean;
  value: unknown;
  data: string;
}

export interface LocalData {
  hosts: HostsData;
  keys: KeysData;
  snippets: Snippet[];
  groups: string[];
  history: HistoryEntry[];
  recents: RecentEntry[];
  /** known_hosts：记录 id → 那一行 */
  knownHosts: Map<string, string>;
  /** 保险箱里要同步的条目 id */
  secretIds: string[];
}

export interface MergePlan {
  hosts: HostsData;
  keys: KeysData;
  snippets: Snippet[];
  groups: string[];
  history: HistoryEntry[];
  recents: RecentEntry[];
  knownHostsAdd: string[];
  knownHostsDrop: string[];
  marks: Marks;
  /** 写进本机保险箱的云端机密（云端赢），含本机也有的那几条的墓碑 */
  secretsFromCloud: CloudRecord[];
  /** 本机被去重掉的服务器、私钥名下的机密，挪到保留的那条名下 */
  secretMoves: { from: string; to: string }[];
  /** 云端那条已经有了，本机这份直接删掉 */
  secretDrops: string[];
  downloaded: SyncCounts;
  merged: SyncCounts;
}

function mapId(map: Map<string, string>, id: string | null): string | null {
  return id === null ? null : (map.get(id) ?? id);
}

/** 同一个 id 两边都有：本机记录用修改时间当毫秒、计数 0、本机设备 id 造一个时间戳，和云端的比 */
function resolveSameId(
  localSnap: unknown,
  localMs: number,
  cloud: CloudRecord,
  deviceId: string,
): 'local' | 'cloud' | 'same' | 'delete' {
  const localHlc = formatHlc(localMs, 0, deviceId);
  if (cloud.deleted) return localHlc > cloud.hlc ? 'local' : 'delete';
  if (digest(localSnap) === digest(cloud.value)) return 'same';
  return localHlc > cloud.hlc ? 'local' : 'cloud';
}

/** 比较服务器是否完全相同时用的样子：去掉 id、时间，引用换成去重后的 id；端口转发规则的 id 是内部编号，不比 */
function serverShape(s: ServerRecord | Omit<ServerRecord, 'lastConnectedAt'>, map: (id: string | null, kind: 'parent' | 'key' | 'jump') => string | null): unknown {
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = stripServer(s);
  return {
    ...rest,
    parentId: map(s.parentId, 'parent'),
    keyId: map(s.keyId, 'key'),
    advanced: { ...s.advanced, jumpServerId: map(s.advanced?.jumpServerId ?? null, 'jump') },
    forwards: (s.forwards ?? []).map(({ id: _fid, ...f }) => f),
  };
}

function byCollection(records: CloudRecord[]): Map<string, Map<string, CloudRecord>> {
  const out = new Map<string, Map<string, CloudRecord>>();
  for (const r of records) {
    let m = out.get(r.collection);
    if (!m) out.set(r.collection, (m = new Map()));
    const prev = m.get(r.id);
    if (!prev || r.hlc > prev.hlc) m.set(r.id, r);
  }
  return out;
}

function liveValues<T>(m: Map<string, CloudRecord> | undefined): T[] {
  return m ? [...m.values()].filter((r) => !r.deleted).map((r) => r.value as T) : [];
}

interface ListMerge<T extends { id: string }> {
  local: T[];
  cloud: Map<string, CloudRecord>;
  /** 被去重掉的本机记录 → 云端那条的 id */
  dropped: Map<string, string>;
  remap: (x: T) => T;
  /** 修改时间 */
  time: (x: T) => number;
  /** 摘要按什么算（服务器去掉 lastConnectedAt） */
  snap: (x: T) => unknown;
  /** 云端内容写进本机的样子；prev 是本机同 id 的那条 */
  fromCloud: (value: unknown, prev: T | undefined) => T;
  field: keyof SyncCounts;
  deviceId: string;
  downloaded: SyncCounts;
  merged: SyncCounts;
}

function mergeList<T extends { id: string }>(o: ListMerge<T>): T[] {
  const out: T[] = [];
  const localIds = new Set<string>();
  const targets = new Set(o.dropped.values());
  for (const x of o.local) {
    if (localIds.has(x.id)) continue;
    localIds.add(x.id);
    if (o.dropped.has(x.id)) {
      if (isLive(x)) o.merged[o.field]++;
      continue;
    }
    const v = o.remap(x);
    const c = o.cloud.get(x.id);
    if (!c) {
      out.push(v);
      continue;
    }
    const verdict = resolveSameId(o.snap(v), o.time(x), c, o.deviceId);
    if (verdict === 'local') out.push(v);
    else if (verdict === 'same') out.push(o.fromCloud(c.value, x));
    else if (verdict === 'cloud') {
      out.push(o.fromCloud(c.value, x));
      if (isLive(c.value)) o.downloaded[o.field]++;
    }
  }
  for (const c of o.cloud.values()) {
    if (c.deleted || localIds.has(c.id)) continue;
    out.push(o.fromCloud(c.value, undefined));
    if (!targets.has(c.id) && isLive(c.value)) o.downloaded[o.field]++;
  }
  return out;
}

/** 文件夹按深度排：父文件夹先去重，子文件夹拿映射后的父 id 去比 */
function depthOf(folders: FolderRecord[]): (f: FolderRecord) => number {
  const byId = new Map(folders.map((f) => [f.id, f]));
  return (f) => {
    let d = 0;
    let p = f.parentId;
    const seen = new Set<string>();
    while (p && byId.has(p) && !seen.has(p) && d < 64) {
      seen.add(p);
      d++;
      p = byId.get(p)!.parentId;
    }
    return d;
  };
}

export function planFirstMerge(local: LocalData, remote: CloudRecord[], deviceId: string): MergePlan {
  const cloud = byCollection(remote);
  const empty = new Map<string, CloudRecord>();
  const get = (c: string) => cloud.get(c) ?? empty;
  const downloaded = emptyCounts();
  const merged = emptyCounts();

  // ---------- 去重：只在两边都是现有的（不在回收站）记录之间比 ----------
  const folderMap = new Map<string, string>();
  const cloudFolders = liveValues<FolderRecord>(cloud.get('folder')).filter((f) => !f.deletedAt);
  const depth = depthOf(local.hosts.folders);
  const folderCandidates = local.hosts.folders.filter((f) => !f.deletedAt && !get('folder').has(f.id)).sort((a, b) => depth(a) - depth(b));
  for (const f of folderCandidates) {
    const parent = mapId(folderMap, f.parentId);
    const match = cloudFolders.find((c) => c.name === f.name && c.parentId === parent);
    if (match) folderMap.set(f.id, match.id);
  }

  // 私钥：公钥指纹和名称都相同
  const keyMap = new Map<string, string>();
  const cloudKeys = liveValues<KeyRecord>(cloud.get('key')).filter((k) => !k.deletedAt);
  for (const k of local.keys.keys) {
    if (k.deletedAt || !k.fingerprint || get('key').has(k.id)) continue;
    const match = cloudKeys.find((c) => c.fingerprint === k.fingerprint && c.name === k.name);
    if (match) keyMap.set(k.id, match.id);
  }

  // 服务器：除 id、创建 / 修改时间、上次连接时间以外的字段全部相同（引用按去重后的 id 比），有一处不同就两份都留。
  // 跳板机指向的服务器可能在后面才去重，所以反复比到没有新的为止
  const serverMap = new Map<string, string>();
  const cloudServers = liveValues<ServerRecord>(cloud.get('server')).filter((s) => !s.deletedAt);
  const cloudShapes = cloudServers.map((c) => ({ id: c.id, d: digest(serverShape(c, (x) => x)) }));
  const localCandidates = local.hosts.servers.filter((s) => !s.deletedAt && !get('server').has(s.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of localCandidates) {
      if (serverMap.has(s.id)) continue;
      const d = digest(serverShape(s, (x, kind) => mapId(kind === 'parent' ? folderMap : kind === 'key' ? keyMap : serverMap, x)));
      const match = cloudShapes.find((c) => c.d === d);
      if (match) {
        serverMap.set(s.id, match.id);
        grew = true;
      }
    }
  }

  const snippetMap = new Map<string, string>();
  const cloudSnippets = liveValues<Snippet>(cloud.get('snippet'));
  for (const s of local.snippets) {
    if (get('snippet').has(s.id)) continue;
    const match = cloudSnippets.find((c) => c.name === s.name && c.cmd === s.cmd && c.group === s.group && !!c.noEnter === !!s.noEnter);
    if (match) snippetMap.set(s.id, match.id);
  }

  // ---------- 合并后的本机数据 ----------
  const common = { deviceId, downloaded, merged };

  const folders = mergeList<FolderRecord>({
    ...common,
    local: local.hosts.folders,
    cloud: get('folder'),
    dropped: folderMap,
    remap: (f) => {
      const parentId = mapId(folderMap, f.parentId);
      return parentId === f.parentId ? f : { ...f, parentId };
    },
    time: (f) => f.updatedAt,
    snap: (f) => f,
    fromCloud: (v) => v as FolderRecord,
    field: 'folders',
  });

  // 被合并掉的服务器的“上次连接时间”留给云端那台
  const lastConnected = new Map<string, number>();
  for (const s of local.hosts.servers) {
    const target = serverMap.get(s.id);
    if (target && s.lastConnectedAt) lastConnected.set(target, Math.max(lastConnected.get(target) ?? 0, s.lastConnectedAt));
  }
  const servers = mergeList<ServerRecord>({
    ...common,
    local: local.hosts.servers,
    cloud: get('server'),
    dropped: serverMap,
    remap: (s) => {
      const parentId = mapId(folderMap, s.parentId);
      const keyId = mapId(keyMap, s.keyId);
      const jump = s.advanced?.jumpServerId ?? null;
      const jumpServerId = mapId(serverMap, jump);
      if (parentId === s.parentId && keyId === s.keyId && jumpServerId === jump) return s;
      return { ...s, parentId, keyId, advanced: { ...s.advanced, jumpServerId } };
    },
    time: (s) => s.updatedAt,
    snap: (s) => stripServer(s),
    fromCloud: (v, prev) => {
      const s = v as Omit<ServerRecord, 'lastConnectedAt'>;
      return { ...s, lastConnectedAt: prev?.lastConnectedAt ?? lastConnected.get(s.id) ?? null };
    },
    field: 'servers',
  });

  const keys = mergeList<KeyRecord>({
    ...common,
    local: local.keys.keys,
    cloud: get('key'),
    dropped: keyMap,
    remap: (k) => k,
    time: (k) => k.updatedAt,
    snap: (k) => k,
    fromCloud: (v) => v as KeyRecord,
    field: 'keys',
  });

  const snippets = mergeList<Snippet>({
    ...common,
    local: local.snippets,
    cloud: get('snippet'),
    dropped: snippetMap,
    remap: (s) => s,
    time: (s) => s.updatedAt,
    snap: (s) => s,
    fromCloud: (v) => v as Snippet,
    field: 'snippets',
  });

  // ---------- meta：水位线用云端的；分类清单取并集，云端的顺序在前 ----------
  const marks: Marks = {};
  for (const id of ['history-cleared', 'recents-cleared'] as const) {
    const r = get('meta').get(id);
    const at = (r?.value as { at?: number } | null)?.at;
    if (r && !r.deleted && typeof at === 'number') marks[id] = at;
  }
  const cloudGroups = get('meta').get(META_GROUPS);
  const groups = [...new Set([...((!cloudGroups?.deleted && (cloudGroups?.value as string[] | null)) || []), ...local.groups])];

  // ---------- 历史：按 id 合起来，同 id 用 at 比；丢掉水位线以前的，裁到上限 ----------
  const historyById = new Map<string, HistoryEntry>();
  for (const h of local.history) if (!historyById.has(h.id)) historyById.set(h.id, h);
  const fromCloudHistory = new Set<string>();
  for (const c of get('history').values()) {
    if (c.deleted) continue;
    const v = c.value as HistoryEntry;
    const l = historyById.get(c.id);
    if (!l) fromCloudHistory.add(c.id);
    if (!l || (digest(l) !== digest(v) && formatHlc(l.at, 0, deviceId) <= c.hlc)) historyById.set(c.id, v);
  }
  const history = [...historyById.values()]
    .filter((h) => !belowMark('history', h, marks))
    .sort((a, b) => b.at - a.at)
    .slice(0, HISTORY_MAX);
  downloaded.history = history.filter((h) => fromCloudHistory.has(h.id)).length;

  // ---------- 最近连接：服务器 id 跟着去重改；同一台留新的 ----------
  const recentAt = new Map<string, number>();
  for (const r of local.recents) {
    const serverId = mapId(serverMap, r.serverId)!;
    recentAt.set(serverId, Math.max(recentAt.get(serverId) ?? 0, r.at));
  }
  const fromCloudRecent = new Set<string>();
  for (const c of get('recent').values()) {
    if (c.deleted) continue;
    const at = (c.value as { at: number }).at;
    const l = recentAt.get(c.id);
    if (l === undefined) fromCloudRecent.add(c.id);
    if (l === undefined || (l !== at && formatHlc(l, 0, deviceId) <= c.hlc)) recentAt.set(c.id, at);
  }
  const recents = [...recentAt]
    .map(([serverId, at]) => ({ serverId, at }))
    .filter((r) => !belowMark('recent', r, marks))
    .sort((a, b) => b.at - a.at)
    .slice(0, RECENTS_MAX);
  downloaded.recents = recents.filter((r) => fromCloudRecent.has(r.serverId)).length;

  // ---------- known_hosts：同一行 id 一样，天然去重；没有修改时间，云端的墓碑赢 ----------
  const knownHostsAdd: string[] = [];
  const knownHostsDrop: string[] = [];
  for (const c of get('known-host').values()) {
    const mine = local.knownHosts.get(c.id);
    if (c.deleted) {
      if (mine !== undefined) knownHostsDrop.push(mine);
    } else if (mine === undefined) {
      knownHostsAdd.push((c.value as { line: string }).line);
      downloaded.knownHosts++;
    }
  }

  // ---------- 机密：没有修改时间，同 id 云端赢；去重掉的记录名下的挪过去 ----------
  const localSecrets = new Set(local.secretIds);
  const cloudSecrets = get('secret');
  const secretsFromCloud = [...cloudSecrets.values()].filter((c) => !c.deleted || localSecrets.has(c.id));
  const secretMoves: { from: string; to: string }[] = [];
  const secretDrops: string[] = [];
  const claimed = new Set<string>();
  for (const id of local.secretIds) {
    const dot = id.indexOf('.');
    if (dot <= 0) continue;
    const owner = id.slice(0, dot);
    const target = serverMap.get(owner) ?? keyMap.get(owner);
    if (!target) continue;
    const to = `${target}${id.slice(dot)}`;
    const cloudHas = cloudSecrets.get(to);
    if ((cloudHas && !cloudHas.deleted) || localSecrets.has(to) || claimed.has(to)) secretDrops.push(id);
    else {
      secretMoves.push({ from: id, to });
      claimed.add(to);
    }
  }

  return {
    hosts: { ...local.hosts, folders, servers },
    keys: { ...local.keys, keys },
    snippets,
    groups,
    history,
    recents,
    knownHostsAdd,
    knownHostsDrop,
    marks,
    secretsFromCloud,
    secretMoves,
    secretDrops,
    downloaded,
    merged,
  };
}
