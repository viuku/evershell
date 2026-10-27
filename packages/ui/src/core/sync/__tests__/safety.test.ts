import { beforeEach, describe, expect, it } from 'vitest';
import { createMockSyncPlatform, memoryVault } from '../../../mock/mock-sync';
import * as account from '../account';
import { knownHostId } from '../digest';
import { SyncEngine, VAULT_RESET_MESSAGE } from '../engine';
import { formatHlc, parseHlc } from '../hlc';
import { ledgerGet } from '../ledger';
import { SESSION_SECRET } from '../state';
import {
  FakeClock,
  MockSyncServer,
  PASSWORD,
  key,
  loginClient,
  makeClient,
  pushCount,
  registerClient,
  server,
  serverRecords,
  view,
  type TestClient,
} from './helpers';

// 审查发现的会丢数据的问题（2026-10-28），每条一个测试。假平台照 Rust 那边的规则检查，不比真的宽松

let clock: FakeClock;
let srv: MockSyncServer;

beforeEach(() => {
  clock = new FakeClock();
  srv = new MockSyncServer({ now: clock.now });
});

/** 跟着共用时钟走、但可以拨快拨慢的客户端时钟 */
function offsetClock(offset: { ms: number }): FakeClock {
  return { t: 0, now: () => clock.t + offset.ms, advance: () => {} } as unknown as FakeClock;
}

/** 重启：同一份数据、同一个同步状态，换一个新引擎 */
async function restart(c: TestClient, now: () => number = clock.now): Promise<SyncEngine> {
  c.engine.stop();
  const engine = new SyncEngine({
    platform: c.platform,
    secrets: c.vault,
    stores: c.stores,
    knownHosts: c.knownHosts,
    state: c.state,
    status: c.status,
    timers: c.timers,
    now,
    online: () => true,
    platformName: 'macos',
  });
  await engine.start();
  c.engine = engine;
  return engine;
}

describe('假平台和 Rust 一样严格', () => {
  it('普通加解密不收机密；机密的条目和附加数据要对得上；墓碑不要求条目存在', async () => {
    const vault = memoryVault({ 'srv_1.password': 'pw' });
    const p = createMockSyncPlatform(vault);
    const aad = (collection: string, id: string, deleted = false) => ({ account: 'ops', collection, id, hlc: formatHlc(1, 0, '0000000000000001'), deleted });
    await expect(p.seal([{ aad: aad('secret', 'srv_1.password'), plain: 'x' }])).rejects.toThrow('机密记录须经保险箱加解密');
    await expect(p.open([{ aad: aad('secret', 'srv_1.password'), data: 'x' }])).rejects.toThrow('机密记录须经保险箱加解密');
    await expect(p.sealSecret('srv_1.password', aad('secret', 'srv_2.password'))).rejects.toThrow('标识不匹配');
    await expect(p.sealSecret('srv_1.password', aad('server', 'srv_1.password'))).rejects.toThrow('标识不匹配');
    expect(await p.sealSecret('srv_9.password', aad('secret', 'srv_9.password'))).toBeNull();
    const tomb = await p.sealSecret('srv_9.password', aad('secret', 'srv_9.password', true));
    expect(typeof tomb).toBe('string');
    expect(await p.openSecret('srv_9.password', aad('secret', 'srv_9.password', true), tomb!)).toBe(true);
  });

  it('moveSecret：目标没有就挪过去，目标已有只删源，源不在什么都不做；keyCheck 跟着钥匙变', async () => {
    const vault = memoryVault({ a: '1', b: '2', c: '3' });
    const p = createMockSyncPlatform(vault);
    await p.moveSecret('a', 'x');
    await p.moveSecret('b', 'c');
    await p.moveSecret('nope', 'y');
    expect(Object.fromEntries(vault.map)).toEqual({ x: '1', c: '3' });
    expect(await p.keyCheck()).toBeNull();
    await p.secretDigests();
    const first = await p.keyCheck();
    expect(first).toBeTruthy();
    // 旧版本重写保险箱：条目（含编号）都在，校验值不变
    await p.simulateOldBuildRewrite();
    expect(await p.keyCheck()).toBe(first);
    p.simulateVaultRebuild({ sameKey: true });
    expect([...vault.map.keys()].filter((k) => !k.startsWith('sync.'))).toEqual([]);
    expect(await p.keyCheck()).not.toBe(first);
  });
});

describe('机密的删除', () => {
  it('取消「记住密码」：墓碑经保险箱加密推上去，别的设备删掉；之后照常拉取', async () => {
    const a = await makeClient(srv, clock, 'A');
    a.stores.hosts.set({ version: 1, folders: [], servers: [server('srv_1')] });
    await a.vault.set('srv_1.password', 'pw');
    await registerClient(a);
    const b = await makeClient(srv, clock, 'B');
    await loginClient(b);
    expect(b.vault.map.get('srv_1.password')).toBe('pw');

    await a.vault.remove('srv_1.password');
    clock.advance(1000);
    await a.engine.syncNow();
    expect(a.status.get().state).toBe('ok');
    expect(srv.record('ops', 'secret', 'srv_1.password')!.deleted).toBe(true);

    b.stores.hosts.set((d) => ({ ...d, servers: [...d.servers, server('srv_from_b', { updatedAt: clock.t })] }));
    clock.advance(1000);
    await b.engine.syncNow();
    expect(b.vault.map.has('srv_1.password')).toBe(false);
    clock.advance(1000);
    await a.engine.syncNow();
    expect(a.stores.hosts.get().servers.map((s) => s.id)).toContain('srv_from_b');
    expect(a.engine.session!.pending).toEqual([]);
  });
});

describe('保险箱重建', () => {
  it('钥匙对不上就停下要求重新登录，不发机密和 known_hosts 的墓碑；重新登录后先把云端的拉回来', async () => {
    const a = await makeClient(srv, clock, 'A');
    a.stores.hosts.set({ version: 1, folders: [], servers: [server('srv_1'), server('srv_2')] });
    await a.vault.set('srv_1.password', 'pw-1');
    await a.knownHosts.editLines(() => ['web.example ssh-ed25519 AAAA']);
    await registerClient(a);
    const b = await makeClient(srv, clock, 'B');
    await loginClient(b);
    expect(b.vault.map.get('srv_1.password')).toBe('pw-1');

    // B 的钥匙串丢了钥匙，保险箱重建：机密、known_hosts、登录令牌都没了
    b.platform.simulateVaultRebuild();
    const pushes = pushCount(srv);
    clock.advance(1000);
    await b.engine.syncNow();
    expect(b.status.get()).toMatchObject({ state: 'relogin', message: VAULT_RESET_MESSAGE });
    expect(b.timers.next).toBeNull();
    expect(pushCount(srv)).toBe(pushes);
    expect(srv.record('ops', 'secret', 'srv_1.password')!.deleted).toBe(false);
    expect(serverRecords(srv, 'ops', 'known-host').every((r) => !r.deleted)).toBe(true);
    // 重启后照样停着
    await restart(b);
    expect(b.timers.next).toBeNull();
    await b.engine.syncNow();
    expect(b.status.get()).toMatchObject({ state: 'relogin', message: VAULT_RESET_MESSAGE });

    // 重建后用户在 B 上重新存了另一台的密码
    await b.vault.set('srv_2.password', 'pw-2');
    await account.relogin(b.engine, PASSWORD);
    b.timers.fire();
    await b.engine.syncNow();
    expect(b.status.get().state).toBe('ok');
    expect(b.vault.map.get('srv_1.password')).toBe('pw-1');
    expect(await b.knownHosts.lines()).toEqual(['web.example ssh-ed25519 AAAA']);
    expect(srv.record('ops', 'secret', 'srv_2.password')?.deleted).toBe(false);
    expect(b.engine.session!.secretsResync).toBe(false);

    clock.advance(1000);
    await a.engine.syncNow();
    expect(a.vault.map.get('srv_1.password')).toBe('pw-1');
    expect(a.vault.map.get('srv_2.password')).toBe('pw-2');
    expect(await a.knownHosts.lines()).toEqual(['web.example ssh-ed25519 AAAA']);
    expect(await view(a)).toEqual(await view(b));
  });

  it('普通的重新登录（改了密码）不清机密的账本', async () => {
    const a = await makeClient(srv, clock, 'A');
    await a.vault.set('srv_1.password', 'pw');
    await registerClient(a);
    const b = await makeClient(srv, clock, 'B');
    await loginClient(b);
    await account.changePassword(a.engine, 'new password 1');
    await b.engine.syncNow();
    expect(b.status.get()).toMatchObject({ state: 'relogin', message: '' });
    await account.relogin(b.engine, 'new password 1');
    expect(b.engine.session!.secretsResync).toBe(false);
    expect(ledgerGet(b.engine.session!.ledger, 'secret', 'srv_1.password')).toBeDefined();
  });
});

describe('第一次登录合并', () => {
  it('重复服务器的密码用 moveSecret 挪到云端那台名下', async () => {
    const a = await makeClient(srv, clock, 'A');
    a.stores.hosts.set({ version: 1, folders: [], servers: [server('srv_cloud', { name: 'db', host: '203.0.113.20' })] });
    await registerClient(a);
    const b = await makeClient(srv, clock, 'B');
    b.stores.hosts.set({ version: 1, folders: [], servers: [server('srv_local', { name: 'db', host: '203.0.113.20' })] });
    await b.vault.set('srv_local.password', 'only-here');
    await loginClient(b);
    expect(b.stores.hosts.get().servers.map((s) => s.id)).toEqual(['srv_cloud']);
    expect(b.vault.map.get('srv_cloud.password')).toBe('only-here');
    expect(b.vault.map.has('srv_local.password')).toBe(false);
    clock.advance(1000);
    await a.engine.syncNow();
    expect(a.vault.map.get('srv_cloud.password')).toBe('only-here');
  });

  it('写进本机以后失败：数据恢复成合并前，挪过的密码挪回去，令牌吊销', async () => {
    const a = await makeClient(srv, clock, 'A');
    a.stores.hosts.set({ version: 1, folders: [], servers: [server('srv_cloud', { name: 'db', host: '203.0.113.20' }), server('srv_other')] });
    await registerClient(a);
    const b = await makeClient(srv, clock, 'B');
    const original = { version: 1 as const, folders: [], servers: [server('srv_local', { name: 'db', host: '203.0.113.20' })] };
    b.stores.hosts.set(original);
    b.stores.snippets.set([]);
    await b.vault.set('srv_local.password', 'only-here');
    await b.knownHosts.editLines(() => ['mine.example ssh-ed25519 MINE']);
    // 存登录令牌时保险箱写不进去
    const set = b.vault.set;
    b.vault.set = async (id, v) => {
      if (id === SESSION_SECRET) throw new Error('写入保险箱失败');
      return set(id, v);
    };
    await expect(loginClient(b)).rejects.toMatchObject({ message: '登录失败：写入保险箱失败' });
    expect(b.engine.active).toBe(false);
    expect(b.state.load()).toBeNull();
    expect(b.stores.hosts.get()).toEqual(original);
    expect(b.vault.map.get('srv_local.password')).toBe('only-here');
    expect(b.vault.map.has('srv_cloud.password')).toBe(false);
    expect(await b.knownHosts.lines()).toEqual(['mine.example ssh-ed25519 MINE']);
    expect([...srv.sessions.values()].filter((s) => s.deviceName === 'B')).toHaveLength(0);

    b.vault.set = set;
    await loginClient(b);
    expect(b.vault.map.get('srv_cloud.password')).toBe('only-here');
  });

  it('只有完全相同才合并：备注、认证方式、端口转发不同就两份都留', async () => {
    const a = await makeClient(srv, clock, 'A');
    a.stores.hosts.set({ version: 1, folders: [], servers: [server('srv_cloud', { name: 'db', host: '203.0.113.20' })] });
    await registerClient(a);
    const b = await makeClient(srv, clock, 'B');
    b.stores.keys.set({ version: 1, keys: [key('key_b', 'SHA256:bbb')], migratedServerKeys: true });
    b.stores.hosts.set({
      version: 1,
      folders: [],
      servers: [
        server('srv_local', {
          name: 'db',
          host: '203.0.113.20',
          note: 'prod primary, do not reboot',
          auth: 'key',
          keyId: 'key_b',
          forwards: [{ id: 'fw1', type: 'local', bindHost: '127.0.0.1', bindPort: 5432, targetHost: '127.0.0.1', targetPort: 5432 }],
        }),
      ],
    });
    const result = await loginClient(b);
    expect(result.merged.servers).toBe(0);
    expect(result.uploaded.servers).toBe(1);
    const local = b.stores.hosts.get().servers.find((s) => s.id === 'srv_local')!;
    expect(local).toMatchObject({ note: 'prod primary, do not reboot', auth: 'key', keyId: 'key_b' });
    expect(local.forwards).toHaveLength(1);
    expect(b.stores.hosts.get().servers).toHaveLength(2);
  });
});

describe('known_hosts 写入失败', () => {
  it('写成功才记账：失败时游标不往前，下一轮重拉写进来，不会被当成本机删除推出去', async () => {
    const a = await makeClient(srv, clock, 'A');
    await registerClient(a);
    const b = await makeClient(srv, clock, 'B');
    await loginClient(b);

    await a.knownHosts.editLines(() => ['web.example ssh-ed25519 AAAA']);
    a.stores.hosts.set({ version: 1, folders: [], servers: [server('srv_same_page', { updatedAt: clock.t })] });
    clock.advance(1000);
    await a.engine.syncNow();
    const id = await knownHostId('web.example ssh-ed25519 AAAA');

    const orig = b.knownHosts.editLines.bind(b.knownHosts);
    let fail = true;
    b.knownHosts.editLines = (edit) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error('写入保险箱失败：No space left on device'));
      }
      return orig(edit);
    };
    const cursorBefore = b.engine.session!.cursor;
    clock.advance(1000);
    await b.engine.syncNow();
    expect(b.status.get().state).toBe('error');
    // 同一页里的普通记录已经写进来并落盘，游标没动，known_hosts 没记账
    const saved = b.state.load();
    if (!saved || saved === 'future') throw new Error('同步状态没存');
    expect(saved.cursor).toBe(cursorBefore);
    expect(ledgerGet(saved.ledger, 'server', 'srv_same_page')).toBeDefined();
    expect(ledgerGet(saved.ledger, 'known-host', id)).toBeUndefined();
    expect(b.stores.hosts.get().servers.map((s) => s.id)).toEqual(['srv_same_page']);

    clock.advance(60_000);
    await b.engine.syncNow();
    expect(b.status.get().state).toBe('ok');
    expect(await b.knownHosts.lines()).toEqual(['web.example ssh-ed25519 AAAA']);
    expect(srv.record('ops', 'known-host', id)!.deleted).toBe(false);
    clock.advance(1000);
    await a.engine.syncNow();
    expect(await a.knownHosts.lines()).toEqual(['web.example ssh-ed25519 AAAA']);
  });
});

describe('时钟', () => {
  it('系统时间调快过又改回来：服务器报时间太快时拨回时钟、待上传的重新取时间戳，接着同步', async () => {
    const off = { ms: 0 };
    const a = await makeClient(srv, offsetClock(off), 'A');
    await registerClient(a);
    off.ms = 3 * 3600_000;
    a.stores.hosts.set({ version: 1, folders: [], servers: [server('srv_x', { updatedAt: clock.t })] });
    clock.advance(1000);
    await a.engine.syncNow();
    expect(a.status.get()).toMatchObject({ state: 'error', message: '本机时间与服务器相差过大，请校准系统时间' });

    off.ms = 0;
    a.stores.hosts.set((d) => ({ ...d, servers: [...d.servers, server('srv_y', { updatedAt: clock.t })] }));
    clock.advance(5 * 60_000);
    await a.engine.syncNow();
    expect(a.status.get().state).toBe('ok');
    expect(srv.record('ops', 'server', 'srv_x')).toBeDefined();
    expect(srv.record('ops', 'server', 'srv_y')).toBeDefined();
    expect(parseHlc(srv.record('ops', 'server', 'srv_x')!.hlc)!.ms).toBeLessThanOrEqual(clock.t);
  });

  it('读入状态时存下的时钟快一分钟以上：拨回现在，待上传的重新取时间戳', async () => {
    const off = { ms: 0 };
    const a = await makeClient(srv, offsetClock(off), 'A');
    await registerClient(a);
    off.ms = 3 * 3600_000;
    a.stores.hosts.set({ version: 1, folders: [], servers: [server('srv_x', { updatedAt: clock.t })] });
    a.engine.stop();
    off.ms = 0;
    const engine = await restart(a, () => clock.t);
    const st = engine.session!;
    expect(st.clock.ms).toBeLessThanOrEqual(clock.t + 60_000);
    expect(parseHlc(ledgerGet(st.ledger, 'server', 'srv_x')![0])!.ms).toBeLessThanOrEqual(clock.t);
    await engine.syncNow();
    expect(a.status.get().state).toBe('ok');
    expect(srv.record('ops', 'server', 'srv_x')).toBeDefined();
  });
});

describe('升级后认识了新的集合', () => {
  it('同步状态里记的集合版本比引擎旧：游标归零，补上旧版本跳过的记录', async () => {
    const a = await makeClient(srv, clock, 'A');
    await a.knownHosts.editLines(() => ['web.example ssh-ed25519 AAAA']);
    await registerClient(a);
    const b = await makeClient(srv, clock, 'B');
    await loginClient(b);
    // 假装 B 是不认识 known-host 集合的旧版本：本机没有这行、账本里没有，游标已经走过去了
    const id = await knownHostId('web.example ssh-ed25519 AAAA');
    b.engine.stop();
    await b.knownHosts.editLines(() => []);
    const saved = JSON.parse(b.state.json!);
    delete saved.ledger['known-host'][id];
    saved.collectionsVersion = 0;
    b.state.json = JSON.stringify(saved);

    const engine = await restart(b);
    expect(engine.session!.cursor).toBe(0);
    await engine.syncNow();
    expect(await b.knownHosts.lines()).toEqual(['web.example ssh-ed25519 AAAA']);
    expect(srv.record('ops', 'known-host', id)!.deleted).toBe(false);
    expect(engine.session!.collectionsVersion).toBeGreaterThan(0);
  });
});

async function syncAll(...cs: TestClient[]) {
  for (let i = 0; i < 2; i++)
    for (const c of cs) {
      clock.advance(10);
      await c.engine.syncNow();
    }
}

// 第二轮审查（2026-10-28）发现的问题，R1～R4
describe('第二轮审查', () => {
  it('R1 保险箱被清空但钥匙没变：兜底发现，不发墓碑；重新登录后从云端拉回来', async () => {
    const a = await makeClient(srv, clock, 'A');
    a.stores.hosts.set({ version: 1, folders: [], servers: [server('srv_1'), server('srv_2')] });
    await a.vault.set('srv_1.password', 'pw-1');
    await a.vault.set('srv_2.password', 'pw-2');
    await a.knownHosts.editLines(() => ['web.example ssh-ed25519 AAAA']);
    await registerClient(a);
    const b = await makeClient(srv, clock, 'B');
    await loginClient(b);

    // 保险箱被清空（含登录令牌），而平台给的校验值没变（比如编号没跟着丢）：只能靠兜底发现
    const pinned = await b.platform.keyCheck();
    b.platform.keyCheck = async () => pinned;
    for (const id of b.vault.ids()) await b.vault.remove(id);
    const pushes = pushCount(srv);
    clock.advance(1000);
    await b.engine.syncNow();
    expect(b.status.get()).toMatchObject({ state: 'relogin', message: VAULT_RESET_MESSAGE });
    expect(pushCount(srv)).toBe(pushes);
    await restart(b);
    expect(b.status.get()).toMatchObject({ state: 'relogin', message: VAULT_RESET_MESSAGE });

    await account.relogin(b.engine, PASSWORD);
    clock.advance(1000);
    await b.engine.syncNow();
    expect(b.status.get().state).toBe('ok');
    expect(b.vault.map.get('srv_1.password')).toBe('pw-1');
    expect(b.vault.map.get('srv_2.password')).toBe('pw-2');
    expect(await b.knownHosts.lines()).toEqual(['web.example ssh-ed25519 AAAA']);
    expect(srv.record('ops', 'secret', 'srv_1.password')!.deleted).toBe(false);
    expect(serverRecords(srv, 'ops', 'known-host').every((r) => !r.deleted)).toBe(true);
    clock.advance(1000);
    await a.engine.syncNow();
    expect(a.vault.map.get('srv_1.password')).toBe('pw-1');
    expect(await a.knownHosts.lines()).toEqual(['web.example ssh-ed25519 AAAA']);
  });

  it('R1 平台的保险箱编号变了（重建、钥匙不变）也能发现', async () => {
    const a = await makeClient(srv, clock, 'A');
    await a.vault.set('srv_1.password', 'pw-1');
    await registerClient(a);
    a.platform.simulateVaultRebuild({ sameKey: true });
    // 用户重建后马上又存了一条，兜底条件不成立，只靠校验值
    await a.vault.set('srv_9.password', 'new');
    clock.advance(1000);
    await a.engine.syncNow();
    expect(a.status.get()).toMatchObject({ state: 'relogin', message: VAULT_RESET_MESSAGE });
    expect(srv.record('ops', 'secret', 'srv_1.password')!.deleted).toBe(false);
  });

  it('R2 重建后的重拉只补本机缺的：重建后存的密码不被云端的旧值覆盖、不被云端的墓碑删掉，之后推上去', async () => {
    const a = await makeClient(srv, clock, 'A');
    a.stores.hosts.set({ version: 1, folders: [], servers: [server('srv_1'), server('srv_2'), server('srv_3')] });
    await a.vault.set('srv_1.password', 'old-pw');
    await a.vault.set('srv_2.password', 'pw-2');
    await a.vault.set('srv_3.password', 'x');
    await registerClient(a);
    const b = await makeClient(srv, clock, 'B');
    await loginClient(b);
    await a.vault.remove('srv_3.password');
    await syncAll(a, b);
    expect(srv.record('ops', 'secret', 'srv_3.password')!.deleted).toBe(true);

    b.platform.simulateVaultRebuild();
    clock.advance(1000);
    await b.engine.syncNow();
    expect(b.status.get().state).toBe('relogin');
    await b.vault.set('srv_1.password', 'NEW-pw');
    await b.vault.set('srv_3.password', 'saved-after-reset');
    await account.relogin(b.engine, PASSWORD);
    clock.advance(1000);
    await b.engine.syncNow();
    expect(b.status.get().state).toBe('ok');
    expect(b.vault.map.get('srv_1.password')).toBe('NEW-pw');
    expect(b.vault.map.get('srv_3.password')).toBe('saved-after-reset');
    // 本机缺的从云端补回来
    expect(b.vault.map.get('srv_2.password')).toBe('pw-2');

    clock.advance(1000);
    await a.engine.syncNow();
    expect(a.vault.map.get('srv_1.password')).toBe('NEW-pw');
    expect(a.vault.map.get('srv_3.password')).toBe('saved-after-reset');
    await syncAll(a, b);
    expect(await view(a)).toEqual(await view(b));
  });

  it('R3 第一次登录回滚：本机重复服务器的密码还在，云端的机密不留在本机', async () => {
    const a = await makeClient(srv, clock, 'A');
    a.stores.hosts.set({ version: 1, folders: [], servers: [server('srv_cloud', { name: 'db', host: '203.0.113.20' })] });
    await a.vault.set('srv_cloud.password', 'cloud-pw');
    await registerClient(a);

    const b = await makeClient(srv, clock, 'B');
    const original = { version: 1 as const, folders: [], servers: [server('srv_local', { name: 'db', host: '203.0.113.20' })] };
    b.stores.hosts.set(original);
    await b.vault.set('srv_local.password', 'local-pw');
    // 令牌存得进去，开启时同步状态却出错
    const activate = b.engine.activate.bind(b.engine);
    b.engine.activate = async () => {
      throw new Error('写入同步状态失败');
    };
    await expect(loginClient(b)).rejects.toMatchObject({ message: '登录失败：写入同步状态失败' });
    expect(b.stores.hosts.get()).toEqual(original);
    expect(Object.fromEntries([...b.vault.map].filter(([k]) => !k.startsWith('sync.')))).toEqual({ 'srv_local.password': 'local-pw' });

    b.engine.activate = activate;
    await loginClient(b);
    expect(b.stores.hosts.get().servers.map((s) => s.id)).toEqual(['srv_cloud']);
    expect(b.vault.map.get('srv_cloud.password')).toBe('cloud-pw');
    expect(b.vault.map.has('srv_local.password')).toBe(false);
  });

  it('R4 拨回时钟不拨到见过的远端时间戳以下：看到别人的改动之后再改，后改的赢并同步过去', async () => {
    const offB = { ms: 5 * 60_000 };
    const a = await makeClient(srv, clock, 'A');
    a.stores.hosts.set({ version: 1, folders: [], servers: [server('srv_x', { note: 'v0' })] });
    await registerClient(a);
    const b = await makeClient(srv, offsetClock(offB), 'B');
    await loginClient(b);

    b.stores.hosts.set((d) => ({ ...d, servers: d.servers.map((s) => ({ ...s, note: 'from B', updatedAt: clock.t })) }));
    clock.advance(1000);
    await b.engine.syncNow();
    clock.advance(1000);
    await a.engine.syncNow();
    expect(a.stores.hosts.get().servers[0]!.note).toBe('from B');
    expect(a.engine.session!.maxSeen).toBe(srv.record('ops', 'server', 'srv_x')!.hlc);

    clock.advance(60_000);
    await restart(a);
    clock.advance(1000);
    a.stores.hosts.set((d) => ({ ...d, servers: d.servers.map((s) => ({ ...s, note: 'from A, later', updatedAt: clock.t })) }));
    await syncAll(a, b);
    expect(a.stores.hosts.get().servers[0]!.note).toBe('from A, later');
    expect(b.stores.hosts.get().servers[0]!.note).toBe('from A, later');
    expect(a.engine.session!.pending).toEqual([]);
  });
});

// 第三轮审查（2026-10-28）：保险箱其实没坏时不能误判成重建
describe('第三轮审查', () => {
  async function pairWithSecrets() {
    const a = await makeClient(srv, clock, 'A');
    a.stores.hosts.set({ version: 1, folders: [], servers: [server('srv_1'), server('srv_2')] });
    await a.vault.set('srv_1.password', 'pw-1');
    await a.vault.set('srv_2.password', 'pw-2');
    await a.knownHosts.editLines(() => ['web.example ssh-ed25519 AAAA']);
    await registerClient(a);
    const b = await makeClient(srv, clock, 'B');
    await loginClient(b);
    return { a, b };
  }

  it('旧版本整份重写过保险箱（条目都在）：不算重建，不推任何东西，别的设备的改动照常拉下来', async () => {
    const { a, b } = await pairWithSecrets();
    await b.platform.simulateOldBuildRewrite();
    await a.vault.set('srv_1.password', 'pw-1-changed');
    await a.vault.remove('srv_2.password');
    clock.advance(1000);
    await a.engine.syncNow();
    const pushes = pushCount(srv);
    clock.advance(1000);
    await b.engine.syncNow();
    expect(b.status.get().state).toBe('ok');
    expect(b.engine.session!.vaultReset).toBe(false);
    expect(pushCount(srv)).toBe(pushes);
    expect(b.vault.map.get('srv_1.password')).toBe('pw-1-changed');
    expect(b.vault.map.has('srv_2.password')).toBe(false);
  });

  it('读钥匙校验值出错一次：这一轮同步失败、照常退避，不记成重建；下一轮恢复', async () => {
    const { b } = await pairWithSecrets();
    const real = b.platform.keyCheck.bind(b.platform);
    let fail = true;
    b.platform.keyCheck = async () => {
      if (fail) {
        fail = false;
        throw new Error('钥匙串暂时无法访问');
      }
      return real();
    };
    const pushes = pushCount(srv);
    clock.advance(1000);
    await b.engine.syncNow();
    expect(b.status.get()).toMatchObject({ state: 'error', message: '无法读取本机保险箱钥匙，稍后将自动重试' });
    expect(b.engine.session!.vaultReset).toBe(false);
    expect(b.timers.next).toBe(30_000);
    expect(pushCount(srv)).toBe(pushes);

    b.timers.fire();
    await b.engine.syncNow();
    expect(b.status.get().state).toBe('ok');
    expect(b.engine.session!.vaultReset).toBe(false);
    expect(b.vault.map.get('srv_1.password')).toBe('pw-1');
    expect(pushCount(srv)).toBe(pushes);
  });

  it('重新登录时读不了钥匙校验值：登录失败，不清机密的账本', async () => {
    const { a, b } = await pairWithSecrets();
    await account.changePassword(a.engine, 'new password 1');
    await b.engine.syncNow();
    expect(b.status.get().state).toBe('relogin');
    const real = b.platform.keyCheck.bind(b.platform);
    b.platform.keyCheck = async () => {
      throw new Error('钥匙串暂时无法访问');
    };
    await expect(account.relogin(b.engine, 'new password 1')).rejects.toMatchObject({ message: '登录失败：无法读取本机保险箱钥匙，稍后将自动重试' });
    b.platform.keyCheck = real;
    await account.relogin(b.engine, 'new password 1');
    expect(b.engine.session!.secretsResync).toBe(false);
    expect(ledgerGet(b.engine.session!.ledger, 'secret', 'srv_1.password')).toBeDefined();
  });
});
