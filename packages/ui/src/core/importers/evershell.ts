import { DEFAULT_ADVANCED, type AdvancedOptions, type ForwardRule } from '../hosts-store';
import { EXPORT_FORMAT, EXPORT_VERSION, type ExportFile } from './export';
import { decodeText, extOf, fileName, parsePort } from './text';
import { linkFolders, ResultBuilder, type ImportFile, type ImportResult } from './types';

// 导回 EverShell 自己导出的 JSON。格式见 export.ts。

type Rec = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function pickAdvanced(raw: unknown): Partial<AdvancedOptions> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Rec;
  const out: Partial<AdvancedOptions> = {};
  if (r.proxy === 'none' || r.proxy === 'http' || r.proxy === 'socks5') out.proxy = r.proxy;
  if (typeof r.proxyHost === 'string') out.proxyHost = r.proxyHost;
  if (typeof r.proxyPort === 'number') out.proxyPort = r.proxyPort;
  if (typeof r.keepAliveSecs === 'number') out.keepAliveSecs = r.keepAliveSecs;
  if (typeof r.encoding === 'string') out.encoding = r.encoding;
  if (typeof r.termType === 'string') out.termType = r.termType;
  return out;
}

function pickForwards(raw: unknown): ForwardRule[] {
  if (!Array.isArray(raw)) return [];
  const out: ForwardRule[] = [];
  for (const r of raw as Rec[]) {
    if (!r || typeof r !== 'object') continue;
    if (r.type !== 'local' && r.type !== 'remote' && r.type !== 'dynamic') continue;
    out.push({
      id: str(r.id) ?? `fwd_${out.length}`,
      type: r.type,
      bindHost: str(r.bindHost) ?? '127.0.0.1',
      bindPort: parsePort(str(r.bindPort) ?? (typeof r.bindPort === 'number' ? r.bindPort : undefined)) ?? 0,
      targetHost: str(r.targetHost) ?? '',
      targetPort: parsePort(typeof r.targetPort === 'number' ? r.targetPort : str(r.targetPort)) ?? 0,
    });
  }
  return out;
}

export function parseEverShell(files: ImportFile[]): ImportResult {
  const b = new ResultBuilder('evershell');
  const jsons = files.filter((f) => extOf(f.path) === 'json');
  if (jsons.length === 0) {
    b.issue('', '没有找到 .json 文件');
    return b.result;
  }

  for (const f of jsons) {
    const name = fileName(f.path);
    let doc: Partial<ExportFile>;
    try {
      doc = JSON.parse(decodeText(f.bytes)) as Partial<ExportFile>;
    } catch {
      b.issue(name, 'JSON 解析失败');
      continue;
    }
    if (!doc || doc.format !== EXPORT_FORMAT) {
      b.issue(name, '不是 EverShell 导出文件（缺少 format 标记）');
      continue;
    }
    if (typeof doc.version === 'number' && doc.version > EXPORT_VERSION) b.warn(`${name} 来自更新版本的 EverShell（格式 v${doc.version}），不认识的字段会被忽略`);

    const folderRecs: { id: string; name: string; parentId: string | null }[] = [];
    for (const raw of Array.isArray(doc.folders) ? (doc.folders as unknown[]) : []) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Rec;
      if (typeof r.id === 'string' && typeof r.name === 'string') folderRecs.push({ id: r.id, name: r.name, parentId: str(r.parentId) ?? null });
    }
    const folderIds = linkFolders(b, folderRecs);

    // 跳板机引用的是导出文件里的服务器 id，导入后要换成新 id；先记下来源 id → 本地 id
    const serverIds = new Map<string, string>();
    const jumpRefs: { localId: string; sourceId: string }[] = [];

    for (const raw of Array.isArray(doc.servers) ? doc.servers : []) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Rec;
      const host = str(r.host)?.trim();
      if (!host) {
        b.issue(`${name} › ${str(r.name) ?? '?'}`, '缺少 host');
        continue;
      }
      const parentRaw = str(r.parentId);
      const parentId = parentRaw ? (folderIds.get(parentRaw) ?? null) : null;
      if (parentRaw && !parentId) b.warn(`${name}：有连接的上级文件夹不在文件里，已放到根目录`);
      const advanced = pickAdvanced(r.advanced);
      const s = b.addServer({
        parentId,
        name: str(r.name)?.trim() || host,
        host,
        port: parsePort(typeof r.port === 'number' ? r.port : str(r.port)) ?? 22,
        user: str(r.user) ?? '',
        note: str(r.note) ?? '',
        proto: r.proto === 'rdp' ? 'rdp' : 'ssh',
        auth: r.auth === 'key' || r.auth === 'keychain' ? 'key' : 'password',
        keyLabel: str(r.keyLabel) ?? null,
        password: null,
        advanced: advanced ? { ...DEFAULT_ADVANCED, ...advanced, jumpServerId: null } : undefined,
        forwards: pickForwards(r.forwards),
      });
      const sourceId = str(r.id);
      if (sourceId) serverIds.set(sourceId, s.id);
      const jump = advanced && (r.advanced as Rec).jumpServerId;
      if (typeof jump === 'string') jumpRefs.push({ localId: s.id, sourceId: jump });
    }

    for (const { localId, sourceId } of jumpRefs) {
      const target = serverIds.get(sourceId);
      const s = b.result.servers.find((x) => x.id === localId);
      if (s?.advanced && target) s.advanced.jumpServerId = target;
    }
  }
  return b.result;
}
