import type { PasswordResult, KeyResult } from '../components/common/Dialogs';
import type { AuthConfig, SecretStore } from '../types';
import type { ServerRecord } from './hosts-store';

// 连接一台服务器前先把认证信息凑齐：保存过就直接用，没有就弹窗问。

export const secretKeys = {
  password: (id: string) => `${id}.password`,
  privateKey: (id: string) => `${id}.privateKey`,
  passphrase: (id: string) => `${id}.passphrase`,
};

export interface AuthPrompts {
  askPassword(opts: { title: string; message: string; canRemember: boolean }): Promise<PasswordResult | null>;
  askPrivateKey(opts: { title: string; message: string; canRemember: boolean }): Promise<KeyResult | null>;
}

/** 返回 null 表示用户取消 */
export async function resolveAuth(server: ServerRecord, secrets: SecretStore, prompts: AuthPrompts): Promise<AuthConfig | null> {
  const where = `${server.user}@${server.host}${server.port === 22 ? '' : `:${server.port}`}`;

  if (server.auth === 'password') {
    if (secrets.available) {
      const saved = await secrets.get(secretKeys.password(server.id)).catch(() => null);
      if (saved !== null) return { type: 'password', password: saved };
    }
    const r = await prompts.askPassword({ title: `连接 ${server.name}`, message: `${where} 需要密码`, canRemember: secrets.available });
    if (!r) return null;
    if (r.remember && secrets.available) await secrets.set(secretKeys.password(server.id), r.password).catch(() => {});
    return { type: 'password', password: r.password };
  }

  // 公钥和密钥库现在走同一条路：有保存的私钥就用，没有就让用户选
  if (secrets.available) {
    const key = await secrets.get(secretKeys.privateKey(server.id)).catch(() => null);
    if (key) {
      const passphrase = await secrets.get(secretKeys.passphrase(server.id)).catch(() => null);
      return { type: 'key', privateKey: key, passphrase: passphrase || undefined };
    }
  }
  const r = await prompts.askPrivateKey({
    title: `连接 ${server.name}`,
    message: `${where} 使用公钥认证，请选择私钥文件`,
    canRemember: secrets.available,
  });
  if (!r) return null;
  if (r.remember && secrets.available) {
    await secrets.set(secretKeys.privateKey(server.id), r.privateKey).catch(() => {});
    if (r.passphrase) await secrets.set(secretKeys.passphrase(server.id), r.passphrase).catch(() => {});
  }
  return { type: 'key', privateKey: r.privateKey, passphrase: r.passphrase || undefined };
}
