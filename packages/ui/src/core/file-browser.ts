import type { FileEntry, PermScope, SshSession } from '../types';
import { ancestors, basename, joinPath, normalizePath, parentPath } from './paths';
import { emptySelection, pruneSelection, type Selection } from './selection';
import { Store } from './store';
import { trackTransfer } from './transfers-store';
import { foldersToCreate, type UploadItem } from './upload-items';

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
  /** 选中的文件名（core/selection.ts） */
  selection: Selection;
  /** 要等一会儿的操作（删除整个文件夹这类），文件表中间显示“正在删除…” */
  busy: string | null;
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
    selection: emptySelection,
    busy: null,
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

  /**
   * 进目录。进的是当前目录（刷新）时保留选中（列完去掉已经没有的），也不清掉刚才操作失败的提示：
   * 删除、上传完都会刷新，提示要留着
   */
  async open(path: string): Promise<void> {
    const target = normalizePath(path);
    const seq = ++this.seq;
    const same = target === this.store.get().cwd;
    this.patch({ cwd: target, loading: true, ...(same ? {} : { selection: emptySelection, opError: null }) });
    try {
      const entries = sortEntries(await this.session.listDir(target));
      if (seq !== this.seq) return;
      const names = entries.map((e) => e.name);
      this.patch({ entries, loading: false, error: null, selection: pruneSelection(this.store.get().selection, names) });
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
    const { cwd } = this.store.get();
    if (cwd === normalizePath(dir)) void this.open(cwd);
  }

  setSelection(selection: Selection): void {
    if (this.store.get().selection !== selection) this.patch({ selection });
  }

  /** 跟着符号链接看它指向什么；看不了返回 null */
  async statTarget(path: string): Promise<FileEntry | null> {
    return this.session.stat(path).catch(() => null);
  }

  /** 列一个目录但不进去（拖到某个文件夹上时查有没有同名的）；列不了当作空的 */
  async peek(dir: string): Promise<FileEntry[]> {
    return this.session.listDir(dir).catch(() => []);
  }

  /** 选中的项，按列表顺序 */
  selectedEntries(): FileEntry[] {
    const { entries, selection } = this.store.get();
    return entries.filter((e) => selection.ids.has(e.name));
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
      this.patch({ opError: null });
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

  /** 新建空文件；已经有同名的就报错，不覆盖 */
  createFile(name: string): Promise<boolean> {
    const { cwd } = this.store.get();
    if (!cwd) return Promise.resolve(false);
    const path = joinPath(cwd, name);
    return this.op(async () => {
      if (await this.statTarget(path)) throw new Error(`已存在名为「${name}」的项目`);
      await this.session.upload(path, new Blob([]));
    });
  }

  /** 删除，文件夹连同里面的内容一起删。一项失败不影响其他项，最后报第一个失败的 */
  async removeMany(list: readonly FileEntry[]): Promise<void> {
    const { cwd } = this.store.get();
    if (!cwd || list.length === 0) return;
    // 文件夹里东西多时要删一阵子，表中间提示一下，不然像没反应
    const slow = list.some((e) => e.kind === 'dir');
    if (slow) this.patch({ busy: '正在删除…' });
    let failed: string | null = null;
    for (const entry of list) {
      try {
        await this.session.remove(joinPath(cwd, entry.name), entry.kind === 'dir');
      } catch (err) {
        failed ??= `删除「${entry.name}」失败：${errorText(err)}`;
      }
    }
    this.patch({ busy: null, opError: failed });
    if (this.store.get().cwd === cwd) this.refresh();
  }

  rename(entry: FileEntry, newName: string): Promise<boolean> {
    const { cwd } = this.store.get();
    if (!cwd || newName === entry.name) return Promise.resolve(false);
    return this.op(() => this.session.rename(joinPath(cwd, entry.name), joinPath(cwd, newName)));
  }

  /**
   * 上传到 dest：先按层建好文件夹（已经有的直接用），再一个个传文件。
   * 同名的覆不覆盖由调用方先问好（core/upload-items.ts 的 findClashes）
   */
  async upload(dest: string, items: readonly UploadItem[]): Promise<void> {
    if (items.length === 0) return;
    const at = (rel: string) => joinPath(dest, rel);
    for (const rel of foldersToCreate(items)) {
      try {
        await this.ensureDir(at(rel));
      } catch (err) {
        // 文件夹建不了，里面的文件也传不了，整批停下
        this.patch({ opError: `无法创建文件夹「${rel}」：${errorText(err)}` });
        this.refreshIfUnder(dest);
        return;
      }
    }
    for (const { path: rel, file } of items) {
      if (!file) continue;
      const dir = parentPath(at(rel)) ?? dest;
      try {
        await trackTransfer('up', file.name, `本机 → ${dir}`, file.size, (onProgress) =>
          this.session.upload(at(rel), file, onProgress),
        );
      } catch (err) {
        this.patch({ opError: `上传 ${rel} 失败：${errorText(err)}` });
      }
    }
    this.refreshIfUnder(dest);
    // 传进了别的目录（拖到左边树上）：树上那一层已经展开过的话，把新文件夹补上
    const node = findNode(this.store.get().root, dest);
    if (dest !== this.store.get().cwd && node?.children && foldersToCreate(items).length > 0) void this.loadChildren(dest);
  }

  /** 建文件夹；已经有同名的文件夹时直接用 */
  private async ensureDir(path: string): Promise<void> {
    try {
      await this.session.mkdir(path);
    } catch (err) {
      const there = await this.statTarget(path);
      if (there?.kind !== 'dir') throw err;
    }
  }

  /** 改动发生在 dir 里：dir 就是当前目录、或者是当前目录下的文件夹（拖到某个文件夹上）时刷新 */
  private refreshIfUnder(dir: string): void {
    const { cwd } = this.store.get();
    if (cwd && (dir === cwd || parentPath(dir) === cwd)) this.refresh();
  }

  /** 这个平台能不能下载整个文件夹（网页端不能，浏览器存不了文件夹） */
  get canDownloadDirs(): boolean {
    return !!this.session.downloadDir;
  }

  /** 这个平台有没有打包传输（网页端没有） */
  get canPack(): boolean {
    return !!this.session.packDownload;
  }

  async downloadMany(list: readonly FileEntry[]): Promise<void> {
    for (const entry of list) await this.download(entry);
  }

  async download(entry: FileEntry): Promise<void> {
    const { cwd } = this.store.get();
    if (!cwd) return;
    const path = joinPath(cwd, entry.name);
    const dirDownload = entry.kind === 'dir' ? this.session.downloadDir?.bind(this.session) : undefined;
    try {
      if (dirDownload) {
        await trackTransfer('down', entry.name, `${cwd} → 本机`, 0, (onProgress) => dirDownload(path, onProgress), '正在统计文件…');
      } else {
        await trackTransfer('down', entry.name, `${cwd} → 本机`, entry.size, (onProgress) => this.session.download(path, onProgress));
      }
    } catch (err) {
      this.patch({ opError: `下载 ${entry.name} 失败：${errorText(err)}` });
    }
  }

  /** 打包传输：服务器上打成一个压缩包，下载下来自动解压（docs/specs/file-ops.md） */
  async packDownload(list: readonly FileEntry[]): Promise<void> {
    const { cwd } = this.store.get();
    const pack = this.session.packDownload?.bind(this.session);
    const first = list[0];
    if (!cwd || !pack || !first) return;
    const label = list.length === 1 ? `${first.name}（打包）` : `${first.name} 等 ${list.length} 项（打包）`;
    const names = list.map((e) => e.name);
    try {
      await trackTransfer('down', label, `${cwd} → 本机`, 0, (onProgress) => pack(cwd, names, onProgress), '正在服务器上打包…');
    } catch (err) {
      this.patch({ opError: `打包传输失败：${errorText(err)}` });
    }
  }

  /** 改权限，scope 见 types.ts 的 PermScope。一项失败不影响其他项，最后报第一个失败的 */
  async chmodMany(list: readonly FileEntry[], mode: number, scope: PermScope): Promise<void> {
    const { cwd } = this.store.get();
    if (!cwd || list.length === 0) return;
    const slow = scope !== 'self' && list.some((e) => e.kind === 'dir');
    if (slow) this.patch({ busy: '正在修改权限…' });
    let failed: string | null = null;
    for (const entry of list) {
      try {
        await this.session.chmod(joinPath(cwd, entry.name), mode, scope);
      } catch (err) {
        failed ??= `修改「${entry.name}」的权限失败：${errorText(err)}`;
      }
    }
    this.patch({ busy: null, opError: failed });
    if (this.store.get().cwd === cwd) this.refresh();
  }

  /** 快速删除：服务器上一条 rm -rf 删掉选中的全部 */
  async removeFast(list: readonly FileEntry[]): Promise<void> {
    const { cwd } = this.store.get();
    if (!cwd || list.length === 0) return;
    this.patch({ busy: '正在删除…' });
    let failed: string | null = null;
    try {
      await this.session.removeFast(list.map((e) => joinPath(cwd, e.name)));
    } catch (err) {
      failed = errorText(err);
    }
    this.patch({ busy: null, opError: failed });
    if (this.store.get().cwd === cwd) this.refresh();
  }

  /** 界面上的操作失败了（比如复制到剪贴板），和文件操作失败一样显示在文件表上方 */
  showError(message: string): void {
    this.patch({ opError: message });
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
