import type { SyncCounts, SyncState, SyncStatus } from './sync';

// 同步状态给人看的文字：左上角状态、悬停提示、同步窗口的状态条和设备列表。文案见设计稿
// https://claude.ai/artifact/NDmqP3LDsJnQrT4uELxsbh

const WORDS: Record<SyncState, string> = {
  off: '未开启',
  syncing: '正在同步…',
  ok: '已同步',
  offline: '离线',
  error: '同步失败',
  relogin: '需重新登录',
};

export function statusWord(state: SyncState): string {
  return WORDS[state];
}

/** 同步窗口状态条第二行 */
export function statusDetail(status: SyncStatus, now: number): string {
  switch (status.state) {
    case 'off':
      return '';
    case 'syncing':
      return '正在上传本机修改并获取其他设备的修改';
    case 'ok':
      return status.lastSyncAt ? `上次同步 ${formatClock(status.lastSyncAt, now)}` : '';
    case 'offline':
      return '无法连接同步服务器，网络恢复后将自动同步';
    case 'error':
      return status.message || '同步服务器返回错误，稍后将自动重试';
    case 'relogin':
      return status.message || '登录已失效，请重新登录';
  }
}

/** 左上角状态的悬停提示 */
export function statusTip(status: SyncStatus, now: number): string {
  switch (status.state) {
    case 'off':
      return '单击开启云同步';
    case 'ok':
      return status.lastSyncAt ? `上次同步：${formatClock(status.lastSyncAt, now)}` : '已同步';
    case 'error':
      return '同步失败，单击查看原因';
    case 'relogin':
      return status.message || '登录已失效，单击重新登录';
    default:
      return statusDetail(status, now);
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 今天的只写时分秒，别的日子写月-日 时:分 */
export function formatClock(ms: number, now: number): string {
  const d = new Date(ms);
  const today = new Date(now);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === today.toDateString()) return `${time}:${pad(d.getSeconds())}`;
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

/** 设备列表的“最后在线” */
export function relativeTime(ms: number, now: number): string {
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** 同步窗口“同步内容”的七格，顺序即显示顺序 */
export const COUNT_LABELS: readonly (readonly [keyof SyncCounts, string])[] = [
  ['servers', '台服务器'],
  ['folders', '个文件夹'],
  ['keys', '把私钥'],
  ['snippets', '条快捷命令'],
  ['history', '条历史命令'],
  ['recents', '条最近连接'],
  ['knownHosts', '条服务器指纹'],
];

/** 改密码的检查，能用返回 null */
export function newPasswordError(password: string, again: string): string | null {
  if (password.length < 8) return '同步密码至少需要 8 位';
  if (password !== again) return '两次输入的密码不一致';
  return null;
}
