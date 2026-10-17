import type { FolderRecord, HostsData, ServerRecord } from '../hosts-store';

// EverShell 自己的导出格式：JSON，带格式名和版本号，保留文件夹层级和所有非机密字段。
// 不含密码、私钥、口令；id 原样写出，导入时会重新分配。

export const EXPORT_FORMAT = 'evershell-connections';
export const EXPORT_VERSION = 1;

export interface ExportedFolder {
  id: string;
  parentId: string | null;
  name: string;
}

export type ExportedServer = Pick<ServerRecord, 'id' | 'parentId' | 'name' | 'host' | 'port' | 'user' | 'note' | 'proto' | 'auth' | 'keyLabel' | 'advanced' | 'forwards'>;

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  folders: ExportedFolder[];
  servers: ExportedServer[];
}

function pickServer(s: ServerRecord, parentId: string | null): ExportedServer {
  return {
    id: s.id,
    parentId,
    name: s.name,
    host: s.host,
    port: s.port,
    user: s.user,
    note: s.note,
    proto: s.proto,
    auth: s.auth,
    keyLabel: s.keyLabel,
    advanced: s.advanced,
    forwards: s.forwards,
  };
}

/**
 * selection 为 null 导出全部（不含已删除）；否则导出选中的文件夹（连同子树）和连接，
 * 选中项本身放在导出文件的根目录。
 */
export function buildExport(data: HostsData, selection: Iterable<string> | null, now: Date = new Date()): ExportFile {
  const liveFolders = data.folders.filter((f) => !f.deletedAt);
  const liveServers = data.servers.filter((s) => !s.deletedAt);
  const folders: ExportedFolder[] = [];
  const servers: ExportedServer[] = [];

  if (selection === null) {
    for (const f of liveFolders) folders.push({ id: f.id, parentId: f.parentId, name: f.name });
    for (const s of liveServers) servers.push(pickServer(s, s.parentId));
  } else {
    const picked = new Set(selection);
    const included = new Set<string>();
    const addFolder = (f: FolderRecord, parentId: string | null) => {
      if (included.has(f.id)) return;
      included.add(f.id);
      folders.push({ id: f.id, parentId, name: f.name });
      for (const child of liveFolders) if (child.parentId === f.id) addFolder(child, f.id);
      for (const s of liveServers) if (s.parentId === f.id) servers.push(pickServer(s, f.id));
    };
    for (const f of liveFolders) if (picked.has(f.id)) addFolder(f, null);
    for (const s of liveServers) {
      if (!picked.has(s.id)) continue;
      if (s.parentId && included.has(s.parentId)) continue;
      servers.push(pickServer(s, null));
    }
  }

  return { format: EXPORT_FORMAT, version: EXPORT_VERSION, exportedAt: now.toISOString(), folders, servers };
}

export function exportFileName(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `evershell-connections-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}.json`;
}

/**
 * 导出并交给 save 保存（桌面端存进“下载”目录，网页端由浏览器下载）。
 * 返回保存位置；没有可导出的内容时返回 null，由调用方提示。
 */
export async function exportConnections(
  data: HostsData,
  selection: Iterable<string> | null,
  save: (name: string, data: Uint8Array) => Promise<string>,
): Promise<string | null> {
  const file = buildExport(data, selection);
  if (file.servers.length === 0 && file.folders.length === 0) return null;
  return save(exportFileName(), new TextEncoder().encode(JSON.stringify(file, null, 2)));
}
