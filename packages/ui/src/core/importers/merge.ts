import { DEFAULT_ADVANCED, type FolderRecord, type HostsData, type ServerRecord } from '../hosts-store';
import { newId } from '../storage';
import type { ImportedServer, ImportResult } from './types';

// 把解析结果合并进 HostsData。纯函数：输入旧数据和选项，输出新数据和统计，不碰 store。

export type DuplicatePolicy = 'skip' | 'overwrite' | 'keepBoth';

/** 导入位置：根目录下新建一个文件夹，或直接放到根目录 */
export type ImportTarget = { kind: 'folder'; name: string } | { kind: 'root' };

export interface MergeOptions {
  /** 选中的连接 / 文件夹 id（解析结果里的本地 id） */
  selected: ReadonlySet<string>;
  policy: DuplicatePolicy;
  target: ImportTarget;
  now?: number;
}

export interface MergeOutcome {
  data: HostsData;
  added: number;
  folders: number;
  overwritten: number;
  skipped: number;
  /** 需要存进保险箱的密码；由调用方决定能不能存 */
  passwords: { serverId: string; password: string }[];
}

/** 一个导入文件夹最终落在哪：复用现有文件夹（existing），还是要新建（isNew） */
interface Dest {
  id: string;
  isNew: boolean;
}

const live = <T extends { deletedAt: number | null }>(xs: T[]) => xs.filter((x) => !x.deletedAt);

function childFolder(folders: FolderRecord[], parentId: string | null, name: string): FolderRecord | undefined {
  return folders.find((f) => f.parentId === parentId && f.name === name);
}

/**
 * 导入文件夹 id（null 代表解析结果的根）→ 目标位置（null 代表 EverShell 的根目录）。
 * 同一父级下同名的现有文件夹直接复用，所以重复导入不会堆出一串同名文件夹。
 */
function placeFolders(data: HostsData, result: ImportResult, target: ImportTarget): Map<string | null, Dest | null> {
  const folders = live(data.folders);
  const dest = new Map<string | null, Dest | null>();
  if (target.kind === 'folder') {
    const existing = childFolder(folders, null, target.name);
    dest.set(null, existing ? { id: existing.id, isNew: false } : { id: 'new:root', isNew: true });
  } else {
    dest.set(null, null);
  }
  // 上级先定位，下级后定位
  const pending = [...result.folders];
  let progressed = true;
  while (pending.length > 0 && progressed) {
    progressed = false;
    for (let i = 0; i < pending.length; i++) {
      const f = pending[i]!;
      if (!dest.has(f.parentId)) continue;
      const parent = dest.get(f.parentId)!;
      if (parent?.isNew) dest.set(f.id, { id: `new:${f.id}`, isNew: true });
      else {
        const existing = childFolder(folders, parent?.id ?? null, f.name);
        dest.set(f.id, existing ? { id: existing.id, isNew: false } : { id: `new:${f.id}`, isNew: true });
      }
      pending.splice(i--, 1);
      progressed = true;
    }
  }
  for (const f of pending) dest.set(f.id, { id: `new:${f.id}`, isNew: true });
  return dest;
}

/** 重名判定：同主机 + 端口 + 用户名，或目标文件夹里已有同名连接 */
export function findDuplicates(data: HostsData, result: ImportResult, target: ImportTarget): Map<string, ServerRecord> {
  const servers = live(data.servers);
  const dest = placeFolders(data, result, target);
  const out = new Map<string, ServerRecord>();
  for (const s of result.servers) {
    const d = dest.get(s.parentId) ?? null;
    const folderId = d && !d.isNew ? d.id : d === null ? null : undefined;
    const hit = servers.find(
      (e) =>
        (e.host.toLowerCase() === s.host.toLowerCase() && e.port === s.port && e.user === s.user) ||
        (folderId !== undefined && e.parentId === folderId && e.name === s.name),
    );
    if (hit) out.set(s.id, hit);
  }
  return out;
}

function toRecord(s: ImportedServer, parentId: string | null, now: number): ServerRecord {
  return {
    id: newId('srv'),
    parentId,
    name: s.name,
    host: s.host,
    port: s.port,
    user: s.user,
    note: s.note,
    proto: s.proto,
    auth: s.auth,
    keyLabel: s.keyLabel,
    advanced: { ...DEFAULT_ADVANCED, ...(s.advanced ?? {}) },
    forwards: s.forwards ?? [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    lastConnectedAt: null,
  };
}

export function mergeImport(data: HostsData, result: ImportResult, opts: MergeOptions): MergeOutcome {
  const now = opts.now ?? Date.now();
  const dest = placeFolders(data, result, opts.target);
  const duplicates = findDuplicates(data, result, opts.target);
  const folders = [...data.folders];
  const servers = [...data.servers];
  const passwords: MergeOutcome['passwords'] = [];
  let added = 0;
  let overwritten = 0;
  let skipped = 0;

  // 先决定每台服务器怎么处理，再按需建文件夹，避免留下空文件夹
  const toAdd: ImportedServer[] = [];
  /** 导入 id → 最终落到的记录 id（新建、覆盖或跳过时的现有记录），用来换算跳板机引用 */
  const realServerId = new Map<string, string>();
  for (const s of result.servers) {
    if (!opts.selected.has(s.id)) continue;
    const dup = duplicates.get(s.id);
    if (dup && opts.policy === 'skip') {
      realServerId.set(s.id, dup.id);
      skipped++;
      continue;
    }
    if (dup && opts.policy === 'overwrite') {
      realServerId.set(s.id, dup.id);
      const idx = servers.findIndex((e) => e.id === dup.id);
      servers[idx] = {
        ...dup,
        name: s.name,
        host: s.host,
        port: s.port,
        user: s.user,
        note: s.note || dup.note,
        proto: s.proto,
        auth: s.auth,
        keyLabel: s.keyLabel ?? dup.keyLabel,
        advanced: { ...dup.advanced, ...(s.advanced ?? {}) },
        forwards: s.forwards && s.forwards.length > 0 ? s.forwards : dup.forwards,
        updatedAt: now,
      };
      if (s.password !== null) passwords.push({ serverId: dup.id, password: s.password });
      overwritten++;
      continue;
    }
    toAdd.push(s);
  }

  // 需要的文件夹：要新增的连接的所有上级，加上被选中且本来就没有连接的空文件夹
  //（里面的连接全被当作重名跳过的文件夹不建，免得留下空壳）
  const needed = new Set<string>();
  const byId = new Map(result.folders.map((f) => [f.id, f]));
  const needChain = (id: string | null) => {
    for (let cur = id; cur && !needed.has(cur); cur = byId.get(cur)?.parentId ?? null) needed.add(cur);
  };
  const withServers = new Set<string>();
  for (const s of result.servers) for (let cur = s.parentId; cur; cur = byId.get(cur)?.parentId ?? null) withServers.add(cur);
  for (const f of result.folders) if (opts.selected.has(f.id) && !withServers.has(f.id)) needChain(f.id);
  for (const s of toAdd) needChain(s.parentId);

  // 建文件夹：把 Dest 换成真正的 id
  const realId = new Map<string, string>();
  let createdFolders = 0;
  const materialize = (importedId: string | null): string | null => {
    const d = dest.get(importedId) ?? null;
    if (d === null) return null;
    if (!d.isNew) return d.id;
    const cached = realId.get(d.id);
    if (cached) return cached;
    const f = importedId === null ? null : byId.get(importedId);
    const parentId = f ? materialize(f.parentId) : null;
    const name = f ? f.name : opts.target.kind === 'folder' ? opts.target.name : '';
    const record: FolderRecord = { id: newId('dir'), name, parentId, createdAt: now, updatedAt: now, deletedAt: null };
    folders.push(record);
    realId.set(d.id, record.id);
    createdFolders++;
    return record.id;
  };
  // 按上级在前的顺序建，保证父子顺序和 result.folders 一致
  for (const f of result.folders) if (needed.has(f.id)) materialize(f.id);

  for (const s of toAdd) {
    const record = toRecord(s, materialize(s.parentId), now);
    servers.push(record);
    realServerId.set(s.id, record.id);
    if (s.password !== null) passwords.push({ serverId: record.id, password: s.password });
    added++;
  }

  // 跳板机引用指向的是导入结果里的本地 id，换成真正的 id；指不到的清掉
  const touched = new Set(realServerId.values());
  for (let i = 0; i < servers.length; i++) {
    const s = servers[i]!;
    const jump = s.advanced.jumpServerId;
    if (!touched.has(s.id) || !jump || servers.some((e) => e.id === jump && !touched.has(e.id))) continue;
    servers[i] = { ...s, advanced: { ...s.advanced, jumpServerId: realServerId.get(jump) ?? null } };
  }

  return { data: { version: 1, folders, servers }, added, folders: createdFolders, overwritten, skipped, passwords };
}
