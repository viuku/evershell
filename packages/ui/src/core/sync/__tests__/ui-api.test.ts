import { afterEach, describe, expect, it } from 'vitest';
import { createMockBackend } from '../../../mock/mock-backend';
import { hostsStore } from '../../hosts-store';
import { emptyCounts } from '../model';
import {
  describeEnableResult,
  login,
  logout,
  serverInfo,
  startSync,
  syncNow,
  syncStatus,
  syncSupported,
  syncUnavailableReason,
  validateEnableForm,
  type EnableResult,
} from '../index';

const base = { server: 'https://sync.example.com', account: 'ops', password: '12345678' };

describe('开启表单的检查', () => {
  it('提示依次是：地址和账号、https、密码、长度、确认密码、邀请码', () => {
    expect(validateEnableForm({ ...base, mode: 'login', server: ' ' })).toBe('请填写服务器地址和账号');
    expect(validateEnableForm({ ...base, mode: 'login', account: '' })).toBe('请填写服务器地址和账号');
    expect(validateEnableForm({ ...base, mode: 'login', server: 'sync.example.com' })).toBe('服务器地址需以 https:// 开头');
    expect(validateEnableForm({ ...base, mode: 'login', server: 'http://sync.example.com' })).toBe('服务器地址需以 https:// 开头');
    expect(validateEnableForm({ ...base, mode: 'login', server: 'http://127.0.0.1:8787' })).toBeNull();
    expect(validateEnableForm({ ...base, mode: 'login', server: 'http://localhost:8787/' })).toBeNull();
    expect(validateEnableForm({ ...base, mode: 'login', password: '' })).toBe('请输入同步密码');
    // 登录不查长度
    expect(validateEnableForm({ ...base, mode: 'login', password: 'short' })).toBeNull();
    expect(validateEnableForm({ ...base, mode: 'register', password: 'short', password2: 'short' })).toBe('同步密码至少需要 8 位');
    expect(validateEnableForm({ ...base, mode: 'register', password2: '87654321' })).toBe('两次输入的密码不一致');
    expect(validateEnableForm({ ...base, mode: 'register', password2: '12345678', inviteRequired: true })).toBe('请输入邀请码');
    expect(validateEnableForm({ ...base, mode: 'register', password2: '12345678', inviteRequired: true, invite: 'abc' })).toBeNull();
    expect(validateEnableForm({ ...base, mode: 'register', password2: '12345678' })).toBeNull();
  });
});

describe('完成框里的那句话', () => {
  const counts = (p: Partial<ReturnType<typeof emptyCounts>>) => ({ ...emptyCounts(), ...p });
  const result = (mode: EnableResult['mode'], uploaded = {}, downloaded = {}, merged = {}): EnableResult => ({
    mode,
    uploaded: counts(uploaded),
    downloaded: counts(downloaded),
    merged: counts(merged),
  });

  it('注册：列非零的服务器、快捷命令、私钥，其他项不列', () => {
    expect(describeEnableResult(result('register', { servers: 42, snippets: 58, keys: 3, history: 9 }))).toBe('已上传本机的 42 台服务器、58 条快捷命令、3 把私钥。');
    expect(describeEnableResult(result('register', { snippets: 2 }))).toBe('已上传本机的 2 条快捷命令。');
    expect(describeEnableResult(result('register', { history: 5, knownHosts: 2 }))).toBe('本机暂无需要上传的数据。');
  });

  it('登录：获取、上传、合并三段用「；」连起来', () => {
    expect(describeEnableResult(result('login', { servers: 2 }, { servers: 40, snippets: 58 }, { servers: 5 }))).toBe(
      '已从云端获取 40 台服务器、58 条快捷命令；本机的 2 台服务器已上传；5 台服务器与云端完全相同，已合并为一份。',
    );
    expect(describeEnableResult(result('login', {}, { keys: 1 }))).toBe('已从云端获取 1 把私钥。');
    expect(describeEnableResult(result('login', { servers: 1 }))).toBe('本机的 1 台服务器已上传。');
    expect(describeEnableResult(result('login'))).toBe('本机与云端的数据一致。');
  });
});

describe('预览用的假后端', () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
  });

  it('没有同步能力的平台（网页端）：不支持，调用抛给用户看的错误', async () => {
    const backend = createMockBackend();
    stop = startSync({ ...backend, sync: undefined });
    expect(syncSupported()).toBe(false);
    await expect(serverInfo('https://sync.example.com')).rejects.toMatchObject({ code: 'unsupported', message: '网页版暂不支持云同步。' });
    await expect(syncNow()).resolves.toBeUndefined();
  });

  it('平台给了不同步的原因（桌面端调试版）：不启动，原因原样给界面', async () => {
    const backend = createMockBackend();
    stop = startSync({ ...backend, sync: { ...backend.sync!, disabledReason: '调试版与正式版共用本机数据，暂不同步。' } });
    expect(syncSupported()).toBe(false);
    expect(syncUnavailableReason()).toBe('调试版与正式版共用本机数据，暂不同步。');
    await expect(serverInfo('https://sync.test')).rejects.toMatchObject({ code: 'unsupported', message: '调试版与正式版共用本机数据，暂不同步。' });
    stop();
    stop = startSync({ ...backend, sync: undefined });
    expect(syncUnavailableReason()).toBe('网页版暂不支持云同步。');
    stop();
    stop = startSync(backend);
    expect(syncUnavailableReason()).toBeNull();
  });

  it('地址里的关键字决定注册方式；连不上的写「无法连接同步服务器：原因」', async () => {
    stop = startSync(createMockBackend());
    expect(syncSupported()).toBe(true);
    expect(syncStatus.get().state).toBe('off');
    await expect(serverInfo('https://sync.invite.test')).resolves.toEqual({ registration: 'invite' });
    await expect(serverInfo('https://sync.test')).resolves.toEqual({ registration: 'open' });
    await expect(serverInfo('https://offline.test')).rejects.toMatchObject({ message: '无法连接同步服务器：网络错误或服务器无响应' });
    await expect(serverInfo('http://sync.test')).rejects.toMatchObject({ message: '服务器地址需以 https:// 开头' });
  });

  it('预置账号 demo 能登录，取回云端示例数据，退出后本机数据保留', async () => {
    stop = startSync(createMockBackend());
    const steps: number[] = [];
    const result = await login({ server: 'https://demo.test', account: 'Demo', password: 'demo1234' }, (s) => steps.push(s));
    expect(steps).toEqual([0, 1, 2]);
    expect(result.downloaded).toMatchObject({ servers: 3, folders: 1 });
    expect(syncStatus.get()).toMatchObject({ state: 'ok', account: 'demo', server: 'https://demo.test' });
    expect(hostsStore.get().servers.map((s) => s.name)).toContain('cloud-web-01');
    await logout();
    expect(syncStatus.get().state).toBe('off');
    expect(hostsStore.get().servers.map((s) => s.name)).toContain('cloud-web-01');
  }, 10_000);
});
