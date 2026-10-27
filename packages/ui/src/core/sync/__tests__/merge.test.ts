import { describe, expect, it } from 'vitest';
import { stripServer } from '../collections';
import { formatHlc } from '../hlc';
import { planFirstMerge, type CloudRecord, type LocalData } from '../merge';
import { folder, key, server, snippet } from './helpers';

const ME = '000000000000000a';
const CLOUD = '00000000000000c1';

function local(patch: Partial<LocalData> = {}): LocalData {
  return {
    hosts: { version: 1, folders: [], servers: [] },
    keys: { version: 1, keys: [], migratedServerKeys: true },
    snippets: [],
    groups: [],
    history: [],
    recents: [],
    knownHosts: new Map(),
    secretIds: [],
    ...patch,
  };
}

let n = 0;
function rec(collection: string, id: string, value: unknown, ms = 5000, deleted = false): CloudRecord {
  const v = collection === 'server' && value ? stripServer(value as never) : value;
  return { collection, id, hlc: formatHlc(ms, n++, CLOUD), deleted, value: deleted ? null : v, data: '' };
}

describe('第一次登录的合并：去重和改引用', () => {
  it('文件夹从根往下比：父文件夹去重以后，子文件夹拿云端父 id 去比', () => {
    const plan = planFirstMerge(
      local({
        hosts: {
          version: 1,
          folders: [folder('l_child', '网络', 'l_root'), folder('l_root', '家里'), folder('l_other', '家里', 'l_root')],
          servers: [server('l_srv', { parentId: 'l_child' })],
        },
      }),
      [rec('folder', 'c_root', folder('c_root', '家里')), rec('folder', 'c_child', folder('c_child', '网络', 'c_root'))],
      ME,
    );
    const ids = plan.hosts.folders.map((f) => f.id).sort();
    // l_other 是 家里/家里，云端没有，保留并改指云端的父文件夹
    expect(ids).toEqual(['c_child', 'c_root', 'l_other']);
    expect(plan.hosts.folders.find((f) => f.id === 'l_other')!.parentId).toBe('c_root');
    expect(plan.hosts.servers[0]!.parentId).toBe('c_child');
    expect(plan.merged.folders).toBe(2);
    expect(plan.downloaded.folders).toBe(0);
  });

  it('服务器除 id 和时间外都相同才算重复；本机存了密码、云端那台没有时把密码挪过去；被去掉的不留引用', () => {
    const plan = planFirstMerge(
      local({
        hosts: {
          version: 1,
          folders: [],
          servers: [
            server('l_web', { name: 'web', host: '10.0.0.1', lastConnectedAt: 777 }),
            server('l_web2', { name: 'web', host: '10.0.0.1', port: 2222 }),
            server('l_jump', { name: 'jump', advanced: { ...server('x').advanced, jumpServerId: 'l_web' } }),
          ],
        },
        recents: [{ serverId: 'l_web', at: 900 }],
        secretIds: ['l_web.password', 'l_web2.password'],
      }),
      [rec('server', 'c_web', server('c_web', { name: 'web', host: '10.0.0.1' })), rec('server', 'c_db', server('c_db', { name: 'db' }))],
      ME,
    );
    const ids = plan.hosts.servers.map((s) => s.id).sort();
    expect(ids).toEqual(['c_db', 'c_web', 'l_jump', 'l_web2']);
    expect(plan.hosts.servers.find((s) => s.id === 'c_web')!.lastConnectedAt).toBe(777);
    expect(plan.hosts.servers.find((s) => s.id === 'l_jump')!.advanced.jumpServerId).toBe('c_web');
    expect(plan.recents).toEqual([{ serverId: 'c_web', at: 900 }]);
    expect(plan.secretMoves).toEqual([{ from: 'l_web.password', to: 'c_web.password' }]);
    expect(plan.secretDrops).toEqual([]);
    expect(plan.merged.servers).toBe(1);
    expect(plan.downloaded.servers).toBe(1);
  });

  it('云端那台已有密码时，本机这份直接删掉', () => {
    const plan = planFirstMerge(
      local({ hosts: { version: 1, folders: [], servers: [server('l_web', { name: 'web' })] }, secretIds: ['l_web.password'] }),
      [rec('server', 'c_web', server('c_web', { name: 'web' })), rec('secret', 'c_web.password', null)],
      ME,
    );
    expect(plan.secretMoves).toEqual([]);
    expect(plan.secretDrops).toEqual(['l_web.password']);
    expect(plan.secretsFromCloud.map((c) => c.id)).toEqual(['c_web.password']);
  });

  it('私钥按公钥指纹和名称去重，服务器的 keyId 改指云端那把，本机那把的原文不留', () => {
    const plan = planFirstMerge(
      local({
        hosts: { version: 1, folders: [], servers: [server('l_srv', { auth: 'key', keyId: 'l_key' })] },
        keys: { version: 1, keys: [key('l_key', 'SHA256:same', { name: 'aws' }), key('l_other', 'SHA256:other')], migratedServerKeys: true },
        secretIds: ['l_key.privateKey', 'l_key.passphrase'],
      }),
      [rec('key', 'c_key', key('c_key', 'SHA256:same', { name: 'aws' })), rec('secret', 'c_key.privateKey', null), rec('secret', 'c_key.passphrase', null)],
      ME,
    );
    expect(plan.keys.keys.map((k) => k.id).sort()).toEqual(['c_key', 'l_other']);
    expect(plan.hosts.servers[0]!.keyId).toBe('c_key');
    expect(plan.secretDrops.sort()).toEqual(['l_key.passphrase', 'l_key.privateKey']);
    expect(plan.merged.keys).toBe(1);
  });

  it('快捷命令名称、命令、分类、回车方式都相同才合并；分类清单取并集，云端顺序在前', () => {
    const plan = planFirstMerge(
      local({
        snippets: [snippet('l1', '磁盘', 'df -h'), snippet('l2', '磁盘', 'df -h', '常用', { noEnter: true }), snippet('l3', '内存', 'free -m', '本机')],
        groups: ['本机', '常用'],
      }),
      [rec('snippet', 'c1', snippet('c1', '磁盘', 'df -h')), rec('meta', 'snippet-groups', ['常用', '云端'])],
      ME,
    );
    expect(plan.snippets.map((s) => s.id).sort()).toEqual(['c1', 'l2', 'l3']);
    expect(plan.groups).toEqual(['常用', '云端', '本机']);
    expect(plan.merged.snippets).toBe(1);
  });

  it('服务器有一处不同（备注、认证方式、端口转发）就两份都留；端口转发规则的内部编号不比', () => {
    const base = { name: 'db', host: '203.0.113.20' };
    const fw = { type: 'local' as const, bindHost: '127.0.0.1', bindPort: 5432, targetHost: '127.0.0.1', targetPort: 5432 };
    const plan = planFirstMerge(
      local({
        hosts: {
          version: 1,
          folders: [],
          servers: [
            server('l_note', { ...base, note: 'prod primary' }),
            server('l_auth', { ...base, name: 'auth', auth: 'key' }),
            server('l_fw', { ...base, name: 'fw', forwards: [{ id: 'fw_local', ...fw }] }),
          ],
        },
      }),
      [
        rec('server', 'c_db', server('c_db', base)),
        rec('server', 'c_auth', server('c_auth', { ...base, name: 'auth' })),
        rec('server', 'c_fw', server('c_fw', { ...base, name: 'fw', forwards: [{ id: 'fw_cloud', ...fw }] })),
      ],
      ME,
    );
    expect(plan.hosts.servers.map((s) => s.id).sort()).toEqual(['c_auth', 'c_db', 'c_fw', 'l_auth', 'l_note']);
    expect(plan.hosts.servers.find((s) => s.id === 'l_note')!.note).toBe('prod primary');
    expect(plan.merged.servers).toBe(1);
  });

  it('跳板机指向的服务器先去重，引用它的服务器按去重后的 id 比', () => {
    const plan = planFirstMerge(
      local({
        hosts: {
          version: 1,
          folders: [],
          servers: [
            server('l_web', { name: 'web', advanced: { ...server('x').advanced, jumpServerId: 'l_jump' } }),
            server('l_jump', { name: 'jump' }),
          ],
        },
      }),
      [
        rec('server', 'c_jump', server('c_jump', { name: 'jump' })),
        rec('server', 'c_web', server('c_web', { name: 'web', advanced: { ...server('x').advanced, jumpServerId: 'c_jump' } })),
      ],
      ME,
    );
    expect(plan.hosts.servers.map((s) => s.id).sort()).toEqual(['c_jump', 'c_web']);
    expect(plan.merged.servers).toBe(2);
  });

  it('私钥指纹相同、名称不同：两份都留', () => {
    const plan = planFirstMerge(
      local({ keys: { version: 1, keys: [key('l_key', 'SHA256:same', { name: '本机起的名字' })], migratedServerKeys: true } }),
      [rec('key', 'c_key', key('c_key', 'SHA256:same', { name: 'aws' }))],
      ME,
    );
    expect(plan.keys.keys.map((k) => k.id).sort()).toEqual(['c_key', 'l_key']);
    expect(plan.merged.keys).toBe(0);
  });

  it('回收站里的不参与去重', () => {
    const plan = planFirstMerge(
      local({ hosts: { version: 1, folders: [], servers: [server('l_web', { name: 'web', deletedAt: 5 })] } }),
      [rec('server', 'c_web', server('c_web', { name: 'web' }))],
      ME,
    );
    expect(plan.hosts.servers.map((s) => s.id).sort()).toEqual(['c_web', 'l_web']);
    expect(plan.merged.servers).toBe(0);
  });
});

describe('第一次登录的合并：同一个 id 两边都有', () => {
  it('本机的修改时间晚就留本机的，早就用云端的；内容完全相同直接用云端的', () => {
    const plan = planFirstMerge(
      local({
        hosts: {
          version: 1,
          folders: [],
          servers: [
            server('newer', { name: '本机改过', updatedAt: 9000, lastConnectedAt: 55 }),
            server('older', { name: '本机旧的', updatedAt: 1000, lastConnectedAt: 66 }),
            server('same', { name: '一样', updatedAt: 1, lastConnectedAt: 77 }),
          ],
        },
      }),
      [
        rec('server', 'newer', server('newer', { name: '云端', updatedAt: 5000 }), 5000),
        rec('server', 'older', server('older', { name: '云端新的', updatedAt: 5000 }), 5000),
        rec('server', 'same', server('same', { name: '一样', updatedAt: 1 }), 5000),
      ],
      ME,
    );
    const byId = new Map(plan.hosts.servers.map((s) => [s.id, s]));
    expect(byId.get('newer')).toMatchObject({ name: '本机改过', lastConnectedAt: 55 });
    expect(byId.get('older')).toMatchObject({ name: '云端新的', lastConnectedAt: 66 });
    expect(byId.get('same')).toMatchObject({ name: '一样', lastConnectedAt: 77 });
    expect(plan.downloaded.servers).toBe(1);
    expect(plan.merged.servers).toBe(0);
  });

  it('云端是墓碑：比墓碑新的留下，旧的删掉', () => {
    const plan = planFirstMerge(
      local({ snippets: [snippet('s1', 'a', 'a', '常用', { updatedAt: 9000 }), snippet('s2', 'b', 'b', '常用', { updatedAt: 100 })] }),
      [rec('snippet', 's1', null, 5000, true), rec('snippet', 's2', null, 5000, true)],
      ME,
    );
    expect(plan.snippets.map((s) => s.id)).toEqual(['s1']);
  });

  it('机密没有修改时间，云端的赢；云端的墓碑也删掉本机这条', () => {
    const plan = planFirstMerge(
      local({ secretIds: ['a.password', 'b.password', 'c.password'] }),
      [rec('secret', 'a.password', null), rec('secret', 'b.password', null, 5000, true), rec('secret', 'd.password', null, 5000, true)],
      ME,
    );
    expect(plan.secretsFromCloud.map((c) => c.id).sort()).toEqual(['a.password', 'b.password']);
  });

  it('历史按 id 合起来、丢掉云端水位线以前的，最近连接同一台留新的', () => {
    const plan = planFirstMerge(
      local({
        history: [
          { id: 'h_new', at: 9000, cmd: 'ls', target: 'a' },
          { id: 'h_old', at: 1000, cmd: 'pwd', target: 'a' },
        ],
        recents: [{ serverId: 's1', at: 9000 }],
      }),
      [
        rec('meta', 'history-cleared', { at: 2000 }),
        rec('history', 'h_cloud', { id: 'h_cloud', at: 3000, cmd: 'top', target: 'b' }),
        rec('recent', 's1', { at: 4000 }, 4000),
        rec('recent', 's2', { at: 4000 }, 4000),
      ],
      ME,
    );
    expect(plan.history.map((h) => h.id)).toEqual(['h_new', 'h_cloud']);
    expect(plan.marks).toEqual({ 'history-cleared': 2000 });
    expect(plan.recents).toEqual([
      { serverId: 's1', at: 9000 },
      { serverId: 's2', at: 4000 },
    ]);
    expect(plan.downloaded).toMatchObject({ history: 1, recents: 1 });
  });

  it('known_hosts 同一行 id 一样，不重复加', () => {
    const plan = planFirstMerge(
      local({ knownHosts: new Map([['k1', 'a.example ssh-ed25519 AAAA']]) }),
      [rec('known-host', 'k1', { line: 'a.example ssh-ed25519 AAAA' }), rec('known-host', 'k2', { line: 'b.example ssh-ed25519 BBBB' })],
      ME,
    );
    expect(plan.knownHostsAdd).toEqual(['b.example ssh-ed25519 BBBB']);
    expect(plan.downloaded.knownHosts).toBe(1);
  });
});
