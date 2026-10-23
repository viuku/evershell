import { describe, expect, it, vi } from 'vitest';
import { askServerPassword, authForReconnect, isAuthFailure, isBlankPassword, resolveAuth, secretKeys, type AuthPrompts } from '../connect';
import { DEFAULT_ADVANCED, type ServerRecord } from '../hosts-store';
import type { SecretStore } from '../../types';

function memorySecrets(initial: Record<string, string> = {}, available = true): SecretStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial));
  return {
    available,
    map,
    get: async (id) => map.get(id) ?? null,
    set: async (id, secret) => void map.set(id, secret),
    remove: async (id) => void map.delete(id),
  };
}

function prompts(password: AuthPrompts['askPassword'] = async () => null): AuthPrompts {
  return { askPassword: vi.fn(password), askPrivateKey: vi.fn(async () => null) };
}

const server: ServerRecord = {
  id: 'srv1',
  parentId: null,
  name: 'lab-router',
  host: '192.0.2.1',
  port: 22,
  user: 'root',
  note: '',
  proto: 'ssh',
  auth: 'password',
  keyLabel: null,
  advanced: { ...DEFAULT_ADVANCED },
  forwards: [],
  createdAt: 0,
  updatedAt: 0,
  deletedAt: null,
  lastConnectedAt: null,
};

const target = { serverId: 'srv1', name: 'lab-router', host: '192.0.2.1', port: 2200, user: 'root' };

describe('resolveAuth（密码认证）', () => {
  it('有保存的密码就用它', async () => {
    const p = prompts();
    const auth = await resolveAuth(server, memorySecrets({ [secretKeys.password('srv1')]: 'pw' }), p);
    expect(auth).toEqual({ type: 'password', password: 'pw' });
    expect(p.askPassword).not.toHaveBeenCalled();
  });

  it('没存密码时不弹框，先不带密码连', async () => {
    const p = prompts();
    const auth = await resolveAuth(server, memorySecrets(), p);
    expect(auth).toEqual({ type: 'password', password: '' });
    expect(p.askPassword).not.toHaveBeenCalled();
  });

  it('网页端没有保险箱，也是先不带密码连', async () => {
    const auth = await resolveAuth(server, memorySecrets({}, false), prompts());
    expect(auth).toEqual({ type: 'password', password: '' });
  });
});

describe('askServerPassword', () => {
  it('勾了记住密码就存进保险箱', async () => {
    const secrets = memorySecrets();
    const p = prompts(async () => ({ password: 'pw', remember: true }));
    expect(await askServerPassword(target, secrets, p)).toBe('pw');
    expect(secrets.map.get(secretKeys.password('srv1'))).toBe('pw');
    expect(p.askPassword).toHaveBeenCalledWith({ title: '连接 lab-router', message: 'root@192.0.2.1:2200 需要密码', canRemember: true });
  });

  it('没勾记住密码、或是临时连接，不保存', async () => {
    const secrets = memorySecrets();
    await askServerPassword(target, secrets, prompts(async () => ({ password: 'pw', remember: false })));
    await askServerPassword({ ...target, serverId: null }, secrets, prompts(async () => ({ password: 'pw', remember: true })));
    expect(secrets.map.size).toBe(0);
  });

  it('取消返回 null', async () => {
    expect(await askServerPassword(target, memorySecrets(), prompts())).toBeNull();
  });
});

describe('认出“服务器要密码”', () => {
  it('只有空密码算不带密码', () => {
    expect(isBlankPassword({ type: 'password', password: '' })).toBe(true);
    expect(isBlankPassword({ type: 'password', password: ' ' })).toBe(false);
    expect(isBlankPassword({ type: 'key', privateKey: 'k' })).toBe(false);
  });

  it('按内核报错的开头认认证失败', () => {
    expect(isAuthFailure('认证失败：用户名、密码或私钥不正确')).toBe(true);
    expect(isAuthFailure('连接超时：服务器无响应')).toBe(false);
  });
});

describe('重连用哪份认证', () => {
  const typed = { host: '192.0.2.1', port: 22, user: 'root', auth: { type: 'password' as const, password: 'typed-in' } };

  it('连接管理器没存密码时，沿用这次输过的', () => {
    const fresh = { ...typed, auth: { type: 'password' as const, password: '' } };
    expect(authForReconnect(fresh, typed)).toEqual(typed.auth);
  });

  it('连接管理器里有新密码就用新的', () => {
    const fresh = { ...typed, auth: { type: 'password' as const, password: 'saved' } };
    expect(authForReconnect(fresh, typed)).toEqual(fresh.auth);
  });

  it('改了主机、端口或用户名，不带旧密码过去', () => {
    const blank = { type: 'password' as const, password: '' };
    expect(authForReconnect({ ...typed, host: '192.0.2.9', auth: blank }, typed)).toEqual(blank);
    expect(authForReconnect({ ...typed, port: 2222, auth: blank }, typed)).toEqual(blank);
    expect(authForReconnect({ ...typed, user: 'admin', auth: blank }, typed)).toEqual(blank);
  });

  it('改成公钥认证就用公钥', () => {
    const fresh = { ...typed, auth: { type: 'key' as const, privateKey: 'k' } };
    expect(authForReconnect(fresh, typed)).toEqual(fresh.auth);
  });
});
