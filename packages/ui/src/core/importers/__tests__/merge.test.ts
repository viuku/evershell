import { describe, expect, it } from 'vitest';
import { DEFAULT_ADVANCED, type FolderRecord, type HostsData, type ServerRecord } from '../../hosts-store';
import { findDuplicates, mergeImport, type MergeOptions } from '../merge';
import type { ImportResult } from '../types';

const T = 1_700_000_000_000;

function folder(id: string, name: string, parentId: string | null = null): FolderRecord {
  return { id, name, parentId, createdAt: T, updatedAt: T, deletedAt: null };
}

function server(id: string, p: Partial<ServerRecord>): ServerRecord {
  return {
    id,
    parentId: null,
    name: id,
    host: '192.0.2.1',
    port: 22,
    user: 'root',
    note: '',
    proto: 'ssh',
    auth: 'password',
    keyLabel: null,
    advanced: { ...DEFAULT_ADVANCED },
    forwards: [],
    createdAt: T,
    updatedAt: T,
    deletedAt: null,
    lastConnectedAt: null,
    ...p,
  };
}

/** 现有数据：根下文件夹“生产”，里面 web-01；根下 solo；一台已删除的 ghost */
const existing: HostsData = {
  version: 1,
  folders: [folder('dirA', '生产')],
  servers: [
    server('srvA', { parentId: 'dirA', name: 'web-01', host: '192.0.2.10', user: 'deploy', note: '旧备注' }),
    server('srvB', { name: 'solo', host: '203.0.113.1' }),
    server('ghost', { name: 'ghost', host: '203.0.113.99', deletedAt: T }),
  ],
};

/** 解析结果：文件夹 生产 > 华东、生产 > 空的；s1 在华东（和 srvA 同主机），s2 根目录（和 solo 同名），s3 新的，s4 和 ghost 同主机 */
const result: ImportResult = {
  source: 'finalshell',
  folders: [
    { id: 'f1', parentId: null, name: '生产' },
    { id: 'f2', parentId: 'f1', name: '华东' },
    { id: 'f3', parentId: 'f1', name: '空的' },
  ],
  servers: [
    { id: 's1', parentId: 'f2', name: 'web-01-new', host: '192.0.2.10', port: 22, user: 'deploy', note: '新备注', proto: 'ssh', auth: 'password', keyLabel: null, password: 'pw1' },
    { id: 's2', parentId: null, name: 'solo', host: '203.0.113.2', port: 22, user: 'root', note: '', proto: 'ssh', auth: 'password', keyLabel: null, password: null },
    { id: 's3', parentId: 'f1', name: 'db-01', host: '198.51.100.20', port: 2222, user: 'dbadmin', note: '', proto: 'ssh', auth: 'password', keyLabel: null, password: 'pw3' },
    { id: 's4', parentId: null, name: 'ghost2', host: '203.0.113.99', port: 22, user: 'root', note: '', proto: 'ssh', auth: 'password', keyLabel: null, password: null },
  ],
  issues: [],
  warnings: [],
};

const all = new Set(['f1', 'f2', 's1', 's2', 's3', 's4']);
const opts = (p: Partial<MergeOptions>): MergeOptions => ({ selected: all, policy: 'skip', target: { kind: 'folder', name: '从 FinalShell 导入' }, now: T + 1, ...p });

const pathOf = (d: HostsData, s: ServerRecord) => {
  const parts: string[] = [];
  for (let id = s.parentId; id; ) {
    const f = d.folders.find((x) => x.id === id)!;
    parts.unshift(f.name);
    id = f.parentId;
  }
  return parts.join('/');
};

describe('findDuplicates', () => {
  it('matches host+port+user anywhere, and same name only in the destination folder', () => {
    const intoFolder = findDuplicates(existing, result, { kind: 'folder', name: 'x' });
    expect([...intoFolder.keys()]).toEqual(['s1']);
    expect(intoFolder.get('s1')!.id).toBe('srvA');
    const intoRoot = findDuplicates(existing, result, { kind: 'root' });
    expect([...intoRoot.keys()].sort()).toEqual(['s1', 's2']);
    expect(intoRoot.get('s2')!.id).toBe('srvB');
  });

  it('ignores deleted servers', () => {
    expect(findDuplicates(existing, result, { kind: 'root' }).has('s4')).toBe(false);
  });
});

describe('mergeImport into a new folder', () => {
  it('skips duplicates and creates only the folders that end up used', () => {
    const out = mergeImport(existing, result, opts({ policy: 'skip' }));
    expect(out).toMatchObject({ added: 3, skipped: 1, overwritten: 0, folders: 2 });
    const root = out.data.folders.find((f) => f.name === '从 FinalShell 导入' && f.parentId === null)!;
    expect(root).toBeDefined();
    const db = out.data.servers.find((s) => s.name === 'db-01')!;
    expect(pathOf(out.data, db)).toBe('从 FinalShell 导入/生产');
    expect(out.data.folders.some((f) => f.name === '华东')).toBe(false);
    expect(out.passwords).toEqual([{ serverId: db.id, password: 'pw3' }]);
    expect(out.data.servers.filter((s) => s.name === 'solo')).toHaveLength(2);
    // 原数据没被改动
    expect(existing.servers).toHaveLength(3);
    expect(existing.folders).toHaveLength(1);
  });

  it('overwrites the existing record in place and stores the password under its id', () => {
    const out = mergeImport(existing, result, opts({ policy: 'overwrite' }));
    expect(out).toMatchObject({ added: 3, skipped: 0, overwritten: 1 });
    const a = out.data.servers.find((s) => s.id === 'srvA')!;
    expect(a).toMatchObject({ name: 'web-01-new', note: '新备注', parentId: 'dirA', updatedAt: T + 1 });
    expect(out.passwords).toContainEqual({ serverId: 'srvA', password: 'pw1' });
    expect(out.data.servers.filter((s) => s.host === '192.0.2.10')).toHaveLength(1);
  });

  it('keeps both copies when asked', () => {
    const out = mergeImport(existing, result, opts({ policy: 'keepBoth' }));
    expect(out).toMatchObject({ added: 4, skipped: 0, overwritten: 0, folders: 3 });
    const copy = out.data.servers.find((s) => s.name === 'web-01-new')!;
    expect(pathOf(out.data, copy)).toBe('从 FinalShell 导入/生产/华东');
    expect(copy.id).not.toBe('srvA');
    expect(copy.advanced).toEqual(DEFAULT_ADVANCED);
  });

  it('honours the selection and builds explicitly selected empty folders', () => {
    const only = mergeImport(existing, result, opts({ selected: new Set(['s2']) }));
    expect(only).toMatchObject({ added: 1, folders: 1 });
    expect(pathOf(only.data, only.data.servers.find((s) => s.host === '203.0.113.2')!)).toBe('从 FinalShell 导入');

    const nothing = mergeImport(existing, result, opts({ selected: new Set(['s1']) }));
    expect(nothing).toMatchObject({ added: 0, skipped: 1, folders: 0 });
    expect(nothing.data.folders).toHaveLength(1);

    // 华东里只有一台重名被跳过的连接，不建空壳；“空的”本来就没有连接，选了就建
    const skippedFolder = mergeImport(existing, result, opts({ selected: new Set(['f2', 's1']) }));
    expect(skippedFolder).toMatchObject({ added: 0, skipped: 1, folders: 0 });
    const emptyFolder = mergeImport(existing, result, opts({ selected: new Set(['f3']) }));
    expect(emptyFolder).toMatchObject({ added: 0, folders: 3 });
    expect(emptyFolder.data.folders.map((f) => f.name).sort()).toEqual(['从 FinalShell 导入', '生产', '生产', '空的']);
  });

  it('rewrites jump server references to the new ids', () => {
    const withJump: ImportResult = {
      ...result,
      servers: result.servers.map((s) => (s.id === 's3' ? { ...s, advanced: { jumpServerId: 's1' } } : s)),
    };
    const kept = mergeImport(existing, withJump, opts({ policy: 'skip' }));
    const db = kept.data.servers.find((s) => s.name === 'db-01')!;
    // s1 被跳过，引用落到现有的 srvA
    expect(db.advanced.jumpServerId).toBe('srvA');
    const both = mergeImport(existing, withJump, opts({ policy: 'keepBoth' }));
    const copy = both.data.servers.find((s) => s.name === 'web-01-new')!;
    expect(both.data.servers.find((s) => s.name === 'db-01')!.advanced.jumpServerId).toBe(copy.id);
    const partial = mergeImport(existing, withJump, opts({ policy: 'keepBoth', selected: new Set(['s3']) }));
    expect(partial.data.servers.find((s) => s.name === 'db-01')!.advanced.jumpServerId).toBeNull();
  });

  it('reuses the import folder on a second run instead of stacking duplicates', () => {
    const first = mergeImport(existing, result, opts({ policy: 'keepBoth' }));
    const second = mergeImport(first.data, result, opts({ policy: 'keepBoth' }));
    expect(second.folders).toBe(0);
    expect(second.data.folders.filter((f) => f.name === '从 FinalShell 导入')).toHaveLength(1);
    // 第二次导入时目标文件夹里已经有同名连接，重名规则换成“同文件夹同名”，这里用保留两份所以都加进去
    expect(second.added).toBe(4);
  });
});

describe('mergeImport into root', () => {
  it('merges same-named folders and places servers next to existing ones', () => {
    const out = mergeImport(existing, result, opts({ target: { kind: 'root' }, policy: 'keepBoth' }));
    expect(out.folders).toBe(1);
    expect(out.data.folders.filter((f) => f.name === '生产')).toHaveLength(1);
    const copy = out.data.servers.find((s) => s.name === 'web-01-new')!;
    expect(pathOf(out.data, copy)).toBe('生产/华东');
    expect(out.data.folders.find((f) => f.name === '华东')!.parentId).toBe('dirA');
    const db = out.data.servers.find((s) => s.name === 'db-01')!;
    expect(db.parentId).toBe('dirA');
  });

  it('counts the name clash at root as a duplicate', () => {
    const out = mergeImport(existing, result, opts({ target: { kind: 'root' }, policy: 'skip' }));
    expect(out).toMatchObject({ added: 2, skipped: 2 });
    expect(out.data.servers.filter((s) => s.name === 'solo')).toHaveLength(1);
  });
});
