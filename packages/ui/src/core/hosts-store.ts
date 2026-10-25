import { PersistentStore, newId } from './storage';

// 连接管理器的数据：文件夹 + 服务器，存在 localStorage。
// 每条记录带 id / updatedAt / deletedAt（软删除墓碑），方便以后按记录做云同步。

export type AuthMethod = 'password' | 'key';
export type Protocol = 'ssh' | 'rdp';

export interface FolderRecord {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
}

export interface ForwardRule {
  id: string;
  type: 'local' | 'remote' | 'dynamic';
  bindHost: string;
  bindPort: number;
  targetHost: string;
  targetPort: number;
}

/** “高级”页的字段，现在只存不生效 */
export interface AdvancedOptions {
  jumpServerId: string | null;
  proxy: 'none' | 'http' | 'socks5';
  proxyHost: string;
  proxyPort: number;
  keepAliveSecs: number;
  encoding: string;
  termType: string;
}

export interface ServerRecord {
  id: string;
  parentId: string | null;
  name: string;
  host: string;
  port: number;
  user: string;
  note: string;
  proto: Protocol;
  auth: AuthMethod;
  /** 认证方式是公钥时，用私钥库里的哪把（core/key-library.ts）；还没选为 null，连接时再问 */
  keyId: string | null;
  /** 原来用的私钥文件名，只用于提示（从别的软件导入、还没选私钥时）；搬进私钥库时用来起名 */
  keyLabel: string | null;
  advanced: AdvancedOptions;
  forwards: ForwardRule[];
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  lastConnectedAt: number | null;
}

export interface HostsData {
  version: 1;
  folders: FolderRecord[];
  servers: ServerRecord[];
}

export const DEFAULT_ADVANCED: AdvancedOptions = {
  jumpServerId: null,
  proxy: 'none',
  proxyHost: '',
  proxyPort: 1080,
  keepAliveSecs: 30,
  encoding: 'UTF-8',
  termType: 'xterm-256color',
};

const EMPTY: HostsData = { version: 1, folders: [], servers: [] };

function normalize(raw: unknown, fallback: HostsData): HostsData {
  if (!raw || typeof raw !== 'object') return fallback;
  const r = raw as Partial<HostsData>;
  if (!Array.isArray(r.folders) || !Array.isArray(r.servers)) return fallback;
  return {
    version: 1,
    folders: r.folders.filter((f) => f && typeof f.id === 'string' && typeof f.name === 'string'),
    servers: r.servers
      .filter((s) => s && typeof s.id === 'string' && typeof s.host === 'string')
      .map((s) => ({
        ...s,
        port: Number(s.port) || 22,
        note: s.note ?? '',
        proto: s.proto === 'rdp' ? 'rdp' : 'ssh',
        // 以前有个没做完的「密钥库」(keychain)，现在公钥都从私钥库选，当成 key
        auth: (s.auth as string) === 'key' || (s.auth as string) === 'keychain' ? 'key' : 'password',
        keyId: typeof s.keyId === 'string' ? s.keyId : null,
        keyLabel: s.keyLabel ?? null,
        advanced: { ...DEFAULT_ADVANCED, ...(s.advanced ?? {}) },
        forwards: Array.isArray(s.forwards) ? s.forwards : [],
        deletedAt: s.deletedAt ?? null,
        lastConnectedAt: s.lastConnectedAt ?? null,
      })),
  };
}

export const hostsStore = new PersistentStore<HostsData>('evershell.hosts.v1', EMPTY, normalize);

/** 新建 / 编辑弹窗提交的字段 */
export type ServerInput = Pick<
  ServerRecord,
  'name' | 'parentId' | 'host' | 'port' | 'user' | 'note' | 'proto' | 'auth' | 'keyId' | 'keyLabel' | 'advanced' | 'forwards'
>;

export function addServer(input: ServerInput): ServerRecord {
  const now = Date.now();
  const record: ServerRecord = {
    id: newId('srv'),
    ...input,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    lastConnectedAt: null,
  };
  hostsStore.set((d) => ({ ...d, servers: [...d.servers, record] }));
  return record;
}

export function updateServer(id: string, patch: Partial<ServerInput>): void {
  hostsStore.set((d) => ({
    ...d,
    servers: d.servers.map((s) => (s.id === id ? { ...s, ...patch, updatedAt: Date.now() } : s)),
  }));
}

export function setServerDeleted(id: string, deleted: boolean): void {
  hostsStore.set((d) => ({
    ...d,
    servers: d.servers.map((s) =>
      s.id === id ? { ...s, deletedAt: deleted ? Date.now() : null, updatedAt: Date.now() } : s,
    ),
  }));
}

export function touchServerConnected(id: string): void {
  hostsStore.set((d) => ({
    ...d,
    servers: d.servers.map((s) => (s.id === id ? { ...s, lastConnectedAt: Date.now() } : s)),
  }));
}

export function addFolder(name: string, parentId: string | null): FolderRecord {
  const now = Date.now();
  const record: FolderRecord = { id: newId('dir'), name, parentId, createdAt: now, updatedAt: now, deletedAt: null };
  hostsStore.set((d) => ({ ...d, folders: [...d.folders, record] }));
  return record;
}

export function renameFolder(id: string, name: string): void {
  hostsStore.set((d) => ({
    ...d,
    folders: d.folders.map((f) => (f.id === id ? { ...f, name, updatedAt: Date.now() } : f)),
  }));
}

/** 删除文件夹时连同里面的子文件夹和服务器一起打墓碑；恢复则一起恢复 */
export function setFolderDeleted(id: string, deleted: boolean): void {
  hostsStore.set((d) => {
    const ids = new Set<string>([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const f of d.folders) {
        if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
          ids.add(f.id);
          grew = true;
        }
      }
    }
    const now = Date.now();
    const deletedAt = deleted ? now : null;
    return {
      ...d,
      folders: d.folders.map((f) => (ids.has(f.id) ? { ...f, deletedAt, updatedAt: now } : f)),
      servers: d.servers.map((s) => (s.parentId && ids.has(s.parentId) ? { ...s, deletedAt, updatedAt: now } : s)),
    };
  });
}

export function getServer(data: HostsData, id: string | null | undefined): ServerRecord | null {
  if (!id) return null;
  return data.servers.find((s) => s.id === id) ?? null;
}

export function getFolder(data: HostsData, id: string | null | undefined): FolderRecord | null {
  if (!id) return null;
  return data.folders.find((f) => f.id === id) ?? null;
}

/** 文件夹的完整路径，形如 /家里/网络设备；根目录是 / */
export function folderPath(data: HostsData, folderId: string | null): string {
  const parts: string[] = [];
  let cur = getFolder(data, folderId);
  let guard = 0;
  while (cur && guard++ < 50) {
    parts.unshift(cur.name);
    cur = getFolder(data, cur.parentId);
  }
  return `/${parts.join('/')}`;
}

/** 位置下拉框的选项：按树的顺序列出所有未删除文件夹 */
export function folderOptions(data: HostsData): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  const walk = (parentId: string | null, prefix: string) => {
    for (const f of data.folders) {
      if (f.parentId !== parentId || f.deletedAt) continue;
      const label = prefix ? `${prefix} / ${f.name}` : f.name;
      out.push({ id: f.id, label });
      walk(f.id, label);
    }
  };
  walk(null, '');
  return out;
}
