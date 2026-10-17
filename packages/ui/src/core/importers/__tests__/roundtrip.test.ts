import { describe, expect, it } from 'vitest';
import { DEFAULT_ADVANCED, type FolderRecord, type HostsData, type ServerRecord } from '../../hosts-store';
import { parseEverShell } from '../evershell';
import { buildExport, EXPORT_FORMAT, EXPORT_VERSION, exportFileName } from '../export';
import { mergeImport } from '../merge';

// 导出 → JSON → 导入 → 合并，结构和字段要原样回来（id 会变）

const T = 1_700_000_000_000;
const folder = (id: string, name: string, parentId: string | null = null, deletedAt: number | null = null): FolderRecord => ({
  id,
  name,
  parentId,
  createdAt: T,
  updatedAt: T,
  deletedAt,
});
const server = (id: string, p: Partial<ServerRecord>): ServerRecord => ({
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
  lastConnectedAt: T,
  ...p,
});

const data: HostsData = {
  version: 1,
  folders: [folder('dA', '生产'), folder('dB', '华东', 'dA'), folder('dC', '测试'), folder('dD', '已删', null, T)],
  servers: [
    server('s1', {
      parentId: 'dB',
      name: 'web-01',
      host: '192.0.2.10',
      user: 'deploy',
      note: '前端',
      advanced: { ...DEFAULT_ADVANCED, jumpServerId: 's3', encoding: 'GBK' },
      forwards: [{ id: 'f1', type: 'local', bindHost: '127.0.0.1', bindPort: 8080, targetHost: '127.0.0.1', targetPort: 80 }],
    }),
    server('s2', { parentId: 'dA', name: 'db-01', host: '198.51.100.20', port: 2222, user: 'dbadmin', auth: 'key', keyLabel: 'db_ed25519' }),
    server('s3', { name: 'bastion', host: 'bastion.example.com', user: 'ops', advanced: { ...DEFAULT_ADVANCED, proxy: 'http', proxyHost: 'proxy.example.com', proxyPort: 3128 } }),
    server('s4', { parentId: 'dC', name: 'rdp-box', host: '203.0.113.50', port: 3389, proto: 'rdp' }),
    server('s5', { name: 'gone', host: '203.0.113.99', deletedAt: T }),
  ],
};

const pathOf = (d: HostsData, s: ServerRecord) => {
  const parts: string[] = [];
  for (let id = s.parentId; id; ) {
    const f = d.folders.find((x) => x.id === id)!;
    parts.unshift(f.name);
    id = f.parentId;
  }
  return parts.join('/');
};

describe('export file', () => {
  it('has a version tag, no secrets and no deleted records', () => {
    const file = buildExport(data, null, new Date(T));
    expect(file.format).toBe(EXPORT_FORMAT);
    expect(file.version).toBe(EXPORT_VERSION);
    expect(file.folders.map((f) => f.name).sort()).toEqual(['华东', '测试', '生产']);
    expect(file.servers.map((s) => s.name).sort()).toEqual(['bastion', 'db-01', 'rdp-box', 'web-01']);
    const text = JSON.stringify(file);
    expect(text).not.toMatch(/"password"\s*:|privateKey|passphrase|createdAt|lastConnectedAt|deletedAt/);
    expect(exportFileName(new Date(2026, 9, 17))).toBe('evershell-connections-20261017.json');
  });

  it('exports a selected folder subtree and selected servers at the top level', () => {
    const file = buildExport(data, ['dA', 's3', 's1'], new Date(T));
    expect(file.folders.map((f) => [f.name, f.parentId])).toEqual([
      ['生产', null],
      ['华东', 'dA'],
    ]);
    // s1 在选中的文件夹里，不重复导出；s3 作为单独选中的连接放在根
    expect(file.servers.map((s) => [s.name, s.parentId]).sort()).toEqual([
      ['bastion', null],
      ['db-01', 'dA'],
      ['web-01', 'dB'],
    ]);
  });
});

describe('round trip', () => {
  it('comes back identical through parseEverShell + mergeImport', () => {
    const text = JSON.stringify(buildExport(data, null, new Date(T)));
    const parsed = parseEverShell([{ path: 'export.json', bytes: new TextEncoder().encode(text) }]);
    expect(parsed.issues).toEqual([]);
    expect(parsed.warnings).toEqual([]);
    const selected = new Set([...parsed.folders.map((f) => f.id), ...parsed.servers.map((s) => s.id)]);
    const out = mergeImport({ version: 1, folders: [], servers: [] }, parsed, { selected, policy: 'skip', target: { kind: 'root' }, now: T });
    expect(out).toMatchObject({ added: 4, folders: 3, skipped: 0, overwritten: 0 });
    expect(out.passwords).toEqual([]);

    const originals = data.servers.filter((s) => !s.deletedAt);
    for (const o of originals) {
      const copy = out.data.servers.find((s) => s.name === o.name)!;
      expect(copy).toBeDefined();
      expect(pathOf(out.data, copy)).toBe(pathOf(data, o));
      const { id: _i, parentId: _p, createdAt: _c, updatedAt: _u, lastConnectedAt: _l, advanced, ...rest } = o;
      expect(copy).toMatchObject(rest);
      expect(copy.advanced).toEqual({ ...advanced, jumpServerId: advanced.jumpServerId ? out.data.servers.find((s) => s.name === 'bastion')!.id : null });
    }
    expect(out.data.servers.find((s) => s.name === 'web-01')!.forwards).toEqual(originals[0]!.forwards);
  });

  it('exporting the merged copy again yields the same document modulo ids', () => {
    const first = buildExport(data, null, new Date(T));
    const parsed = parseEverShell([{ path: 'export.json', bytes: new TextEncoder().encode(JSON.stringify(first)) }]);
    const selected = new Set([...parsed.folders.map((f) => f.id), ...parsed.servers.map((s) => s.id)]);
    const merged = mergeImport({ version: 1, folders: [], servers: [] }, parsed, { selected, policy: 'skip', target: { kind: 'root' }, now: T });
    const second = buildExport(merged.data, null, new Date(T));
    const strip = (f: ReturnType<typeof buildExport>) => ({
      folders: f.folders.map((x) => x.name).sort(),
      servers: f.servers
        .map(({ id: _i, parentId: _p, advanced, ...rest }) => ({ ...rest, advanced: { ...advanced, jumpServerId: advanced.jumpServerId ? 'ref' : null } }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
    expect(strip(second)).toEqual(strip(first));
  });
});
