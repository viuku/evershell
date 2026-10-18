import { describe, expect, it } from 'vitest';
import type { HostKeyInfo, SecretStore } from '../../types';
import { applyHostKeyDecision, KnownHostsStore, lineFor, withTrustOnce } from '../known-hosts';

function memorySecrets(): SecretStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    available: true,
    get: async (id) => data.get(id) ?? null,
    set: async (id, v) => void data.set(id, v),
    remove: async (id) => void data.delete(id),
  };
}

const keyA: HostKeyInfo = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:aaa', openssh: 'ssh-ed25519 AAAAkeyA' };
const keyB: HostKeyInfo = { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:bbb', openssh: 'ssh-ed25519 AAAAkeyB' };

describe('KnownHostsStore', () => {
  it('写法和 OpenSSH 一致：22 端口只写主机名，其它端口写 [host]:port', () => {
    expect(lineFor('srv.example', 22, keyA)).toBe('srv.example ssh-ed25519 AAAAkeyA');
    expect(lineFor('10.0.0.5', 2222, keyA)).toBe('[10.0.0.5]:2222 ssh-ed25519 AAAAkeyA');
  });

  it('信任后追加一行，存在保险箱里', async () => {
    const secrets = memorySecrets();
    const store = new KnownHostsStore(secrets);
    await store.trust('a.example', 22, keyA);
    await store.trust('b.example', 2200, keyB);
    expect(await store.load()).toBe('a.example ssh-ed25519 AAAAkeyA\n[b.example]:2200 ssh-ed25519 AAAAkeyB\n');
    expect(secrets.data.has('known_hosts')).toBe(true);
  });

  it('更新指纹只删属于这台服务器的旧行，别的记录和带通配的行原样保留', async () => {
    const secrets = memorySecrets();
    secrets.data.set(
      'known_hosts',
      '# 从 OpenSSH 导入\nother.example ssh-ed25519 AAAAkeyB\nsrv.example ssh-ed25519 AAAAkeyA\n*.example ssh-ed25519 AAAAkeyA\n',
    );
    const store = new KnownHostsStore(secrets);
    await store.replace({
      kind: 'changed',
      host: 'srv.example',
      port: 22,
      key: keyB,
      recorded: [
        { key: keyA, line: 'srv.example ssh-ed25519 AAAAkeyA', exact: true },
        { key: keyA, line: '*.example ssh-ed25519 AAAAkeyA', exact: false },
      ],
    });
    expect(await store.load()).toBe(
      '# 从 OpenSSH 导入\nother.example ssh-ed25519 AAAAkeyB\n*.example ssh-ed25519 AAAAkeyA\nsrv.example ssh-ed25519 AAAAkeyB\n',
    );
  });

  it('同时信任两台不会互相覆盖', async () => {
    const store = new KnownHostsStore(memorySecrets());
    await Promise.all([store.trust('a', 22, keyA), store.trust('b', 22, keyB)]);
    const text = await store.load();
    expect(text).toContain('a ssh-ed25519 AAAAkeyA');
    expect(text).toContain('b ssh-ed25519 AAAAkeyB');
  });

  it('读不出保险箱时当作空记录', async () => {
    const store = new KnownHostsStore({
      available: true,
      get: async () => {
        throw new Error('钥匙串拒绝访问');
      },
      set: async () => {},
      remove: async () => {},
    });
    expect(await store.load()).toBe('');
  });
});

describe('applyHostKeyDecision', () => {
  const unknown = { kind: 'unknown' as const, host: 'h', port: 2222, key: keyA, otherTypes: [] };
  const changed = {
    kind: 'changed' as const,
    host: 'h',
    port: 22,
    key: keyB,
    recorded: [{ key: keyA, line: 'h ssh-ed25519 AAAAkeyA', exact: true }],
  };

  it('接受并保存：记下后重连', async () => {
    const store = new KnownHostsStore(memorySecrets());
    expect(await applyHostKeyDecision(store, unknown, 'trust')).toEqual({ retry: true, trustOnce: '' });
    expect(await store.load()).toBe('[h]:2222 ssh-ed25519 AAAAkeyA\n');
  });

  it('只接受本次：不保存，只给这一次的临时记录', async () => {
    const store = new KnownHostsStore(memorySecrets());
    const outcome = await applyHostKeyDecision(store, unknown, 'once');
    expect(outcome).toEqual({ retry: true, trustOnce: '[h]:2222 ssh-ed25519 AAAAkeyA' });
    expect(await store.load()).toBe('');
    expect(withTrustOnce('a b c', '[h]:2222 ssh-ed25519 AAAAkeyA')).toBe('a b c\n[h]:2222 ssh-ed25519 AAAAkeyA\n');
  });

  it('密钥变了只有“更新”能连，“只接受本次”不算数', async () => {
    const secrets = memorySecrets();
    secrets.data.set('known_hosts', 'h ssh-ed25519 AAAAkeyA\n');
    const store = new KnownHostsStore(secrets);
    expect(await applyHostKeyDecision(store, changed, 'once')).toEqual({ retry: false });
    expect(await applyHostKeyDecision(store, changed, 'trust')).toEqual({ retry: false });
    expect(await store.load()).toBe('h ssh-ed25519 AAAAkeyA\n');
    expect(await applyHostKeyDecision(store, changed, 'update')).toEqual({ retry: true, trustOnce: '' });
    expect(await store.load()).toBe('h ssh-ed25519 AAAAkeyB\n');
  });

  it('取消就不连', async () => {
    const store = new KnownHostsStore(memorySecrets());
    expect(await applyHostKeyDecision(store, unknown, 'cancel')).toEqual({ retry: false });
  });
});
