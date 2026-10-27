import type { SshBackend, SyncPlatform } from '../../types';
import { hostsStore } from '../hosts-store';
import { historyStore } from '../history-store';
import { keysStore } from '../key-library';
import { KnownHostsStore } from '../known-hosts';
import { recentsStore } from '../recents-store';
import { groupsStore, snippetsStore } from '../snippets-store';
import { PersistentStore, readText, writeText } from '../storage';
import { Store } from '../store';
import * as account from './account';
import { normalizeServer } from './client';
import { SyncEngine } from './engine';
import { SyncError, emptyCounts, type EnableResult, type SyncCounts, type SyncDevice, type SyncStatus } from './model';
import { STATE_KEY, normalizeState, type LoadedState, type StateHolder } from './state';

// 云同步给界面用的接口（docs/specs/sync.md「界面用的接口」）。界面只从这里拿东西，
// 引擎、账本、加密细节都在同目录的其他文件里。这里把 core/ 的单例组装成一个引擎，只在主窗口跑。

export type { SyncCounts, SyncDevice, SyncState, SyncStatus, EnableResult } from './model';
export { SyncError } from './model';

export const syncStatus = new Store<SyncStatus>({
  state: 'off',
  lastSyncAt: null,
  message: '',
  server: null,
  account: null,
  deviceName: null,
  counts: emptyCounts(),
});

let engine: SyncEngine | null = null;
let platform: SyncPlatform | null = null;
let stateStore: PersistentStore<LoadedState> | null = null;

/** 同步状态存在 evershell.sync.v1；只有主窗口建这个 store、写这个键 */
function stateHolder(): StateHolder {
  stateStore ??= new PersistentStore<LoadedState>(STATE_KEY, null, (raw) => normalizeState(raw));
  const store = stateStore;
  return {
    load: () => store.get(),
    save: (s) => store.set({ ...s }),
    clear: () => {
      store.set(null);
      // 没开同步时不留这个键
      writeText(STATE_KEY, null);
    },
  };
}

function requireEngine(): SyncEngine {
  if (!engine) throw new SyncError('unsupported', syncUnavailableReason() ?? '网页版暂不支持云同步。');
  return engine;
}

/** 开启表单的检查，能用返回 null；register 时多查确认密码和邀请码 */
export function validateEnableForm(form: {
  mode: 'register' | 'login';
  server: string;
  account: string;
  password: string;
  password2?: string;
  invite?: string;
  inviteRequired?: boolean;
}): string | null {
  if (!form.server.trim() || !form.account.trim()) return '请填写服务器地址和账号';
  const urlError = serverUrlError(form.server);
  if (urlError) return urlError;
  if (!form.password) return '请输入同步密码';
  if (form.mode === 'register') {
    if (form.password.length < 8) return '同步密码至少需要 8 位';
    if (form.password !== (form.password2 ?? '')) return '两次输入的密码不一致';
    if (form.inviteRequired && !form.invite?.trim()) return '请输入邀请码';
  }
  return null;
}

/** 服务器地址要 https；本机测试（127.0.0.1、localhost）可以用 http */
export function serverUrlError(server: string): string | null {
  const s = normalizeServer(server);
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return /^https?:\/\//i.test(s) ? '服务器地址格式不正确' : '服务器地址需以 https:// 开头';
  }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return '服务器地址需以 https:// 开头';
  if (url.search || url.hash || url.username || url.password) return '服务器地址格式不正确';
  return null;
}

/** 完成框里列的几项：服务器、快捷命令、私钥，非零的用「、」连起来 */
function listCounts(c: SyncCounts): string {
  const parts: string[] = [];
  if (c.servers) parts.push(`${c.servers} 台服务器`);
  if (c.snippets) parts.push(`${c.snippets} 条快捷命令`);
  if (c.keys) parts.push(`${c.keys} 把私钥`);
  return parts.join('、');
}

/** 拼完成框里的那句话，如“已上传本机的 42 台服务器、58 条快捷命令、3 把私钥。” */
export function describeEnableResult(result: EnableResult): string {
  const up = listCounts(result.uploaded);
  if (result.mode === 'register') return up ? `已上传本机的 ${up}。` : '本机暂无需要上传的数据。';
  const down = listCounts(result.downloaded);
  const merged = listCounts(result.merged);
  const parts: string[] = [];
  if (down) parts.push(`已从云端获取 ${down}`);
  if (up) parts.push(`本机的 ${up}已上传`);
  if (merged) parts.push(`${merged}与云端完全相同，已合并为一份`);
  return parts.length ? `${parts.join('；')}。` : '本机与云端的数据一致。';
}

/** 当前平台能不能同步（网页端不能） */
export function syncSupported(): boolean {
  return syncUnavailableReason() === null;
}

/** 不能同步的原因（给用户看），能同步返回 null：网页端没有同步能力；平台也可以给出原因（桌面端调试版和正式版共用本机数据） */
export function syncUnavailableReason(): string | null {
  if (!platform) return '网页版暂不支持云同步。';
  return platform.disabledReason || null;
}

/** 主窗口启动时调一次：记下平台、开着同步就开始定时同步。返回停止函数 */
export function startSync(backend: SshBackend): () => void {
  engine?.stop();
  engine = null;
  platform = backend.sync ?? null;
  if (!platform || syncUnavailableReason() !== null) return () => {};
  const current = new SyncEngine({
    platform,
    secrets: backend.secrets,
    stores: {
      hosts: hostsStore,
      keys: keysStore,
      snippets: snippetsStore,
      groups: groupsStore,
      history: historyStore,
      recents: recentsStore,
    },
    knownHosts: new KnownHostsStore(backend.secrets),
    state: stateHolder(),
    status: syncStatus,
    materialize: () => {
      // 默认的几条快捷命令没落盘时每次启动 id 都不一样，会被当成删了又新建
      if (readText('evershell.snippets.v1') == null) snippetsStore.set((list) => [...list]);
    },
  });
  engine = current;
  void current.start();

  const onFocus = () => current.wake('focus');
  const onOnline = () => current.wake('online');
  const onVisible = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') current.wake('focus');
  };
  if (typeof window !== 'undefined') {
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
  }
  return () => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
    }
    current.stop();
    if (engine === current) engine = null;
  };
}

/** 同步服务器要不要邀请码（GET /v1/info） */
export async function serverInfo(server: string): Promise<{ registration: 'invite' | 'open' | 'closed' }> {
  const e = requireEngine();
  const urlError = serverUrlError(server);
  if (urlError) throw new SyncError('invalid', urlError);
  return account.serverInfo(e.fetchFn, server);
}

/** onStep 报告进度条走到第几步（0、1、2），见设计稿的步骤列表 */
export async function register(
  opts: { server: string; account: string; password: string; invite?: string },
  onStep: (step: number) => void,
): Promise<EnableResult> {
  const e = requireEngine();
  const error = validateEnableForm({ mode: 'register', ...opts, password2: opts.password, inviteRequired: false });
  if (error) throw new SyncError('invalid', error);
  return account.register(e, opts, onStep);
}

export async function login(opts: { server: string; account: string; password: string }, onStep: (step: number) => void): Promise<EnableResult> {
  const e = requireEngine();
  const error = validateEnableForm({ mode: 'login', ...opts });
  if (error) throw new SyncError('invalid', error);
  return account.login(e, opts, onStep);
}

/** 「需重新登录」时用新密码登录，账号和服务器沿用 */
export async function relogin(password: string): Promise<void> {
  if (!password) throw new SyncError('invalid', '请输入同步密码');
  return account.relogin(requireEngine(), password);
}

/** 退出登录：吊销令牌（连不上也照样退出），清掉本机的同步状态和令牌，本机数据保留 */
export async function logout(): Promise<void> {
  return account.logout(requireEngine());
}

export async function changePassword(password: string): Promise<void> {
  return account.changePassword(requireEngine(), password);
}

/** 立即同步一轮；正在同步时等这一轮结束 */
export async function syncNow(): Promise<void> {
  return engine?.syncNow();
}

export async function listDevices(): Promise<SyncDevice[]> {
  return account.listDevices(requireEngine());
}

export async function removeDevice(id: string): Promise<void> {
  return account.removeDevice(requireEngine(), id);
}

/** 改本机名称：本机存储和服务器都改 */
export async function renameDevice(name: string): Promise<void> {
  return account.renameDevice(requireEngine(), name);
}
