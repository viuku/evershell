import type { FileEntry, SshSession } from '../types';
import { ancestors, basename, joinPath, normalizePath, parentPath } from './paths';
import { Store } from './store';
import { trackTransfer } from './transfers-store';

/** 左侧目录树的节点。children 为 null 表示还没加载过 */
export interface TreeNode {
  path: string;
  name: string;
  children: TreeNode[] | null;
  expanded: boolean;
  loading: boolean;
}

export interface FileBrowserState {
  home: string | null;
  cwd: string | null;
  entries: FileEntry[];
  loading: boolean;
  /** 列目录失败的原因 */
  error: string | null;
  /** 最近一次新建 / 删除 / 改名 / 传输失败的原因 */
  opError: string | null;
  selected: string | null;
  root: TreeNode;
}

const ROOT: TreeNode = { path: '/', name: '/', children: null, expanded: true, loading: false };

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    const da = a.kind === 'dir' ? 0 : 1;
    const db = b.kind === 'dir' ? 0 : 1;
    if (da !== db) return da - db;
    return a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  });
}

function updateNode(node: TreeNode, path: string, fn: (n: TreeNode) => TreeNode): TreeNode {
  if (node.path === path) return fn(node);
  if (!node.children || !path.startsWith(node.path === '/' ? '/' : `${node.path}/`)) return node;
  let changed = false;
  const children = node.children.map((c) => {
    const next = updateNode(c, path, fn);
    if (next !== c) changed = true;
    return next;
  });
  return changed ? { ...node, children } : node;
}

function findNode(node: TreeNode, path: string): TreeNode | null {
  if (node.path === path) return node;
  if (!node.children) return null;
  for (const c of node.children) {
    if (path === c.path || path.startsWith(`${c.path}/`)) return findNode(c, path);
  }
  return null;
}

function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 一个会话的 SFTP 浏览状态：当前目录、文件列表、目录树。
 * 由 SessionManager 持有，切换标签回来时状态还在。
 */
export class FileBrowser {
  readonly store = new Store<FileBrowserState>({
    home: null,
    cwd: null,
    entries: [],
    loading: true,
    error: null,
    opError: null,
    selected: null,
    root: ROOT,
  });

  /** 递增序号，丢弃过期的 listDir 结果 */
  private seq = 0;

  constructor(private readonly session: SshSession) {}

  private patch(p: Partial<FileBrowserState>): void {
    this.store.set((s) => ({ ...s, ...p }));
  }

  async init(): Promise<void> {
    try {
      const home = normalizePath(await this.session.homeDir());
      this.patch({ home });
      await this.open(home);
    } catch (err) {
      this.patch({ loading: false, error: errorText(err) });
    }
  }

  async open(path: string): Promise<void> {
    const target = normalizePath(path);
    const seq = ++this.seq;
    this.patch({ cwd: target, loading: true, selected: null, opError: null });
    try {
      const entries = sortEntries(await this.session.listDir(target));
      if (seq !== this.seq) return;
      this.patch({ entries, loading: false, error: null });
      this.setChildren(target, entries);
    } catch (err) {
      if (seq !== this.seq) return;
      this.patch({ entries: [], loading: false, error: errorText(err) });
    }
    void this.reveal(target);
  }

  up(): void {
    const { cwd } = this.store.get();
    const parent = cwd ? parentPath(cwd) : null;
    if (parent) void this.open(parent);
  }

  refresh(): void {
    const { cwd } = this.store.get();
    if (cwd) void this.open(cwd);
  }

  /** 正开着 dir 就刷新（别处改了这个目录里的文件，比如编辑器存了一个文件） */
  refreshIfShowing(dir: string): void {
    const { cwd, selected } = this.store.get();
    if (cwd !== normalizePath(dir)) return;
    // 刷新会清掉选中，选中的那行还在就选回来
    void this.open(cwd).then(() => {
      if (selected && this.store.get().cwd === cwd && !this.store.get().selected) this.select(selected);
    });
  }

  select(name: string | null): void {
    if (this.store.get().selected !== name) this.patch({ selected: name });
  }

  /** 跟着符号链接看它指向什么；看不了返回 null */
  async statTarget(path: string): Promise<FileEntry | null> {
    return this.session.stat(path).catch(() => null);
  }

  selectedEntry(): FileEntry | null {
    const { entries, selected } = this.store.get();
    return entries.find((e) => e.name === selected) ?? null;
  }

  /** 展开 / 折叠树节点；第一次展开时才加载子目录 */
  async toggleNode(path: string): Promise<void> {
    const node = findNode(this.store.get().root, path);
    if (!node) return;
    if (node.expanded) {
      this.patch({ root: updateNode(this.store.get().root, path, (n) => ({ ...n, expanded: false })) });
      return;
    }
    this.patch({ root: updateNode(this.store.get().root, path, (n) => ({ ...n, expanded: true })) });
    if (node.children === null) await this.loadChildren(path);
  }

  private async loadChildren(path: string): Promise<void> {
    this.patch({ root: updateNode(this.store.get().root, path, (n) => ({ ...n, loading: true })) });
    try {
      const entries = await this.session.listDir(path);
      this.setChildren(path, entries);
    } catch {
      // 读不了就当空目录，树上不报错，文件表那边会显示原因
      this.setChildren(path, []);
    }
  }

  private setChildren(path: string, entries: FileEntry[]): void {
    const dirs = sortEntries(entries.filter((e) => e.kind === 'dir'));
    this.patch({
      root: updateNode(this.store.get().root, path, (n) => {
        const old = new Map((n.children ?? []).map((c) => [c.path, c]));
        return {
          ...n,
          loading: false,
          children: dirs.map((d) => {
            const p = joinPath(path, d.name);
            return old.get(p) ?? { path: p, name: d.name, children: null, expanded: false, loading: false };
          }),
        };
      }),
    });
  }

  /** 把 path 的每一级祖先展开并加载出来，让树上能看到当前目录 */
  private async reveal(path: string): Promise<void> {
    for (const p of ancestors(path)) {
      if (p === path) break;
      const node = findNode(this.store.get().root, p);
      if (!node) return;
      if (node.children === null) await this.loadChildren(p);
      if (!node.expanded) {
        this.patch({ root: updateNode(this.store.get().root, p, (n) => ({ ...n, expanded: true })) });
      }
    }
  }

  private async op(run: () => Promise<void>): Promise<boolean> {
    try {
      await run();
      this.refresh();
      return true;
    } catch (err) {
      this.patch({ opError: errorText(err) });
      return false;
    }
  }

  mkdir(name: string): Promise<boolean> {
    const { cwd } = this.store.get();
    if (!cwd) return Promise.resolve(false);
    return this.op(() => this.session.mkdir(joinPath(cwd, name)));
  }

  remove(entry: FileEntry): Promise<boolean> {
    const { cwd } = this.store.get();
    if (!cwd) return Promise.resolve(false);
    return this.op(() => this.session.remove(joinPath(cwd, entry.name), entry.kind === 'dir'));
  }

  rename(entry: FileEntry, newName: string): Promise<boolean> {
    const { cwd } = this.store.get();
    if (!cwd || newName === entry.name) return Promise.resolve(false);
    return this.op(() => this.session.rename(joinPath(cwd, entry.name), joinPath(cwd, newName)));
  }

  async upload(files: File[]): Promise<void> {
    const { cwd } = this.store.get();
    if (!cwd || files.length === 0) return;
    for (const file of files) {
      try {
        await trackTransfer('up', file.name, `本机 → ${cwd}`, file.size, (onProgress) =>
          this.session.upload(joinPath(cwd, file.name), file, onProgress),
        );
      } catch (err) {
        this.patch({ opError: `上传 ${file.name} 失败：${errorText(err)}` });
      }
    }
    if (this.store.get().cwd === cwd) this.refresh();
  }

  async download(entry: FileEntry): Promise<void> {
    const { cwd } = this.store.get();
    if (!cwd) return;
    try {
      await trackTransfer('down', entry.name, `${cwd} → 本机`, entry.size, (onProgress) =>
        this.session.download(joinPath(cwd, entry.name), onProgress),
      );
    } catch (err) {
      this.patch({ opError: `下载 ${entry.name} 失败：${errorText(err)}` });
    }
  }

  clearOpError(): void {
    if (this.store.get().opError) this.patch({ opError: null });
  }

  /** 当前目录的显示名，给面包屑 / 标题用 */
  cwdName(): string {
    const { cwd } = this.store.get();
    return cwd ? basename(cwd) : '';
  }
}
