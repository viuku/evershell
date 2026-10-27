import { describe, expect, it } from 'vitest';
import type { SyncStatus } from '../sync';
import { formatClock, newPasswordError, relativeTime, statusDetail, statusTip, statusWord } from '../sync-text';

const base: SyncStatus = {
  state: 'ok',
  lastSyncAt: null,
  message: '',
  server: 'https://sync.example.com',
  account: 'ops',
  deviceName: 'MacBook Pro',
  counts: { servers: 0, folders: 0, keys: 0, snippets: 0, history: 0, recents: 0, knownHosts: 0 },
};

const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

describe('同步状态的文字', () => {
  it('六种状态各有一个词', () => {
    expect(['off', 'syncing', 'ok', 'offline', 'error', 'relogin'].map((s) => statusWord(s as SyncStatus['state']))).toEqual([
      '未开启',
      '正在同步…',
      '已同步',
      '离线',
      '同步失败',
      '需重新登录',
    ]);
  });

  it('今天的同步时间只写时分秒，别的日子带月日', () => {
    const now = at(2026, 10, 28, 15, 0);
    expect(formatClock(at(2026, 10, 28, 14, 32, 5), now)).toBe('14:32:05');
    expect(formatClock(at(2026, 10, 27, 9, 3), now)).toBe('10-27 09:03');
  });

  it('悬停提示和状态条', () => {
    const now = at(2026, 10, 28, 15, 0);
    const ok = { ...base, lastSyncAt: at(2026, 10, 28, 14, 32, 5) };
    expect(statusTip(ok, now)).toBe('上次同步：14:32:05');
    expect(statusDetail(ok, now)).toBe('上次同步 14:32:05');
    expect(statusTip({ ...base, state: 'off' }, now)).toBe('单击开启云同步');
    expect(statusTip({ ...base, state: 'offline' }, now)).toBe('无法连接同步服务器，网络恢复后将自动同步');
    expect(statusDetail({ ...base, state: 'error', message: '部分数据无法解密' }, now)).toBe('部分数据无法解密');
  });

  it('设备最后在线', () => {
    const now = at(2026, 10, 28, 15, 0);
    expect(relativeTime(now - 20_000, now)).toBe('刚刚');
    expect(relativeTime(now - 3 * 60_000, now)).toBe('3 分钟前');
    expect(relativeTime(now - 5 * 3600_000, now)).toBe('5 小时前');
    expect(relativeTime(now - 2 * 86400_000, now)).toBe('2 天前');
  });

  it('新密码的检查', () => {
    expect(newPasswordError('short', 'short')).toBe('同步密码至少需要 8 位');
    expect(newPasswordError('long enough', 'long enougH')).toBe('两次输入的密码不一致');
    expect(newPasswordError('long enough', 'long enough')).toBeNull();
  });
});
