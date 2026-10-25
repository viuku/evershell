import type { PasswordResult, KeyResult } from '../components/common/Dialogs';
import type { AuthConfig, SecretStore } from '../types';
import { updateServer, type ServerRecord } from './hosts-store';
import { KeyLibrary } from './key-library';

// 连接一台服务器前先把认证信息凑齐：保存过就直接用。没存密码就先不带密码连，
// 服务器要密码时再用 askServerPassword 弹框问（和 FinalShell 一样）；
// 公钥认证用私钥库里选的那把（core/key-library.ts），没选就弹窗让用户选，勾“记住”放进私钥库。

export const secretKeys = {
  password: (id: string) => `${id}.password`,
  privateKey: (id: string) => `${id}.privateKey`,
  passphrase: (id: string) => `${id}.passphrase`,
};

export interface AuthPrompts {
  askPassword(opts: { title: string; message: string; canRemember: boolean }): Promise<PasswordResult | null>;
  askPrivateKey(opts: { title: string; message: string; canRemember: boolean }): Promise<KeyResult | null>;
}

/** 要连的是哪台服务器；serverId 为 null 表示临时连接，没处保存密码 */
export interface ConnectTarget {
  serverId: string | null;
  name: string;
  host: string;
  port: number;
  user: string;
}

function describe(t: { user: string; host: string; port: number }): string {
  return `${t.user}@${t.host}${t.port === 22 ? '' : `:${t.port}`}`;
}

/** 返回 null 表示用户取消。library 不给时当作没有私钥库（网页端） */
export async function resolveAuth(
  server: ServerRecord,
  secrets: SecretStore,
  prompts: AuthPrompts,
  library: KeyLibrary = new KeyLibrary(secrets),
): Promise<AuthConfig | null> {
  if (server.auth === 'password') {
    if (secrets.available) {
      const saved = await secrets.get(secretKeys.password(server.id)).catch(() => null);
      if (saved !== null) return { type: 'password', password: saved };
    }
    // 空密码就是“不带密码”：服务器不要密码直接进去，要的话 SessionManager 会再弹框问
    return { type: 'password', password: '' };
  }

  if (library.available && server.keyId) {
    const saved = await library.load(server.keyId).catch(() => null);
    if (saved) return { type: 'key', ...saved };
  }
  // 还没搬进私钥库的旧数据（搬家没成功时），照旧按服务器取
  if (secrets.available) {
    const key = await secrets.get(secretKeys.privateKey(server.id)).catch(() => null);
    if (key) {
      const passphrase = await secrets.get(secretKeys.passphrase(server.id)).catch(() => null);
      return { type: 'key', privateKey: key, passphrase: passphrase || undefined };
    }
  }
  const hint = server.keyLabel ? `（原来用的是 ${server.keyLabel}）` : '';
  const r = await prompts.askPrivateKey({
    title: `连接 ${server.name}`,
    message: `${describe(server)} 使用公钥认证，请选择私钥文件${hint}`,
    canRemember: library.available,
  });
  if (!r) return null;
  if (r.remember && library.available) {
    // 放进私钥库，库里已经有同一把就用那条；认不出来也不耽误这次连接
    try {
      const { key } = await library.add({ privateKey: r.privateKey, passphrase: r.passphrase, name: r.fileName ?? server.keyLabel ?? server.name });
      updateServer(server.id, { keyId: key.id });
    } catch {}
  }
  return { type: 'key', privateKey: r.privateKey, passphrase: r.passphrase || undefined };
}

/** 服务器要密码时弹框问，勾了“记住密码”就存起来。返回 null 表示用户取消 */
export async function askServerPassword(target: ConnectTarget, secrets: SecretStore, prompts: AuthPrompts): Promise<string | null> {
  const r = await prompts.askPassword({ title: `连接 ${target.name}`, message: `${describe(target)} 需要密码`, canRemember: secrets.available });
  if (!r) return null;
  if (r.remember && secrets.available && target.serverId) {
    await secrets.set(secretKeys.password(target.serverId), r.password).catch(() => {});
  }
  return r.password;
}

/** 不带密码（空密码） */
export function isBlankPassword(auth: AuthConfig): boolean {
  return auth.type === 'password' && auth.password === '';
}

interface AuthTarget {
  host: string;
  port: number;
  user: string;
  auth: AuthConfig;
}

/**
 * 重连用哪份认证。按连接管理器里的最新设置；那边没存密码、连的还是同一台同一个用户时，
 * 沿用这次会话里输过的密码，免得每次重连都再问一遍
 */
export function authForReconnect(fresh: AuthTarget, previous: AuthTarget): AuthConfig {
  const sameTarget = fresh.host === previous.host && fresh.port === previous.port && fresh.user === previous.user;
  if (isBlankPassword(fresh.auth) && sameTarget && previous.auth.type === 'password') return previous.auth;
  return fresh.auth;
}

/**
 * 是不是认证没通过。内核的报错以「认证失败」开头（crates/ssh-core 的 Error::AuthFailed），
 * 桌面端经 Tauri 只传得过来字符串，所以按文字认；内核改文案时这里要一起改
 */
export function isAuthFailure(message: string): boolean {
  return message.startsWith('认证失败');
}
