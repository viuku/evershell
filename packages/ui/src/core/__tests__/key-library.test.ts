import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAuth, type AuthPrompts } from '../connect';
import { DEFAULT_ADVANCED, hostsStore, type ServerRecord } from '../hosts-store';
import { keySecrets, keysStore, keyUsers, KeyLibrary, liveKeys, migrateServerKeys } from '../key-library';
import type { PrivateKeyInfo, SecretStore } from '../../types';

function memorySecrets(initial: Record<string, string> = {}): SecretStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    available: true,
    map,
    get: async (id) => map.get(id) ?? null,
    set: async (id, secret) => void map.set(id, secret),
    remove: async (id) => void map.delete(id),
  };
}

/** 假的认私钥：KEY:<名字> 是普通私钥，LOCKED:<名字> 要口令 pw，指纹按名字算；PUB 开头是公钥，其他认不出 */
async function inspect(text: string, passphrase?: string): Promise<PrivateKeyInfo> {
  const [kind, name] = text.split(':');
  if (kind === 'KEY') return { algorithm: 'ED25519', bits: 256, fingerprint: `fp-${name}`, encrypted: false };
  if (kind === 'LOCKED') {
    if (!passphrase) throw new Error('这把私钥设了口令，请填上口令');
    if (passphrase !== 'pw') throw new Error('口令不对');
    return { algorithm: 'RSA', bits: 2048, fingerprint: `fp-${name}`, encrypted: true };
  }
  if (kind === 'PUB') throw new Error('这是公钥');
  throw new Error('认不出这个私钥');
}

function server(id: string, patch: Partial<ServerRecord> = {}): ServerRecord {
  return {
    id,
    parentId: null,
    name: id,
    host: '192.0.2.1',
    port: 22,
    user: 'root',
    note: '',
    proto: 'ssh',
    auth: 'key',
    keyId: null,
    keyLabel: null,
    advanced: { ...DEFAULT_ADVANCED },
    forwards: [],
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
    lastConnectedAt: null,
    ...patch,
  };
}

function setServers(servers: ServerRecord[]) {
  hostsStore.set({ version: 1, folders: [], servers });
}

const serverById = (id: string) => hostsStore.get().servers.find((s) => s.id === id)!;

beforeEach(() => {
  keysStore.set({ version: 1, keys: [], migratedServerKeys: false });
  setServers([]);
});

describe('私钥库：导入、删除', () => {
  it('导入时认出类型，原文进保险箱；同一把再导入不新建', async () => {
    const secrets = memorySecrets();
    const lib = new KeyLibrary(secrets, inspect);
    const { key, duplicate } = await lib.add({ privateKey: 'KEY:a', passphrase: '', name: 'aws' });
    expect(duplicate).toBe(false);
    expect(key).toMatchObject({ name: 'aws', algorithm: 'ED25519', bits: 256, fingerprint: 'fp-a' });
    expect(secrets.map.get(keySecrets.text(key.id))).toBe('KEY:a');

    const again = await lib.add({ privateKey: 'KEY:a', passphrase: '', name: '别的名字' });
    expect(again).toEqual({ key, duplicate: true });
    expect(liveKeys(keysStore.get())).toHaveLength(1);
  });

  it('口令只在私钥设了口令时才存；口令不对就什么都不写', async () => {
    const secrets = memorySecrets();
    const lib = new KeyLibrary(secrets, inspect);
    const plain = await lib.add({ privateKey: 'KEY:a', passphrase: 'typed', name: 'a' });
    expect(secrets.map.has(keySecrets.passphrase(plain.key.id))).toBe(false);
    const locked = await lib.add({ privateKey: 'LOCKED:b', passphrase: 'pw', name: 'b' });
    expect(await lib.load(locked.key.id)).toEqual({ privateKey: 'LOCKED:b', passphrase: 'pw' });

    await expect(lib.add({ privateKey: 'LOCKED:c', passphrase: 'nope', name: 'c' })).rejects.toThrow('口令不对');
    await expect(lib.add({ privateKey: 'PUB:x', passphrase: '', name: 'x' })).rejects.toThrow('公钥');
    expect(liveKeys(keysStore.get())).toHaveLength(2);
    expect(secrets.map.size).toBe(3);
  });

  it('重名时加序号', async () => {
    const lib = new KeyLibrary(memorySecrets(), inspect);
    await lib.add({ privateKey: 'KEY:a', passphrase: '', name: 'id_rsa' });
    const second = await lib.add({ privateKey: 'KEY:b', passphrase: '', name: 'id_rsa' });
    expect(second.key.name).toBe('id_rsa (2)');
  });

  it('删除：保险箱里的立刻删，选了它的服务器变回未选择', async () => {
    const secrets = memorySecrets();
    const lib = new KeyLibrary(secrets, inspect);
    const { key } = await lib.add({ privateKey: 'LOCKED:a', passphrase: 'pw', name: 'a' });
    setServers([server('s1', { keyId: key.id }), server('s2', { keyId: key.id, deletedAt: 1 }), server('s3')]);
    expect(keyUsers(hostsStore.get(), key.id)).toBe(1);

    await lib.remove(key.id);
    expect(liveKeys(keysStore.get())).toHaveLength(0);
    expect(keysStore.get().keys[0]!.deletedAt).not.toBeNull();
    expect(secrets.map.size).toBe(0);
    expect(serverById('s1').keyId).toBeNull();
    expect(await lib.load(key.id)).toBeNull();
  });

  it('没有保险箱或认不了私钥（网页端）就没有私钥库', () => {
    expect(new KeyLibrary({ ...memorySecrets(), available: false }, inspect).available).toBe(false);
    expect(new KeyLibrary(memorySecrets()).available).toBe(false);
    expect(new KeyLibrary(memorySecrets(), inspect).available).toBe(true);
  });
});

describe('以前跟着服务器存的私钥搬进私钥库', () => {
  it('同一把私钥只建一条，名称用原来的文件名，旧条目删掉', async () => {
    const secrets = memorySecrets({
      's1.privateKey': 'KEY:a',
      's2.privateKey': 'KEY:a',
      's3.privateKey': 'LOCKED:b',
      's3.passphrase': 'pw',
      's4.privateKey': 'KEY:c',
    });
    setServers([
      server('s1', { keyLabel: 'id_ed25519' }),
      server('s2', { keyLabel: '已粘贴私钥' }),
      server('s3', { name: 'dmit-hk', keyLabel: '已粘贴私钥' }),
      server('s4', { keyLabel: 'id_ed25519' }),
      server('s5'),
      server('s6', { auth: 'password' }),
    ]);
    const lib = new KeyLibrary(secrets, inspect);

    expect(await migrateServerKeys(lib, secrets)).toBe(true);
    const keys = liveKeys(keysStore.get());
    expect(keys.map((k) => k.name)).toEqual(['id_ed25519', 'dmit-hk', 'id_ed25519 (2)']);
    expect(serverById('s1').keyId).toBe(keys[0]!.id);
    expect(serverById('s2').keyId).toBe(keys[0]!.id);
    expect(serverById('s3').keyId).toBe(keys[1]!.id);
    expect(serverById('s5').keyId).toBeNull();
    expect(await lib.load(keys[1]!.id)).toEqual({ privateKey: 'LOCKED:b', passphrase: 'pw' });
    // 旧的按服务器存的都删了，只剩私钥库的三把（一把带口令）
    expect([...secrets.map.keys()].filter((k) => k.startsWith('s'))).toEqual([]);
    expect(secrets.map.size).toBe(4);
    expect(keysStore.get().migratedServerKeys).toBe(true);
  });

  it('认不出来的私钥也搬，按原文认同一把', async () => {
    const secrets = memorySecrets({ 's1.privateKey': 'OLD-FORMAT', 's2.privateKey': 'OLD-FORMAT' });
    setServers([server('s1'), server('s2')]);
    expect(await migrateServerKeys(new KeyLibrary(secrets, inspect), secrets)).toBe(true);
    const keys = liveKeys(keysStore.get());
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ name: 's1', algorithm: '', bits: 0, fingerprint: null });
    expect(serverById('s2').keyId).toBe(keys[0]!.id);
  });

  it('保险箱写不进去就停下，旧条目不动，下次再试', async () => {
    const secrets = memorySecrets({ 's1.privateKey': 'KEY:a' });
    const broken = { ...secrets, set: vi.fn(async () => Promise.reject(new Error('disk full'))) };
    setServers([server('s1')]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await migrateServerKeys(new KeyLibrary(broken, inspect), broken)).toBe(false);
    expect(secrets.map.get('s1.privateKey')).toBe('KEY:a');
    expect(serverById('s1').keyId).toBeNull();
    expect(keysStore.get().migratedServerKeys).toBe(false);

    expect(await migrateServerKeys(new KeyLibrary(secrets, inspect), secrets)).toBe(true);
    expect(serverById('s1').keyId).not.toBeNull();
  });

  it('搬完就不再查保险箱', async () => {
    const secrets = memorySecrets();
    const get = vi.spyOn(secrets, 'get');
    keysStore.set((d) => ({ ...d, migratedServerKeys: true }));
    setServers([server('s1')]);
    expect(await migrateServerKeys(new KeyLibrary(secrets, inspect), secrets)).toBe(true);
    expect(get).not.toHaveBeenCalled();
  });
});

describe('连接时用私钥库里的私钥', () => {
  const prompts = (key: Awaited<ReturnType<AuthPrompts['askPrivateKey']>> = null): AuthPrompts => ({
    askPassword: vi.fn(async () => null),
    askPrivateKey: vi.fn(async () => key),
  });

  it('选了私钥就直接用，不弹框', async () => {
    const secrets = memorySecrets();
    const lib = new KeyLibrary(secrets, inspect);
    const { key } = await lib.add({ privateKey: 'LOCKED:a', passphrase: 'pw', name: 'a' });
    const s = server('s1', { keyId: key.id });
    setServers([s]);
    const p = prompts();
    expect(await resolveAuth(s, secrets, p, lib)).toEqual({ type: 'key', privateKey: 'LOCKED:a', passphrase: 'pw' });
    expect(p.askPrivateKey).not.toHaveBeenCalled();
  });

  it('没选私钥就弹框；勾了记住放进私钥库并记到这台服务器上，库里已有的同一把直接用', async () => {
    const secrets = memorySecrets();
    const lib = new KeyLibrary(secrets, inspect);
    const existing = await lib.add({ privateKey: 'KEY:a', passphrase: '', name: 'aws' });
    const s = server('s1', { keyLabel: 'id_rsa' });
    setServers([s]);
    const p = prompts({ privateKey: 'KEY:a', passphrase: '', remember: true, fileName: 'id_ed25519' });

    expect(await resolveAuth(s, secrets, p, lib)).toEqual({ type: 'key', privateKey: 'KEY:a', passphrase: undefined });
    expect(p.askPrivateKey).toHaveBeenCalledWith({
      title: '连接 s1',
      message: 'root@192.0.2.1 使用公钥认证，请选择私钥文件（原来用的是 id_rsa）',
      canRemember: true,
    });
    expect(serverById('s1').keyId).toBe(existing.key.id);
    expect(liveKeys(keysStore.get())).toHaveLength(1);
  });

  it('网页端没有私钥库：不提供记住，也不存', async () => {
    const secrets = { ...memorySecrets(), available: false };
    const s = server('s1');
    setServers([s]);
    const p = prompts({ privateKey: 'KEY:a', passphrase: '', remember: true, fileName: null });
    expect(await resolveAuth(s, secrets, p)).toEqual({ type: 'key', privateKey: 'KEY:a', passphrase: undefined });
    expect(p.askPrivateKey).toHaveBeenCalledWith(expect.objectContaining({ canRemember: false }));
    expect(serverById('s1').keyId).toBeNull();
  });
});
