import type { PrivateKeyInfo, SecretStore, SshBackend } from '../types';
import { hostsStore, type HostsData, type ServerRecord } from './hosts-store';
import { PersistentStore, newId, readText, writeText } from './storage';

// 私钥库：私钥导入一次，多台服务器共用（照 FinalShell，docs/specs/key-library.md）。
// 清单（名称、类型、长度、指纹）在这里存，各窗口同步；私钥原文和口令只进保险箱。

export interface KeyRecord {
  id: string;
  name: string;
  /** RSA、ED25519…；搬家时认不出来的为空字符串 */
  algorithm: string;
  /** 认不出来的为 0 */
  bits: number;
  /** 公钥指纹，用来认“同一把私钥”；认不出来的为 null */
  fingerprint: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface KeysData {
  version: 1;
  keys: KeyRecord[];
  /** 以前跟着服务器存的私钥已经搬进来了，启动时不用再查 */
  migratedServerKeys: boolean;
}

const EMPTY: KeysData = { version: 1, keys: [], migratedServerKeys: false };

function normalize(raw: unknown, fallback: KeysData): KeysData {
  if (!raw || typeof raw !== 'object') return fallback;
  const r = raw as Partial<KeysData>;
  if (!Array.isArray(r.keys)) return fallback;
  return {
    version: 1,
    keys: r.keys
      .filter((k) => k && typeof k.id === 'string' && typeof k.name === 'string')
      .map((k) => ({
        ...k,
        algorithm: typeof k.algorithm === 'string' ? k.algorithm : '',
        bits: Number(k.bits) || 0,
        fingerprint: typeof k.fingerprint === 'string' ? k.fingerprint : null,
        deletedAt: k.deletedAt ?? null,
      })),
    migratedServerKeys: r.migratedServerKeys === true,
  };
}

export const keysStore = new PersistentStore<KeysData>('evershell.keys.v1', EMPTY, normalize);

/**
 * 保险箱里的条目编号：`<id>.privateKey`、`<id>.passphrase`。
 * 私钥库用私钥 id（key_ 开头）；以前每台服务器各存一份，用的是服务器 id（srv_ 开头），搬家时读的就是那两条
 */
export const keySecrets = {
  text: (id: string) => `${id}.privateKey`,
  passphrase: (id: string) => `${id}.passphrase`,
};

/** 没删除的，按导入的先后 */
export function liveKeys(data: KeysData): KeyRecord[] {
  return data.keys.filter((k) => !k.deletedAt);
}

export function findKey(data: KeysData, id: string | null | undefined): KeyRecord | null {
  if (!id) return null;
  return data.keys.find((k) => k.id === id && !k.deletedAt) ?? null;
}

/** 类型一栏：认不出来写「未知」 */
export function keyType(k: KeyRecord): string {
  return k.algorithm || '未知';
}

/** 长度一栏 */
export function keyBits(k: KeyRecord): string {
  return k.bits ? String(k.bits) : '—';
}

/** 编辑连接里显示的一行，如「dmit · RSA 2048」 */
export function describeKey(k: KeyRecord): string {
  return k.algorithm ? `${k.name} · ${k.algorithm}${k.bits ? ` ${k.bits}` : ''}` : k.name;
}

/** 有几台（没删除的）服务器选了这把私钥 */
export function keyUsers(hosts: HostsData, keyId: string): number {
  return hosts.servers.filter((s) => !s.deletedAt && s.auth === 'key' && s.keyId === keyId).length;
}

/** 重名时后面加「 (2)」「 (3)」 */
export function uniqueKeyName(data: KeysData, name: string): string {
  const taken = new Set(liveKeys(data).map((k) => k.name));
  const base = name.trim() || '私钥';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface KeyInput {
  privateKey: string;
  passphrase: string;
  name: string;
}

export class KeyLibrary {
  constructor(
    private readonly secrets: SecretStore,
    private readonly inspectKey?: SshBackend['inspectPrivateKey'],
  ) {}

  static of(backend: Pick<SshBackend, 'secrets' | 'inspectPrivateKey'>): KeyLibrary {
    return new KeyLibrary(backend.secrets, backend.inspectPrivateKey);
  }

  /** 能存私钥（保险箱可用）、能认私钥时才有私钥库；网页端没有 */
  get available(): boolean {
    return this.secrets.available && !!this.inspectKey;
  }

  /** 认出类型、长度和指纹；认不出来抛错，文案直接给用户看 */
  inspect(privateKey: string, passphrase?: string): Promise<PrivateKeyInfo> {
    if (!this.inspectKey) return Promise.reject(new Error('当前环境不支持保存私钥'));
    return this.inspectKey(privateKey, passphrase || undefined);
  }

  /**
   * 放进私钥库。同一把（指纹一样）已经在库里时不新建，返回那条、duplicate 为 true。
   * 私钥认不出来、口令不对时抛错，什么都不写
   */
  async add(input: KeyInput): Promise<{ key: KeyRecord; duplicate: boolean }> {
    const info = await this.inspect(input.privateKey, input.passphrase);
    const existing = liveKeys(keysStore.get()).find((k) => k.fingerprint === info.fingerprint);
    if (existing) return { key: existing, duplicate: true };
    const id = newId('key');
    await this.secrets.set(keySecrets.text(id), input.privateKey);
    if (info.encrypted && input.passphrase) await this.secrets.set(keySecrets.passphrase(id), input.passphrase);
    const now = Date.now();
    const key: KeyRecord = {
      id,
      name: uniqueKeyName(keysStore.get(), input.name),
      algorithm: info.algorithm,
      bits: info.bits,
      fingerprint: info.fingerprint,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    keysStore.set((d) => ({ ...d, keys: [...d.keys, key] }));
    return { key, duplicate: false };
  }

  /** 连接用：私钥原文和口令；这把已经删了、或者保险箱里没有时返回 null */
  async load(id: string): Promise<{ privateKey: string; passphrase?: string } | null> {
    if (!findKey(keysStore.get(), id)) return null;
    const privateKey = await this.secrets.get(keySecrets.text(id));
    if (!privateKey) return null;
    const passphrase = await this.secrets.get(keySecrets.passphrase(id));
    return { privateKey, passphrase: passphrase || undefined };
  }

  rename(id: string, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    keysStore.set((d) => ({
      ...d,
      keys: d.keys.map((k) => (k.id === id ? { ...k, name: trimmed, updatedAt: Date.now() } : k)),
    }));
  }

  /** 删除：清单里留墓碑，保险箱里的原文和口令立刻删掉；选了它的服务器变回“未选择” */
  async remove(id: string): Promise<void> {
    const now = Date.now();
    keysStore.set((d) => ({ ...d, keys: d.keys.map((k) => (k.id === id ? { ...k, deletedAt: now, updatedAt: now } : k)) }));
    hostsStore.set((d) => ({
      ...d,
      servers: d.servers.map((s) => (s.keyId === id ? { ...s, keyId: null, updatedAt: now } : s)),
    }));
    await this.secrets.remove(keySecrets.text(id));
    await this.secrets.remove(keySecrets.passphrase(id));
  }
}

/** 搬家前把连接清单原样备份在这里，只备份一次 */
export const HOSTS_BACKUP_KEY = 'evershell.hosts.v1.before-key-library';

/** 搬家时给私钥起的名字：原来的私钥文件名，没有就用服务器名 */
function nameFor(server: ServerRecord): string {
  const label = server.keyLabel?.trim();
  return label && label !== '已粘贴私钥' ? label : server.name;
}

let migrating: Promise<boolean> | null = null;

/**
 * 把以前跟着服务器存的私钥搬进私钥库（docs/specs/key-library.md 的“旧数据搬家”）。
 * 主窗口启动时调；全部搬完返回 true，以后不再跑。中途出错就停下，旧条目不动，下次启动再试
 */
export function migrateServerKeys(library: KeyLibrary, secrets: SecretStore): Promise<boolean> {
  if (!library.available || keysStore.get().migratedServerKeys) return Promise.resolve(true);
  migrating ??= runMigration(library, secrets).finally(() => {
    migrating = null;
  });
  return migrating;
}

async function runMigration(library: KeyLibrary, secrets: SecretStore): Promise<boolean> {
  const candidates = hostsStore.get().servers.filter((s) => s.auth === 'key' && !s.keyId);
  /** 认不出指纹的私钥按原文认同一把：原文 → 私钥 id */
  const byText = new Map<string, string>();
  try {
    for (const server of candidates) {
      const text = await secrets.get(keySecrets.text(server.id));
      if (!text) continue;
      if (readText(HOSTS_BACKUP_KEY) == null) writeText(HOSTS_BACKUP_KEY, readText('evershell.hosts.v1') ?? '');
      const passphrase = (await secrets.get(keySecrets.passphrase(server.id))) ?? '';
      const info = await library.inspect(text, passphrase).catch(() => null);
      const same = info
        ? liveKeys(keysStore.get()).find((k) => k.fingerprint === info.fingerprint)
        : findKey(keysStore.get(), byText.get(text));
      let keyId = same?.id;
      if (!keyId) {
        keyId = newId('key');
        await secrets.set(keySecrets.text(keyId), text);
        if (passphrase) await secrets.set(keySecrets.passphrase(keyId), passphrase);
        // 读回来核对过才动旧条目
        const back = await secrets.get(keySecrets.text(keyId));
        const backPass = passphrase ? await secrets.get(keySecrets.passphrase(keyId)) : '';
        if (back !== text || backPass !== passphrase) throw new Error('保险箱写入后校验失败');
        const now = Date.now();
        const record: KeyRecord = {
          id: keyId,
          name: uniqueKeyName(keysStore.get(), nameFor(server)),
          algorithm: info?.algorithm ?? '',
          bits: info?.bits ?? 0,
          fingerprint: info?.fingerprint ?? null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
        keysStore.set((d) => ({ ...d, keys: [...d.keys, record] }));
      }
      if (!info) byText.set(text, keyId);
      const linked = keyId;
      hostsStore.set((d) => ({
        ...d,
        servers: d.servers.map((s) => (s.id === server.id ? { ...s, keyId: linked, updatedAt: Date.now() } : s)),
      }));
      await secrets.remove(keySecrets.text(server.id));
      await secrets.remove(keySecrets.passphrase(server.id));
    }
  } catch (e) {
    console.error('[私钥库] 搬家没完成，下次启动再试', e);
    return false;
  }
  keysStore.set((d) => ({ ...d, migratedServerKeys: true }));
  return true;
}
