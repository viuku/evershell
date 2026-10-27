import { Store } from '../../store';
import { DEFAULT_ADVANCED, type FolderRecord, type HostsData, type ServerRecord } from '../../hosts-store';
import type { KeyRecord, KeysData } from '../../key-library';
import type { Snippet } from '../../snippets-store';
import type { HistoryEntry } from '../../history-store';
import type { RecentEntry } from '../../recents-store';
import { KnownHostsStore } from '../../known-hosts';
import { createMockSyncPlatform, memoryVault, MockSyncServer } from '../../../mock/mock-sync';
import * as account from '../account';
import type { SyncStores } from '../collections';
import { SyncEngine, type Timers } from '../engine';
import { emptyCounts, type SyncStatus } from '../model';
import { MemoryStateHolder } from '../state';

// 同步引擎测试用的模拟客户端：每个客户端一套独立的数据、保险箱、同步状态和定时器，连同一个内存里的假服务器

export const SERVER_URL = 'https://sync.test';
export const PASSWORD = 'correct horse';

/** 手动推进的定时器：引擎同一时间只排一个 */
export class ManualTimers implements Timers {
  private seq = 0;
  readonly queue = new Map<number, { fn: () => void; ms: number }>();

  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.queue.set(id, { fn, ms });
    return id;
  }

  clear(handle: unknown): void {
    this.queue.delete(handle as number);
  }

  /** 排着的那个定时器的延迟，没有为 null */
  get next(): number | null {
    const all = [...this.queue.values()];
    return all.length ? all[all.length - 1]!.ms : null;
  }

  fire(): void {
    const first = [...this.queue][0];
    if (!first) throw new Error('没有排着的定时器');
    this.queue.delete(first[0]);
    first[1].fn();
  }
}

/** 所有客户端和服务器共用的假时钟 */
export class FakeClock {
  t = 1_790_000_000_000;
  readonly now = () => this.t;
  advance(ms = 1000): void {
    this.t += ms;
  }
}

export function emptyStatus(): SyncStatus {
  return { state: 'off', lastSyncAt: null, message: '', server: null, account: null, deviceName: null, counts: emptyCounts() };
}

export function server(id: string, patch: Partial<ServerRecord> = {}): ServerRecord {
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
    keyId: null,
    keyLabel: null,
    advanced: { ...DEFAULT_ADVANCED },
    forwards: [],
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    lastConnectedAt: null,
    ...patch,
  };
}

export function folder(id: string, name: string, parentId: string | null = null, patch: Partial<FolderRecord> = {}): FolderRecord {
  return { id, name, parentId, createdAt: 1, updatedAt: 1, deletedAt: null, ...patch };
}

export function key(id: string, fingerprint: string, patch: Partial<KeyRecord> = {}): KeyRecord {
  return { id, name: id, algorithm: 'ED25519', bits: 256, fingerprint, createdAt: 1, updatedAt: 1, deletedAt: null, ...patch };
}

export function snippet(id: string, name: string, cmd: string, group = '常用', patch: Partial<Snippet> = {}): Snippet {
  return { id, name, cmd, group, updatedAt: 1, ...patch };
}

export function newStores(): SyncStores {
  return {
    hosts: new Store<HostsData>({ version: 1, folders: [], servers: [] }),
    keys: new Store<KeysData>({ version: 1, keys: [], migratedServerKeys: false }),
    snippets: new Store<Snippet[]>([]),
    groups: new Store<string[]>([]),
    history: new Store<HistoryEntry[]>([]),
    recents: new Store<RecentEntry[]>([]),
  };
}

export type TestClient = Awaited<ReturnType<typeof makeClient>>;

export async function makeClient(srv: MockSyncServer, clock: FakeClock, name = 'MacBook Pro') {
  const vault = memoryVault();
  const net = { down: false };
  const fetchFn: typeof fetch = (input, init) => (net.down ? Promise.reject(new TypeError('Failed to fetch')) : srv.fetch(input, init));
  const platform = createMockSyncPlatform(vault, { fetch: fetchFn, deviceName: name });
  const stores = newStores();
  const knownHosts = new KnownHostsStore(vault);
  const state = new MemoryStateHolder();
  const status = new Store<SyncStatus>(emptyStatus());
  const timers = new ManualTimers();
  const online = { value: true };
  const engine = new SyncEngine({
    platform,
    secrets: vault,
    stores,
    knownHosts,
    state,
    status,
    timers,
    now: clock.now,
    online: () => online.value,
    platformName: 'macos',
  });
  await engine.start();
  return { vault, net, platform, stores, knownHosts, state, status, timers, engine, online, name };
}

export function registerClient(c: TestClient, acct = 'ops') {
  return account.register(c.engine, { server: SERVER_URL, account: acct, password: PASSWORD }, () => {});
}

export function loginClient(c: TestClient, acct = 'ops', password = PASSWORD) {
  return account.login(c.engine, { server: SERVER_URL, account: acct, password }, () => {});
}

/** 两边比较用的数据：服务器去掉 lastConnectedAt，各列表按 id 排好 */
export async function view(c: TestClient) {
  const byId = <T extends { id: string }>(list: T[]) => [...list].sort((a, b) => (a.id < b.id ? -1 : 1));
  const hosts = c.stores.hosts.get();
  const secrets = Object.fromEntries([...c.vault.map].filter(([id]) => !id.startsWith('sync.') && id !== 'known_hosts').sort());
  return {
    folders: byId(hosts.folders),
    servers: byId(hosts.servers.map(({ lastConnectedAt: _skip, ...s }) => ({ ...s, id: s.id }))),
    keys: byId(c.stores.keys.get().keys),
    snippets: byId(c.stores.snippets.get()),
    groups: c.stores.groups.get(),
    history: byId(c.stores.history.get()),
    recents: [...c.stores.recents.get()].sort((a, b) => (a.serverId < b.serverId ? -1 : 1)),
    knownHosts: [...(await c.knownHosts.lines())].sort(),
    secrets,
  };
}

/** 服务器上某个集合的记录 */
export function serverRecords(srv: MockSyncServer, acct: string, collection: string) {
  return [...(srv.accounts.get(acct)?.records.values() ?? [])].filter((r) => r.collection === collection);
}

export function pushCount(srv: MockSyncServer): number {
  return srv.requests.filter(([m, p]) => m === 'POST' && p === '/v1/records').length;
}

export { MockSyncServer };
