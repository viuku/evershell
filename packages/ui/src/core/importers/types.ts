import type { AdvancedOptions, AuthMethod, ForwardRule, Protocol } from '../hosts-store';

// 各来源解析器输出的统一中间结构：文件夹树 + 连接 + 可选密码 + 问题列表。
// 解析器都是纯函数，不碰 store，方便单元测试。

export type ImportSource = 'finalshell' | 'xshell' | 'mobaxterm' | 'putty' | 'securecrt' | 'openssh' | 'evershell';

export interface ImportFile {
  /** 相对路径（选文件夹时带目录），用来还原文件夹层级和报错定位 */
  path: string;
  bytes: Uint8Array;
}

export interface ImportedFolder {
  id: string;
  parentId: string | null;
  name: string;
}

export interface ImportedServer {
  id: string;
  parentId: string | null;
  name: string;
  host: string;
  port: number;
  user: string;
  note: string;
  proto: Protocol;
  auth: AuthMethod;
  keyLabel: string | null;
  /** 解出的明文密码；来源没有或无法解密时为 null */
  password: string | null;
  advanced?: Partial<AdvancedOptions>;
  forwards?: ForwardRule[];
}

/** 一条解析失败、没有导入的记录 */
export interface ImportIssue {
  file: string;
  message: string;
}

export interface ImportResult {
  source: ImportSource;
  folders: ImportedFolder[];
  servers: ImportedServer[];
  issues: ImportIssue[];
  /** 不影响导入的提醒，如 Include 未展开、密码未导入 */
  warnings: string[];
}

export type Parser = (files: ImportFile[]) => ImportResult;

type ServerInput = Omit<ImportedServer, 'id' | 'parentId'> & { parentId?: string | null };

/** 攒结果用：按路径建文件夹链（同一父级下同名复用）、分配本地 id */
export class ResultBuilder {
  readonly result: ImportResult;
  private seq = 0;

  constructor(source: ImportSource) {
    this.result = { source, folders: [], servers: [], issues: [], warnings: [] };
  }

  /** 返回路径末端文件夹的 id；空路径即根目录 */
  folderFor(parts: string[], parentId: string | null = null): string | null {
    let parent = parentId;
    for (const raw of parts) {
      const name = raw.trim();
      if (!name) continue;
      let f = this.result.folders.find((x) => x.parentId === parent && x.name === name);
      if (!f) {
        f = { id: `f${++this.seq}`, parentId: parent, name };
        this.result.folders.push(f);
      }
      parent = f.id;
    }
    return parent;
  }

  /** 来源自带 id 的文件夹（FinalShell / EverShell），返回本地 id */
  addFolder(name: string, parentId: string | null): string {
    const id = `f${++this.seq}`;
    this.result.folders.push({ id, parentId, name: name.trim() || '未命名文件夹' });
    return id;
  }

  addServer(input: ServerInput): ImportedServer {
    const s: ImportedServer = { id: `s${++this.seq}`, ...input, parentId: input.parentId ?? null };
    this.result.servers.push(s);
    return s;
  }

  issue(file: string, message: string): void {
    this.result.issues.push({ file, message });
  }

  warn(message: string): void {
    if (!this.result.warnings.includes(message)) this.result.warnings.push(message);
  }
}

/**
 * 来源自带 id / parentId 的文件夹列表 → 本地文件夹树。上级先建、下级后建；
 * 上级不在列表里的放到根目录并提醒。返回 来源 id → 本地 id。
 */
export function linkFolders(b: ResultBuilder, folders: { id: string; name: string; parentId: string | null }[]): Map<string, string> {
  const ids = new Map<string, string>();
  const pending = [...folders];
  let progressed = true;
  while (pending.length > 0 && progressed) {
    progressed = false;
    for (let i = 0; i < pending.length; i++) {
      const f = pending[i]!;
      if (f.parentId && !ids.has(f.parentId)) continue;
      ids.set(f.id, b.addFolder(f.name, f.parentId ? (ids.get(f.parentId) ?? null) : null));
      pending.splice(i--, 1);
      progressed = true;
    }
  }
  for (const f of pending) {
    ids.set(f.id, b.addFolder(f.name, null));
    b.warn(`文件夹「${f.name}」的上级文件夹不在所选文件中，已放入根目录`);
  }
  return ids;
}
