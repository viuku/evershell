import { beforeEach, describe, expect, it } from 'vitest';
import * as account from '../account';
import { describeEnableResult } from '../index';
import { ledgerGet } from '../ledger';
import { SESSION_SECRET } from '../state';
import { BACKOFF_MS, DEBOUNCE_MS, INTERVAL_MS } from '../engine';
import {
  FakeClock,
  MockSyncServer,
  PASSWORD,
  folder,
  key,
  loginClient,
  makeClient,
  pushCount,
  registerClient,
  server,
  serverRecords,
  snippet,
  view,
  type TestClient,
} from './helpers';

let clock: FakeClock;
let srv: MockSyncServer;

beforeEach(() => {
  clock = new FakeClock();
  srv = new MockSyncServer({ now: clock.now });
});

/** 改一台服务器（照 updateServer：字段 + updatedAt） */
function editServer(c: TestClient, id: string, patch: Record<string, unknown>) {
  c.stores.hosts.set((d) => ({ ...d, servers: d.servers.map((s) => (s.id === id ? { ...s, ...patch, updatedAt: clock.t } : s)) }));
}

function addServer(c: TestClient, id: string, patch: Record<string, unknown> = {}) {
  c.stores.hosts.set((d) => ({ ...d, servers: [...d.servers, server(id, { createdAt: clock.t, updatedAt: clock.t, ...patch })] }));
}

/** 照 pushHistory：新的放前面，留 300 条 */
function pushHistory(c: TestClient, cmd: string) {
  const id = `his_${cmd}_${clock.t}`;
  c.stores.history.set((list) => [{ id, at: clock.t, cmd, target: 'web' }, ...list].slice(0, 300));
  clock.advance(1);
  return id;
}

async function syncAll(...clients: TestClient[]) {
  for (let i = 0; i < 2; i++) {
    for (const c of clients) {
      clock.advance(10);
      await c.engine.syncNow();
    }
  }
}

describe('注册：本机全部发上去', () => {
  it('上传全部记录；机密只经平台加密，不含 known_hosts 和 sync. 开头的；状态和令牌存好', async () => {
    const a = await makeClient(srv, clock);
    a.stores.hosts.set({
      version: 1,
      folders: [folder('dir_1', '生产')],
      servers: [server('srv_1', { parentId: 'dir_1', lastConnectedAt: 123 }), server('srv_trash', { deletedAt: 5 })],
    });
    a.stores.keys.set({ version: 1, keys: [key('key_1', 'SHA256:a')], migratedServerKeys: true });
    a.stores.snippets.set([snippet('snp_1', '磁盘', 'df -h'), snippet('snp_2', '内存', 'free -m')]);
    a.stores.groups.set(['常用']);
    a.stores.history.set([{ id: 'his_1', at: 100, cmd: 'ls', target: 'web' }]);
    a.stores.recents.set([{ serverId: 'srv_1', at: 100 }]);
    await a.vault.set('srv_1.password', 'pw1');
    await a.vault.set('key_1.privateKey', 'PRIVATE');
    await a.knownHosts.editLines(() => ['a.example ssh-ed25519 AAAA', 'b.example ssh-ed25519 BBBB']);

    const steps: number[] = [];
    const result = await account.register(a.engine, { server: 'https://sync.test/', account: ' Ops ', password: PASSWORD }, (s) => steps.push(s));
    expect(steps).toEqual([0, 1, 2]);
    expect(result).toEqual({
      mode: 'register',
      uploaded: { servers: 1, folders: 1, keys: 1, snippets: 2, history: 1, recents: 1, knownHosts: 2 },
      downloaded: expect.objectContaining({ servers: 0 }),
      merged: expect.objectContaining({ servers: 0 }),
    });
    expect(describeEnableResult(result)).toBe('已上传本机的 1 台服务器、2 条快捷命令、1 把私钥。');

    // 账号名规范化：去掉空白、转小写
    expect(srv.accounts.has('ops')).toBe(true);
    expect(serverRecords(srv, 'ops', 'server').map((r) => r.id).sort()).toEqual(['srv_1', 'srv_trash']);
    expect(serverRecords(srv, 'ops', 'secret').map((r) => r.id).sort()).toEqual(['key_1.privateKey', 'srv_1.password']);
    expect(serverRecords(srv, 'ops', 'known-host')).toHaveLength(2);
    expect(serverRecords(srv, 'ops', 'meta').map((r) => r.id)).toEqual(['snippet-groups']);
    // 上传的服务器记录不含 lastConnectedAt
    const sealed = srv.record('ops', 'server', 'srv_1')!;
    const [plain] = await a.platform.open([{ aad: { account: 'ops', collection: 'server', id: 'srv_1', hlc: sealed.hlc, deleted: false }, data: sealed.data }]);
    expect(JSON.parse(plain!)).not.toHaveProperty('lastConnectedAt');

    expect(a.status.get()).toMatchObject({ state: 'ok', server: 'https://sync.test', account: 'ops', deviceName: 'MacBook Pro' });
    expect(a.vault.map.get(SESSION_SECRET)).toBeTruthy();
    const saved = a.state.load();
    expect(saved !== 'future' && saved).toMatchObject({ version: 1, account: 'ops', pending: [], cursor: expect.any(Number) });
    expect(a.timers.next).toBe(INTERVAL_MS);
  });

  it('本机没有数据时的那句话；账号已存在、邀请码不对给对应的提示', async () => {
    const a = await makeClient(srv, clock);
    const result = await registerClient(a);
    expect(describeEnableResult(result)).toBe('本机暂无需要上传的数据。');

    const b = await makeClient(srv, clock);
    await expect(registerClient(b)).rejects.toMatchObject({ code: 'account_exists', message: '注册失败：该账号已存在' });
    expect(b.engine.active).toBe(false);

    const strict = new MockSyncServer({ now: clock.now, registration: 'invite', invite: 'abc' });
    const c = await makeClient(strict, clock);
    await expect(account.register(c.engine, { server: 'https://sync.test', account: 'x', password: PASSWORD, invite: 'nope' }, () => {})).rejects.toMatchObject({
      message: '注册失败：邀请码不正确',
    });
  });
});

describe('登录：第一次合并', () => {
  it('去重、改引用、挪密码，被去掉的不发墓碑；完成框的数字和那句话', async () => {
    const a = await makeClient(srv, clock, 'A');
    a.stores.hosts.set({
      version: 1,
      folders: [folder('a_dir', 'prod')],
      servers: [server('a_web', { name: 'web', host: '10.0.0.1', parentId: 'a_dir' }), server('a_db', { name: 'db', host: '10.0.0.2' })],
    });
    a.stores.keys.set({ version: 1, keys: [key('a_key', 'SHA256:same', { name: 'deploy' })], migratedServerKeys: true });
    await a.vault.set('a_key.privateKey', 'PRIVATE-A');
    a.stores.snippets.set([snippet('a_snp', '磁盘', 'df -h')]);
    await registerClient(a);

    clock.advance(60_000);
    const b = await makeClient(srv, clock, 'B');
    b.stores.hosts.set({
      version: 1,
      folders: [folder('b_dir', 'prod')],
      servers: [
        server('b_web', { name: 'web', host: '10.0.0.1', parentId: 'b_dir', lastConnectedAt: 999 }),
        server('b_cache', { name: 'cache', host: '10.0.0.3', parentId: 'b_dir', auth: 'key', keyId: 'b_key', advanced: { ...server('x').advanced, jumpServerId: 'b_web' } }),
      ],
    });
    b.stores.keys.set({ version: 1, keys: [key('b_key', 'SHA256:same', { name: 'deploy' })], migratedServerKeys: true });
    await b.vault.set('b_key.privateKey', 'PRIVATE-B');
    await b.vault.set('b_web.password', 'pw-b');
    b.stores.snippets.set([snippet('b_snp', '磁盘', 'df -h'), snippet('b_top', '进程', 'top')]);
    b.stores.recents.set([{ serverId: 'b_web', at: 500 }]);

    const result = await loginClient(b);
    expect(result.mode).toBe('login');
    expect(result.downloaded).toMatchObject({ servers: 1, folders: 0, keys: 0, snippets: 0 });
    expect(result.uploaded).toMatchObject({ servers: 1, snippets: 1, folders: 0, keys: 0 });
    expect(result.merged).toMatchObject({ servers: 1, folders: 1, keys: 1, snippets: 1 });
    expect(describeEnableResult(result)).toBe('已从云端获取 1 台服务器；本机的 1 台服务器、1 条快捷命令已上传；1 台服务器、1 条快捷命令、1 把私钥与云端完全相同，已合并为一份。');

    const servers = new Map(b.stores.hosts.get().servers.map((s) => [s.id, s]));
    expect([...servers.keys()].sort()).toEqual(['a_db', 'a_web', 'b_cache']);
    expect(servers.get('a_web')!.lastConnectedAt).toBe(999);
    expect(servers.get('b_cache')).toMatchObject({ parentId: 'a_dir', keyId: 'a_key' });
    expect(servers.get('b_cache')!.advanced.jumpServerId).toBe('a_web');
    expect(b.stores.hosts.get().folders.map((f) => f.id)).toEqual(['a_dir']);
    expect(b.stores.keys.get().keys.map((k) => k.id)).toEqual(['a_key']);
    expect(b.stores.recents.get()).toEqual([{ serverId: 'a_web', at: 500 }]);
    // 密码挪到云端那台名下；私钥用云端的（保险箱钥匙已经换成云端那把）
    expect(b.vault.map.get('a_web.password')).toBe('pw-b');
    expect(b.vault.map.has('b_web.password')).toBe(false);
    expect(b.vault.map.get('a_key.privateKey')).toBe('PRIVATE-A');
    expect(b.vault.map.has('b_key.privateKey')).toBe(false);
    expect(b.platform.vaultKey()).toBe(a.platform.vaultKey());

    // 被去掉的不发墓碑：服务器上根本没有这些 id
    for (const [c, id] of [['folder', 'b_dir'], ['server', 'b_web'], ['key', 'b_key'], ['snippet', 'b_snp']]) {
      expect(srv.record('ops', c!, id!)).toBeUndefined();
    }
    expect(b.status.get().state).toBe('ok');

    // A 拿到 B 上传的
    await a.engine.syncNow();
    expect(await view(a)).toEqual(await view(b));
    expect(a.vault.map.get('a_web.password')).toBe('pw-b');
  });

  it('本机与云端完全一样时的那句话；密码不对给提示，本机什么都不动', async () => {
    const a = await makeClient(srv, clock);
    a.stores.snippets.set([snippet('s1', '磁盘', 'df -h')]);
    await registerClient(a);
    const b = await makeClient(srv, clock);
    await expect(loginClient(b, 'OPS', 'wrong password')).rejects.toMatchObject({ code: 'bad_credentials', message: '登录失败：账号或同步密码不正确' });
    expect(b.engine.active).toBe(false);
    expect(b.state.load()).toBeNull();
    b.stores.snippets.set([snippet('s1', '磁盘', 'df -h')]);
    const result = await loginClient(b, 'OPS');
    expect(describeEnableResult(result)).toBe('本机与云端的数据一致。');
  });
});

describe('两台设备来回同步', () => {
  async function pair() {
    const a = await makeClient(srv, clock, 'A');
    addServer(a, 'srv_1', { name: 'web' });
    addServer(a, 'srv_2', { name: 'db' });
    a.stores.snippets.set([snippet('snp_1', '磁盘', 'df -h'), snippet('snp_2', '内存', 'free -m')]);
    await registerClient(a);
    clock.advance(1000);
    const b = await makeClient(srv, clock, 'B');
    await loginClient(b);
    return { a, b };
  }

  it('来回改、删，最后两边一致；对方的改动应用后不会再推回去', async () => {
    const { a, b } = await pair();
    clock.advance(1000);
    editServer(a, 'srv_1', { name: 'web-renamed' });
    b.stores.snippets.set((list) => list.filter((s) => s.id !== 'snp_2'));
    addServer(b, 'srv_3', { name: 'cache' });
    await syncAll(a, b);
    expect(await view(a)).toEqual(await view(b));
    expect(a.stores.snippets.get().map((s) => s.id)).toEqual(['snp_1']);
    expect(b.stores.hosts.get().servers.find((s) => s.id === 'srv_1')!.name).toBe('web-renamed');
    expect(serverRecords(srv, 'ops', 'snippet').find((r) => r.id === 'snp_2')!.deleted).toBe(true);

    const before = pushCount(srv);
    await syncAll(a, b);
    expect(pushCount(srv)).toBe(before);
  });

  it('离线时两边都改，联网后后改的那次整条胜出', async () => {
    const { a, b } = await pair();
    a.net.down = true;
    clock.advance(1000);
    editServer(a, 'srv_1', { note: 'A 写的备注' });
    a.stores.snippets.set((list) => list.filter((s) => s.id !== 'snp_1'));
    await a.engine.syncNow();
    expect(a.status.get()).toMatchObject({ state: 'offline', message: '无法连接同步服务器' });

    clock.advance(1000);
    editServer(b, 'srv_1', { name: 'B 改的名字' });
    await b.engine.syncNow();

    a.net.down = false;
    await syncAll(a, b);
    expect(await view(a)).toEqual(await view(b));
    // 后写的赢、整条替换：A 的备注没了
    expect(a.stores.hosts.get().servers.find((s) => s.id === 'srv_1')).toMatchObject({ name: 'B 改的名字', note: '' });
    expect(b.stores.snippets.get().map((s) => s.id)).toEqual(['snp_2']);
    expect(a.status.get().state).toBe('ok');
  });

  it('服务器记录不同步 lastConnectedAt：应用远端记录时保留本机的值，只连了一次不算改动', async () => {
    const { a, b } = await pair();
    b.stores.hosts.set((d) => ({ ...d, servers: d.servers.map((s) => (s.id === 'srv_1' ? { ...s, lastConnectedAt: 4242 } : s)) }));
    await b.engine.syncNow();
    expect(srv.record('ops', 'server', 'srv_1')!.hlc).toBe(ledgerGet(a.engine.session!.ledger, 'server', 'srv_1')![0]);
    clock.advance(1000);
    editServer(a, 'srv_1', { name: 'web2' });
    await syncAll(a, b);
    expect(b.stores.hosts.get().servers.find((s) => s.id === 'srv_1')).toMatchObject({ name: 'web2', lastConnectedAt: 4242 });
  });

  it('机密互相应用后不再推：摘要用平台重新取，不会被当成本机改动来回推', async () => {
    const { a, b } = await pair();
    await a.vault.set('srv_1.password', 'from-a');
    await a.engine.syncNow();
    await b.engine.syncNow();
    expect(b.vault.map.get('srv_1.password')).toBe('from-a');
    await b.vault.set('srv_2.password', 'from-b');
    await b.engine.syncNow();
    await a.engine.syncNow();
    expect(a.vault.map.get('srv_2.password')).toBe('from-b');

    const before = pushCount(srv);
    await syncAll(a, b);
    await syncAll(a, b);
    expect(pushCount(srv)).toBe(before);
    expect(a.engine.session!.pending).toEqual([]);
    expect(b.engine.session!.pending).toEqual([]);

    // 删掉也同步过去
    await a.vault.remove('srv_1.password');
    await syncAll(a, b);
    expect(b.vault.map.has('srv_1.password')).toBe(false);
  });

  it('服务器指纹记录按行同步，删一行也同步过去', async () => {
    const { a, b } = await pair();
    await a.knownHosts.editLines(() => ['web.example ssh-ed25519 AAAA', '[db.example]:2222 ssh-ed25519 BBBB']);
    await syncAll(a, b);
    expect((await b.knownHosts.lines()).sort()).toEqual(['[db.example]:2222 ssh-ed25519 BBBB', 'web.example ssh-ed25519 AAAA']);
    expect(b.status.get().counts.knownHosts).toBe(2);
    await a.knownHosts.editLines((lines) => lines.filter((l) => !l.startsWith('web.')));
    await syncAll(a, b);
    expect(await b.knownHosts.lines()).toEqual(['[db.example]:2222 ssh-ed25519 BBBB']);
    expect(b.vault.map.has('known_hosts')).toBe(true);
    expect(srv.record('ops', 'secret', 'known_hosts')).toBeUndefined();
  });

  it('分类清单整份一条，后写的赢', async () => {
    const { a, b } = await pair();
    a.stores.groups.set(['常用', 'Docker']);
    await syncAll(a, b);
    expect(b.stores.groups.get()).toEqual(['常用', 'Docker']);
  });
});

describe('历史和最近连接', () => {
  it('挤出去的不发墓碑；另一台照样收到，按时间裁到 300 条', async () => {
    const a = await makeClient(srv, clock);
    for (let i = 0; i < 300; i++) pushHistory(a, `c${i}`);
    await registerClient(a);
    for (let i = 300; i < 310; i++) pushHistory(a, `c${i}`);
    expect(a.stores.history.get()).toHaveLength(300);
    await a.engine.syncNow();
    const history = serverRecords(srv, 'ops', 'history');
    expect(history).toHaveLength(310);
    expect(history.every((r) => !r.deleted)).toBe(true);
    expect(Object.keys(a.engine.session!.ledger.history ?? {})).toHaveLength(300);

    const b = await makeClient(srv, clock);
    await loginClient(b);
    expect(b.stores.history.get()).toHaveLength(300);
    expect(b.stores.history.get()[0]!.cmd).toBe('c309');
    expect(b.stores.history.get()[299]!.cmd).toBe('c10');
  });

  it('「清空」写水位线：另一台丢掉早于它的，之后再来的旧记录也不要', async () => {
    const a = await makeClient(srv, clock);
    pushHistory(a, 'old-a');
    a.stores.recents.set([{ serverId: 'srv_x', at: clock.t }]);
    await registerClient(a);
    const b = await makeClient(srv, clock);
    await loginClient(b);
    const stale = pushHistory(b, 'old-b');
    await b.engine.syncNow();
    const staleRecord = srv.record('ops', 'history', stale)!;
    clock.advance(1000);

    // 照 clearHistory / clearRecents：只是把数组清掉
    a.stores.history.set([]);
    a.stores.recents.set([]);
    expect(a.engine.session!.marks['history-cleared']).toBe(clock.t);
    clock.advance(1000);
    await a.engine.syncNow();
    expect(srv.record('ops', 'meta', 'history-cleared')).toBeDefined();
    expect(srv.record('ops', 'meta', 'recents-cleared')).toBeDefined();

    clock.advance(1000);
    const fresh = pushHistory(b, 'new-b');
    await b.engine.syncNow();
    expect(b.stores.history.get().map((h) => h.id)).toEqual([fresh]);
    expect(b.stores.recents.get()).toEqual([]);
    // 清空不是删除，不发墓碑
    expect(serverRecords(srv, 'ops', 'history').every((r) => !r.deleted)).toBe(true);

    await a.engine.syncNow();
    expect(a.stores.history.get().map((h) => h.id)).toEqual([fresh]);
    // 服务器把清空前的旧记录又发一遍：早于水位线，不要
    srv.replay('ops', { ...staleRecord, hlc: staleRecord.hlc.replace(/-\w{4}-/, '-00ff-') });
    await a.engine.syncNow();
    expect(a.stores.history.get().map((h) => h.id)).toEqual([fresh]);
  });
});

describe('服务器不可信', () => {
  it('服务器回放旧版本：比账本旧的拒收', async () => {
    const a = await makeClient(srv, clock);
    addServer(a, 'srv_1', { name: 'v1' });
    await registerClient(a);
    const b = await makeClient(srv, clock);
    await loginClient(b);
    const old = srv.record('ops', 'server', 'srv_1')!;
    clock.advance(1000);
    editServer(a, 'srv_1', { name: 'v2' });
    await a.engine.syncNow();
    await b.engine.syncNow();
    expect(b.stores.hosts.get().servers[0]!.name).toBe('v2');

    srv.replay('ops', old);
    await b.engine.syncNow();
    await a.engine.syncNow();
    expect(b.stores.hosts.get().servers[0]!.name).toBe('v2');
    expect(a.stores.hosts.get().servers[0]!.name).toBe('v2');
    expect(b.status.get().state).toBe('ok');
  });

  it('改了时间戳或挪了 id 的记录解不开：跳过、游标照常往前、状态显示同步失败', async () => {
    const a = await makeClient(srv, clock);
    addServer(a, 'srv_1', { name: 'v1' });
    await registerClient(a);
    const b = await makeClient(srv, clock);
    await loginClient(b);
    const rec = srv.record('ops', 'server', 'srv_1')!;
    // 把时间戳改大想让旧内容胜出：附加数据对不上
    srv.replay('ops', { ...rec, hlc: rec.hlc.replace(/^\d{3}/, '009') });
    await b.engine.syncNow();
    expect(b.status.get()).toMatchObject({ state: 'error', message: '部分数据无法解密' });
    expect(b.engine.session!.cursor).toBe(srv.accounts.get('ops')!.seq);
    expect(b.stores.hosts.get().servers[0]!.name).toBe('v1');
  });

  it('服务器恢复了备份（序号倒退）：游标归零重拉，本机有的重新推上去', async () => {
    const a = await makeClient(srv, clock);
    addServer(a, 'srv_1');
    await registerClient(a);
    const backup = srv.snapshot('ops');
    clock.advance(1000);
    addServer(a, 'srv_2');
    a.stores.snippets.set([snippet('snp_1', '磁盘', 'df -h')]);
    await a.engine.syncNow();
    const cursorBefore = a.engine.session!.cursor;
    srv.restore('ops', backup);
    expect(srv.accounts.get('ops')!.seq).toBeLessThan(cursorBefore);

    await a.engine.syncNow();
    expect(a.status.get().state).toBe('ok');
    expect(srv.record('ops', 'server', 'srv_2')).toBeDefined();
    expect(srv.record('ops', 'snippet', 'snp_1')).toBeDefined();
    await a.engine.syncNow();
    expect(a.engine.session!.cursor).toBe(srv.accounts.get('ops')!.seq);

    const b = await makeClient(srv, clock);
    await loginClient(b);
    expect(await view(b)).toEqual(await view(a));
  });
});

describe('出错的状态和调度', () => {
  it('断网 → 离线，退避 30 秒、1 分钟、2 分钟、5 分钟封顶；恢复后回到 30 秒', async () => {
    const a = await makeClient(srv, clock);
    await registerClient(a);
    expect(a.timers.next).toBe(INTERVAL_MS);
    a.net.down = true;
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      a.timers.fire();
      await a.engine.syncNow();
      delays.push(a.timers.next!);
    }
    expect(delays).toEqual([BACKOFF_MS[0], BACKOFF_MS[1], BACKOFF_MS[2], BACKOFF_MS[3], BACKOFF_MS[3]]);
    expect(a.status.get()).toMatchObject({ state: 'offline', message: '无法连接同步服务器' });
    // 退避期间本机改动不提前
    addServer(a, 'srv_1');
    expect(a.timers.next).toBe(BACKOFF_MS[3]);
    a.net.down = false;
    a.engine.wake('online');
    expect(a.timers.next).toBe(0);
    a.timers.fire();
    await a.engine.syncNow();
    expect(a.status.get().state).toBe('ok');
    expect(a.timers.next).toBe(INTERVAL_MS);
    expect(srv.record('ops', 'server', 'srv_1')).toBeDefined();
  });

  it('本机改动 1.5 秒后推一次；没联网不跑', async () => {
    const a = await makeClient(srv, clock);
    await registerClient(a);
    addServer(a, 'srv_1');
    expect(a.timers.next).toBe(DEBOUNCE_MS);
    addServer(a, 'srv_2');
    expect(a.timers.next).toBe(DEBOUNCE_MS);
    a.online.value = false;
    const before = srv.requests.length;
    a.timers.fire();
    await a.engine.syncNow();
    expect(srv.requests.length).toBe(before);
    expect(a.status.get()).toMatchObject({ state: 'offline', message: '网络未连接' });
    a.online.value = true;
    await a.engine.syncNow();
    expect(serverRecords(srv, 'ops', 'server')).toHaveLength(2);
  });

  it('同一时间只跑一轮', async () => {
    const a = await makeClient(srv, clock);
    await registerClient(a);
    const before = srv.requests.filter(([m, p]) => m === 'GET' && p === '/v1/records').length;
    await Promise.all([a.engine.syncNow(), a.engine.syncNow(), a.engine.syncNow()]);
    expect(srv.requests.filter(([m, p]) => m === 'GET' && p === '/v1/records').length).toBe(before + 1);
  });

  it('5xx → 同步失败；429 和 Cloudflare 1027 页面 → 离线；401 → 需重新登录且不再定时', async () => {
    const a = await makeClient(srv, clock);
    await registerClient(a);
    srv.failNext = { status: 500 };
    await a.engine.syncNow();
    expect(a.status.get()).toMatchObject({ state: 'error', message: '服务器返回错误（HTTP 500）' });
    srv.failNext = { status: 429, text: 'Too Many Requests' };
    await a.engine.syncNow();
    expect(a.status.get().state).toBe('offline');
    srv.failNext = { status: 403, text: '<html>error code: 1027</html>' };
    await a.engine.syncNow();
    expect(a.status.get().state).toBe('offline');
    srv.failNext = { status: 401, body: { error: 'unauthorized', message: 'x' } };
    await a.engine.syncNow();
    expect(a.status.get()).toMatchObject({ state: 'relogin', message: '' });
    expect(a.timers.next).toBeNull();
  });

  it('时间快了 10 分钟以上被服务器拒收，提示校准时间', async () => {
    const a = await makeClient(srv, clock);
    await registerClient(a);
    const fast = new FakeClock();
    fast.t = clock.t + 20 * 60_000;
    const b = await makeClient(srv, fast);
    addServer(b, 'srv_1');
    await loginClient(b);
    expect(b.status.get()).toMatchObject({ state: 'error', message: '本机时间与服务器相差过大，请校准系统时间' });
  });

  it('同步状态是更新版本写的：不同步、不写回，提示升级', async () => {
    const a = await makeClient(srv, clock);
    a.engine.stop();
    a.state.json = JSON.stringify({ version: 2, server: 'https://sync.test', whatever: true });
    const { SyncEngine } = await import('../engine');
    const engine = new SyncEngine({
      platform: a.platform,
      secrets: a.vault,
      stores: a.stores,
      knownHosts: a.knownHosts,
      state: a.state,
      status: a.status,
      timers: a.timers,
      now: clock.now,
    });
    await engine.start();
    addServer(a, 'srv_1');
    await engine.syncNow();
    expect(a.status.get()).toMatchObject({ state: 'error', message: '同步状态由较新版本的 EverShell 写入，请升级到最新版本后再同步' });
    expect(srv.requests).toHaveLength(0);
    expect(JSON.parse(a.state.json!)).toEqual({ version: 2, server: 'https://sync.test', whatever: true });
  });

  it('重启后接着同步：读回同步状态和令牌', async () => {
    const a = await makeClient(srv, clock);
    await registerClient(a);
    addServer(a, 'srv_1');
    a.engine.stop();
    const { SyncEngine } = await import('../engine');
    const engine = new SyncEngine({
      platform: a.platform,
      secrets: a.vault,
      stores: a.stores,
      knownHosts: a.knownHosts,
      state: a.state,
      status: a.status,
      timers: a.timers,
      now: clock.now,
    });
    await engine.start();
    expect(a.timers.next).toBe(0);
    a.timers.fire();
    await engine.syncNow();
    expect(srv.record('ops', 'server', 'srv_1')).toBeDefined();
    expect(a.status.get().state).toBe('ok');
  });
});

describe('账号操作', () => {
  it('改密码：其他设备变成需重新登录，用新密码重新登录后接着同步', async () => {
    const a = await makeClient(srv, clock);
    await registerClient(a);
    const b = await makeClient(srv, clock);
    await loginClient(b);
    await expect(account.changePassword(a.engine, 'short')).rejects.toMatchObject({ message: '同步密码至少需要 8 位' });
    await account.changePassword(a.engine, 'new password 2');
    await a.engine.syncNow();
    expect(a.status.get().state).toBe('ok');
    await b.engine.syncNow();
    expect(b.status.get().state).toBe('relogin');

    await expect(account.relogin(b.engine, PASSWORD)).rejects.toMatchObject({ message: '登录失败：同步密码不正确' });
    addServer(b, 'srv_b');
    await account.relogin(b.engine, 'new password 2');
    expect(b.timers.next).toBe(0);
    b.timers.fire();
    await b.engine.syncNow();
    expect(b.status.get().state).toBe('ok');
    expect(srv.record('ops', 'server', 'srv_b')).toBeDefined();
  });

  it('设备列表、改本机名称、移除别的设备（它下次同步时需重新登录）', async () => {
    const a = await makeClient(srv, clock, 'A');
    await registerClient(a);
    const b = await makeClient(srv, clock, 'B');
    await loginClient(b);
    const devices = await account.listDevices(a.engine);
    expect(devices.map((d) => [d.name, d.current, d.platform]).sort()).toEqual([
      ['A', true, 'macos'],
      ['B', false, 'macos'],
    ]);
    await account.renameDevice(a.engine, ' 办公室 Mac ');
    expect(a.status.get().deviceName).toBe('办公室 Mac');
    expect((await account.listDevices(b.engine)).find((d) => !d.current)!.name).toBe('办公室 Mac');

    await expect(account.removeDevice(a.engine, a.engine.session!.deviceId)).rejects.toMatchObject({ code: 'invalid' });
    await account.removeDevice(a.engine, b.engine.session!.deviceId);
    await b.engine.syncNow();
    expect(b.status.get().state).toBe('relogin');
    await expect(account.listDevices(b.engine)).rejects.toMatchObject({ message: '获取设备列表失败：登录已失效，请重新登录' });
  });

  it('退出登录：吊销令牌、删掉同步状态和令牌，本机数据保留；连不上服务器也照样退出', async () => {
    const a = await makeClient(srv, clock);
    addServer(a, 'srv_1');
    await registerClient(a);
    const token = a.engine.sessionToken!;
    await account.logout(a.engine);
    expect(srv.sessions.has(token)).toBe(false);
    expect(a.state.load()).toBeNull();
    expect(a.vault.map.has(SESSION_SECRET)).toBe(false);
    expect(a.status.get()).toMatchObject({ state: 'off', server: null, account: null });
    expect(a.stores.hosts.get().servers).toHaveLength(1);
    expect(a.timers.next).toBeNull();

    // 退出后的改动不再记账
    addServer(a, 'srv_2');
    expect(a.state.load()).toBeNull();

    await loginClient(a);
    a.net.down = true;
    await account.logout(a.engine);
    expect(a.engine.active).toBe(false);
    expect(a.state.load()).toBeNull();
  });
});
