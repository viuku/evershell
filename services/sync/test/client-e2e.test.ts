// 端到端：两台模拟设备跑真正的同步引擎（packages/ui/src/core/sync），连这里真正的服务端代码
// （Hono + node:sqlite 内存库），不起端口、不联网。引擎自己的测试用的是内存里的假服务器，
// 这里确认两边对接口的理解一致：格式校验、错误代码、令牌吊销、分页都是真的。
// 这个文件引用了界面包的代码，不在本目录的类型检查范围里（tsconfig.json 的 exclude）。

import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, type Config } from '../src/app.ts';
import { sqliteStore } from '../src/store-sqlite.ts';
import * as account from '../../../packages/ui/src/core/sync/account.ts';
import { describeEnableResult } from '../../../packages/ui/src/core/sync/index.ts';
import {
  FakeClock,
  PASSWORD,
  SERVER_URL,
  folder,
  makeClient,
  server,
  snippet,
  view,
  type TestClient,
} from '../../../packages/ui/src/core/sync/__tests__/helpers.ts';

let clock: FakeClock;
let real: { fetch: typeof fetch; requests: string[] };

beforeEach(() => {
  clock = new FakeClock();
  const { store } = sqliteStore(new DatabaseSync(':memory:'));
  const config: Config = { pepper: 'e2e-pepper-0123456789abcdef-0123456789', inviteCode: '', quotaBytes: 50 * 1024 * 1024 };
  const app = createApp(() => ({ ok: true, deps: { store, config, now: clock.now } }));
  const requests: string[] = [];
  real = {
    requests,
    fetch: async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      requests.push(`${req.method} ${new URL(req.url).pathname}`);
      const res = await app.request(req);
      if (!res.ok && process.env.E2E_DEBUG) console.log(req.method, new URL(req.url).pathname, res.status, await res.clone().text());
      return res;
    },
  };
});

/** 模拟客户端照常建，只是网络换成真服务端 */
const client = (name: string) => makeClient(real as never, clock, name);

async function syncAll(...clients: TestClient[]) {
  for (let i = 0; i < 2; i++) {
    for (const c of clients) {
      clock.advance(10);
      await c.engine.syncNow();
    }
  }
}

const pushes = () => real.requests.filter((r) => r === 'POST /v1/records').length;

describe('两台设备连真服务端', () => {
  it('注册、第一次登录合并去重、来回改删、最后两边一致且不再来回推', async () => {
    const a = await client('MacBook Pro');
    a.stores.hosts.set({
      version: 1,
      folders: [folder('dir_a', '生产')],
      servers: [server('srv_a1', { parentId: 'dir_a', name: 'web-01', host: '203.0.113.10' }), server('srv_same_a', { name: 'db', host: '203.0.113.20' })],
    });
    a.stores.snippets.set([snippet('snp_a', '磁盘', 'df -h')]);
    a.stores.groups.set(['常用']);
    await a.vault.set('srv_a1.password', 'pw-a1');
    await a.knownHosts.editLines(() => ['203.0.113.10 ssh-ed25519 AAAA']);

    const reg = await account.register(a.engine, { server: SERVER_URL, account: 'Ops', password: PASSWORD }, () => {});
    expect(a.status.get().state).toBe('ok');
    expect(describeEnableResult(reg)).toBe('已上传本机的 2 台服务器、1 条快捷命令。');

    // 第二台：自己也有数据，其中一台和云端完全相同（换了 id），密码只存在本机这份上
    const b = await client('Mac mini');
    b.stores.hosts.set({
      version: 1,
      folders: [],
      servers: [server('srv_same_b', { name: 'db', host: '203.0.113.20' }), server('srv_b1', { name: 'cache', host: '203.0.113.30' })],
    });
    await b.vault.set('srv_same_b.password', 'pw-db');
    const joined = await account.login(b.engine, { server: SERVER_URL, account: 'ops', password: PASSWORD }, () => {});
    expect(joined.merged.servers).toBe(1);
    expect(joined.uploaded.servers).toBe(1);
    // 合并掉的那台算在“合并”里，不再算“取回”
    expect(joined.downloaded.servers).toBe(1);

    await syncAll(a, b);
    expect(await view(b)).toEqual(await view(a));
    const names = a.stores.hosts.get().servers.map((s) => s.name).sort();
    expect(names).toEqual(['cache', 'db', 'web-01']);
    // 去重时密码挪到了云端那台名下
    expect(await a.vault.get('srv_same_a.password')).toBe('pw-db');

    // A 改名、删命令；B 离线时改同一台，之后 A 又改一次：后写的赢
    a.stores.hosts.set((d) => ({ ...d, servers: d.servers.map((s) => (s.id === 'srv_a1' ? { ...s, name: 'web-01-new', updatedAt: clock.t } : s)) }));
    a.stores.snippets.set([]);
    await syncAll(a, b);
    expect(b.stores.hosts.get().servers.find((s) => s.id === 'srv_a1')?.name).toBe('web-01-new');
    expect(b.stores.snippets.get()).toEqual([]);

    b.net.down = true;
    clock.advance(1000);
    b.stores.hosts.set((d) => ({ ...d, servers: d.servers.map((s) => (s.id === 'srv_b1' ? { ...s, note: 'B 离线时改的', updatedAt: clock.t } : s)) }));
    await b.engine.syncNow();
    expect(b.status.get().state).toBe('offline');
    clock.advance(1000);
    a.stores.hosts.set((d) => ({ ...d, servers: d.servers.map((s) => (s.id === 'srv_b1' ? { ...s, note: 'A 后来改的', updatedAt: clock.t } : s)) }));
    await syncAll(a);
    b.net.down = false;
    await syncAll(a, b);
    expect(b.stores.hosts.get().servers.find((s) => s.id === 'srv_b1')?.note).toBe('A 后来改的');
    expect(await view(b)).toEqual(await view(a));

    // 都一致以后再跑几轮，一次推送都没有
    const before = pushes();
    await syncAll(a, b);
    expect(pushes()).toBe(before);
  });

  it('改密码后另一台要重新登录；移除设备后它也要重新登录', async () => {
    const a = await client('MacBook Pro');
    a.stores.hosts.set({ version: 1, folders: [], servers: [server('srv_1')] });
    await account.register(a.engine, { server: SERVER_URL, account: 'ops', password: PASSWORD }, () => {});
    const b = await client('Mac mini');
    await account.login(b.engine, { server: SERVER_URL, account: 'ops', password: PASSWORD }, () => {});

    await account.changePassword(a.engine, 'new password 123');
    clock.advance(10);
    await b.engine.syncNow();
    expect(b.status.get().state).toBe('relogin');
    await expect(account.relogin(b.engine, PASSWORD)).rejects.toThrow('同步密码不正确');
    await account.relogin(b.engine, 'new password 123');
    await syncAll(b);
    expect(b.status.get().state).toBe('ok');

    const devices = await account.listDevices(a.engine);
    expect(devices.map((d) => d.name).sort()).toEqual(['Mac mini', 'MacBook Pro']);
    const mini = devices.find((d) => !d.current)!;
    await account.removeDevice(a.engine, mini.id);
    clock.advance(10);
    await b.engine.syncNow();
    expect(b.status.get().state).toBe('relogin');
    expect((await account.listDevices(a.engine)).map((d) => d.name)).toEqual(['MacBook Pro']);
  });

  it('密码不对、账号已存在的错误文案', async () => {
    const a = await client('MacBook Pro');
    await account.register(a.engine, { server: SERVER_URL, account: 'ops', password: PASSWORD }, () => {});
    const b = await client('Mac mini');
    await expect(account.login(b.engine, { server: SERVER_URL, account: 'ops', password: 'wrong password' }, () => {})).rejects.toThrow(
      '登录失败：账号或同步密码不正确',
    );
    await expect(account.register(b.engine, { server: SERVER_URL, account: 'OPS', password: PASSWORD }, () => {})).rejects.toThrow(
      '注册失败：该账号已存在',
    );
    expect(b.status.get().state).toBe('off');
  });
});
