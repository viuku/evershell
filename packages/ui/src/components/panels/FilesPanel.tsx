import { useEffect, useId, useRef, useState, type ChangeEvent, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import type { FileBrowser, TreeNode } from '../../core/file-browser';
import { formatBytesLong, formatMtime } from '../../core/format';
import { isValidName, joinPath } from '../../core/paths';
import { fileKeyAction, fileKeyLabels, isMac, isSelectAllKey, isToggleSelect, type FileKeyAction } from '../../core/platform';
import { EDIT_MAX_BYTES } from '../../core/remote-edit';
import {
  clickSelect,
  contextSelect,
  emptySelection,
  extendTo,
  findByPrefix,
  jumpSelect,
  moveSelect,
  selectAll,
  selectOnly,
  type Selection,
} from '../../core/selection';
import type { SessionInfo } from '../../core/session-manager';
import { useMaybeStore } from '../../core/store';
import {
  findClashes,
  hasFiles,
  itemsFromDrop,
  itemsFromFiles,
  topCount,
  withoutTop,
  type PickedUploads,
  type UploadClash,
} from '../../core/upload-items';
import type { FileEntry } from '../../types';
import { useDialogs } from '../common/Dialogs';
import { useRemoteEdit } from '../editor/remote-edit-context';
import { PermissionsDialog } from './PermissionsDialog';
import { TransfersButton } from './TransfersButton';
import { useDragSelect } from './use-drag-select';
import { CloseIcon, DisclosureIcon, FileIcon, FolderFillIcon, NewFolderIcon, RefreshIcon, UpIcon, UploadIcon } from '../common/Icons';
import { ContextMenu, type ContextMenuState, type MenuItem } from '../common/Menu';

interface Props {
  files: FileBrowser | null;
  session: SessionInfo;
  follow: boolean;
}

/** 进目录时超过这么久还没列出来，就把文件表换成“正在载入”；更快的话直接换成新列表，不闪 */
const LOADING_DELAY_MS = 250;
/** 直接打字跳转：隔这么久没按键就重新开始 */
const TYPE_AHEAD_MS = 800;
/** 拖着文件这么久没收到 dragover 就当已经拖走了（鼠标停着不动时浏览器最慢约 550ms 发一次） */
const DRAG_IDLE_MS = 1000;

/** 拖着本机文件停在哪：table 是文件表的空白处或文件上（传到当前目录），row 是某个文件夹那一行，tree 是左边树上 */
interface DropTarget {
  path: string;
  where: 'table' | 'row' | 'tree';
}

/** flag 连续为 true 超过 ms 毫秒才返回 true */
function useLingering(flag: boolean, ms: number): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!flag) {
      setOn(false);
      return;
    }
    const timer = setTimeout(() => setOn(true), ms);
    return () => clearTimeout(timer);
  }, [flag, ms]);
  return flag && on;
}

/** 名字太多时只列前三个 */
function listNames(names: readonly string[]): string {
  return `${names.slice(0, 3).join('、')}${names.length > 3 ? ' 等' : ''}`;
}

/** 上传时目标里有同名项目，问覆盖还是跳过 */
function clashMessage(dest: string, clashes: readonly UploadClash[], total: number): string {
  const names = clashes.map((c) => c.name);
  const head =
    names.length === 1 ? `「${dest}」中已存在同名的「${names[0]}」。` : `「${dest}」中已存在 ${names.length} 个同名项目：${listNames(names)}。`;
  const what = clashes.some((c) => c.merge)
    ? '覆盖时同名文件夹将合并，其中的同名文件将被替换且无法恢复。'
    : '覆盖后，服务器上原有的文件将无法恢复。';
  const rest = total - clashes.length;
  return `${head}${what}${rest > 0 ? `选择「跳过」将只上传其余 ${rest} 项。` : ''}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** SFTP 文件面板：左边目录树，右边文件表 */
export function FilesPanel({ files, session, follow }: Props) {
  const state = useMaybeStore(files ? files.store : null);
  // 网络慢时进目录要等一会儿，不提示的话像没点上（所有者 2026-10-23 报的）
  const slowLoading = useLingering(!!state?.loading, LOADING_DELAY_MS);
  const dialogs = useDialogs();
  const remoteEdit = useRemoteEdit();
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [pathDraft, setPathDraft] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const rowId = useId();
  /** 正在读进编辑器的文件：路径 → 进度（0～1，还没开始读时为 null）。网络慢时那一行显示“打开中”，不然像没点上 */
  const [opening, setOpening] = useState<ReadonlyMap<string, number | null>>(new Map());
  const markOpening = (path: string, progress: number | null | undefined) =>
    setOpening((m) => {
      const next = new Map(m);
      if (progress === undefined) next.delete(path);
      else next.set(path, progress);
      return next;
    });
  const [drop, setDrop] = useState<DropTarget | null>(null);
  /** 文件权限对话框开着时，改的是哪几项 */
  const [permFor, setPermFor] = useState<readonly FileEntry[] | null>(null);
  /** 拖着文件进出文件区里各个元素的层数，减到 0 就是拖出去了 */
  const dropDepth = useRef(0);
  const dropIdle = useRef<number | undefined>(undefined);
  const typed = useRef({ text: '', at: 0 });
  /** 键盘移动了选中：画完后把那一行滚进视野 */
  const reveal = useRef(false);

  const order = () => (files ? files.store.get().entries.map((e) => e.name) : []);
  const setSel = (sel: Selection) => files?.setSelection(sel);
  const startDrag = useDragSelect((name) => {
    if (files) setSel(extendTo(files.store.get().selection, order(), name));
  });

  // 勾选“跟随终端目录”时，终端 cd 到哪里文件区就跳到哪里
  const termCwd = session.cwd;
  useEffect(() => {
    if (!follow || !files || !termCwd) return;
    if (files.store.get().cwd !== termCwd) void files.open(termCwd);
  }, [follow, files, termCwd]);

  const focusName = state?.selection.focus ?? null;
  useEffect(() => {
    if (!reveal.current) return;
    reveal.current = false;
    const rows = tableRef.current?.querySelectorAll<HTMLElement>('[data-row]') ?? [];
    [...rows].find((r) => r.dataset.row === focusName)?.scrollIntoView({ block: 'nearest' });
  }, [focusName]);

  useEffect(() => () => window.clearTimeout(dropIdle.current), []);

  if (session.status !== 'connected' || !files || !state) {
    return (
      <div className="empty bottom__offline">
        {session.status === 'connecting' ? '连接中…' : '会话已断开，重新连接后将显示远程文件'}
      </div>
    );
  }

  const cwd = state.cwd ?? '/';
  const names = state.entries.map((e) => e.name);
  const picked = state.entries.filter((e) => state.selection.ids.has(e.name));
  const focusIndex = focusName === null ? -1 : names.indexOf(focusName);
  /** 处理事件时用最新的选中，不用画这一帧时的 */
  const current = () => files.selectedEntries();

  const nameError = (v: string, keep?: string) => {
    const name = v.trim();
    if (!isValidName(name)) return '名称不能为空，且不能包含 /';
    if (name !== keep && files.store.get().entries.some((e) => e.name === name)) return '已存在同名项目';
    return null;
  };

  const newFolder = async () => {
    const name = await dialogs.prompt({
      title: '新建文件夹',
      label: `在 ${cwd} 下新建`,
      initial: '未命名文件夹',
      validate: (v) => nameError(v),
    });
    if (name) await files.mkdir(name.trim());
  };

  const newFile = async () => {
    const name = await dialogs.prompt({
      title: '新建文件',
      label: `在 ${cwd} 下新建`,
      initial: '未命名文件',
      validate: (v) => nameError(v),
    });
    if (name) await files.createFile(name.trim());
  };

  const rename = async (entry: FileEntry) => {
    const name = await dialogs.prompt({
      title: '重命名',
      label: entry.name,
      initial: entry.name,
      okText: '重命名',
      validate: (v) => nameError(v, entry.name),
    });
    if (name && name.trim() !== entry.name) await files.rename(entry, name.trim());
  };

  const remove = async (list: readonly FileEntry[]) => {
    const one = list.length === 1 ? list[0] : undefined;
    if (list.length === 0) return;
    const ok = await dialogs.confirm({
      title: one ? (one.kind === 'dir' ? '删除文件夹' : '删除文件') : `删除 ${list.length} 项`,
      message: one
        ? one.kind === 'dir'
          ? `确定要删除文件夹「${one.name}」及其中的全部内容吗？远程文件删除后无法恢复。`
          : `确定要删除「${one.name}」吗？远程文件删除后无法恢复。`
        : `确定要删除选中的 ${list.length} 项吗？${list.some((e) => e.kind === 'dir') ? '其中的文件夹将连同全部内容一起删除，' : ''}远程文件删除后无法恢复。`,
      okText: '删除',
      danger: true,
    });
    if (ok) await files.removeMany(list);
  };

  /** 快速删除：确认框里写出将在服务器上执行的命令 */
  const removeFast = async (list: readonly FileEntry[]) => {
    if (list.length === 0) return;
    const one = list.length === 1 ? list[0] : undefined;
    const quoted = list.map((e) => `'${joinPath(cwd, e.name).replace(/'/g, `'\\''`)}'`);
    const ok = await dialogs.confirm({
      title: '快速删除',
      message: `确定要使用 rm 命令删除${one ? `「${one.name}」` : `选中的 ${list.length} 项`}吗？${list.some((e) => e.kind === 'dir') ? '文件夹将连同全部内容一起删除，' : ''}删除后无法恢复。`,
      detail: `rm -rf -- ${quoted.join(' ')}`,
      okText: '删除',
      danger: true,
    });
    if (ok) await files.removeFast(list);
  };

  /** 下载：选中的含文件夹时，平台得能下载文件夹（网页端不能） */
  const canDownload = (list: readonly FileEntry[]) =>
    list.length > 0 && (files.canDownloadDirs || list.every((e) => e.kind !== 'dir'));

  /** 双击、右键「打开」：读进编辑器，改完保存直接传回服务器；打不开的问要不要下载 */
  const edit = async (entry: FileEntry) => {
    if (!remoteEdit) return;
    const offer = async (title: string, message: string) => {
      const ok = await dialogs.confirm({ title, message, okText: '下载到本机' });
      if (ok) await files.download(entry);
    };
    const path = joinPath(cwd, entry.name);
    if (opening.has(path)) return;
    markOpening(path, null);
    try {
      const r = await remoteEdit
        .open(session.id, path, (p) => markOpening(path, p.total > 0 ? p.done / p.total : 1))
        .finally(() => markOpening(path, undefined));
      if (r.kind === 'too-large') {
        await offer('该文件无法在编辑器中打开', `${entry.name} 大小为 ${formatBytesLong(r.size)}，编辑器最多只能打开 ${EDIT_MAX_BYTES / 2 ** 20} MB 的文件。`);
      } else if (r.kind === 'not-text') {
        await offer('该文件无法在编辑器中打开', `${entry.name} 似乎不是文本文件，可能是图片、压缩包或程序。`);
      }
    } catch (err) {
      await dialogs.alert('无法打开该文件', errorText(err));
    }
  };

  /** 双击：目录进去，文件编辑；链接先当文件编辑，指向目录的话进目录 */
  const activate = (entry: FileEntry) => {
    if (entry.kind === 'dir') void files.open(joinPath(cwd, entry.name));
    else if (entry.kind === 'link') void openLink(entry);
    else void edit(entry);
  };

  const openLink = async (entry: FileEntry) => {
    const path = joinPath(cwd, entry.name);
    const target = await files.statTarget(path);
    if (target?.kind === 'dir') void files.open(path);
    else void edit(entry);
  };

  /** 选中的每一项一行；什么都没选时复制当前目录 */
  const copyPaths = async (list: readonly FileEntry[]) => {
    const text = list.length > 0 ? list.map((e) => joinPath(cwd, e.name)).join('\n') : cwd;
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      files.showError(`无法复制路径：${errorText(err)}`);
    }
  };

  /** 上传到 dest：有同名的先问覆盖还是跳过 */
  const uploadTo = async (dest: string, got: PickedUploads) => {
    const bad = got.unreadable;
    if (bad.length > 0) {
      files.showError(bad.length === 1 ? `无法读取「${bad[0]}」，已跳过` : `无法读取 ${bad.length} 个项目（${listNames(bad)}），已跳过`);
    }
    let items = got.items;
    if (items.length === 0) return;
    const existing = dest === files.store.get().cwd ? files.store.get().entries : await files.peek(dest);
    const clashes = findClashes(items, existing);
    if (clashes.length > 0) {
      const choice = await dialogs.choose({
        title: '存在同名项目',
        message: clashMessage(dest, clashes, topCount(items)),
        actions: [
          { id: 'cancel', label: '取消' },
          { id: 'overwrite', label: '覆盖', tone: 'danger' },
          { id: 'skip', label: '跳过', tone: 'primary' },
        ],
        cancel: 'cancel',
        aside: 'cancel',
      });
      if (choice === 'cancel') return;
      if (choice === 'skip') items = withoutTop(items, clashes.map((c) => c.name));
    }
    await files.upload(dest, items);
  };

  const onUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const got = itemsFromFiles(e.target.files ? [...e.target.files] : []);
    e.target.value = '';
    void uploadTo(cwd, got);
  };

  const L = fileKeyLabels;
  /** 右键菜单，照 FinalShell 的顺序；list 是右键时选中的项，点在空白处时为空 */
  const contextItems = (list: readonly FileEntry[]): MenuItem[] => {
    const one = list.length === 1 ? list[0] : undefined;
    return [
      { label: '刷新', hint: L.refresh, onSelect: () => files.refresh() },
      { type: 'separator' },
      { label: '打开', hint: L.open, disabled: !one, onSelect: () => one && activate(one) },
      { type: 'separator' },
      { label: '复制路径', hint: L.copyPath, onSelect: () => void copyPaths(list) },
      { type: 'separator' },
      { label: '下载', disabled: !canDownload(list), onSelect: () => void files.downloadMany(list) },
      { label: '上传…', onSelect: () => uploadRef.current?.click() },
      { type: 'separator' },
      ...(files.canPack
        ? ([
            { label: '打包传输', disabled: list.length === 0, onSelect: () => void files.packDownload(list) },
            { type: 'separator' },
          ] satisfies MenuItem[])
        : []),
      {
        type: 'submenu',
        label: '新建',
        items: [
          { label: '文件夹…', hint: L.newFolder, onSelect: () => void newFolder() },
          { label: '文件…', onSelect: () => void newFile() },
        ],
      },
      { type: 'separator' },
      { label: '重命名…', hint: L.rename, disabled: !one, onSelect: () => one && void rename(one) },
      { label: '删除…', hint: L.delete, danger: true, disabled: list.length === 0, onSelect: () => void remove(list) },
      { label: '快速删除（rm 命令）…', danger: true, disabled: list.length === 0, onSelect: () => void removeFast(list) },
      { type: 'separator' },
      { label: '文件权限…', disabled: list.length === 0, onSelect: () => setPermFor(list) },
    ];
  };

  const openMenu = (e: MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const runKey = (action: FileKeyAction) => {
    const list = current();
    const one = list.length === 1 ? list[0] : undefined;
    switch (action) {
      case 'open':
        if (one) activate(one);
        break;
      case 'up':
        files.up();
        break;
      case 'rename':
        if (one) void rename(one);
        break;
      case 'delete':
        void remove(list);
        break;
      case 'newFolder':
        void newFolder();
        break;
      case 'refresh':
        files.refresh();
        break;
      case 'copyPath':
        void copyPaths(list);
        break;
      case 'focusPath':
        pathRef.current?.focus();
        pathRef.current?.select();
        break;
    }
  };

  // 文件列表的键盘操作：方向键移动（按住 Shift 连选），Home / End，全选，Esc 取消，直接打字跳到那个名字；
  // 其余快捷键见 core/platform.ts 的 fileKeyAction
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.nativeEvent.isComposing) return;
    const sel = files.store.get().selection;
    const all = order();
    const action = fileKeyAction(e);
    const bare = !e.metaKey && !e.ctrlKey && !e.altKey;
    if (action) {
      e.preventDefault();
      runKey(action);
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && bare) {
      e.preventDefault();
      reveal.current = true;
      setSel(moveSelect(sel, all, e.key === 'ArrowDown' ? 1 : -1, e.shiftKey));
    } else if ((e.key === 'Home' || e.key === 'End') && bare) {
      e.preventDefault();
      reveal.current = true;
      setSel(jumpSelect(sel, all, e.key === 'Home' ? 'first' : 'last', e.shiftKey));
    } else if (isSelectAllKey(e)) {
      e.preventDefault();
      setSel(selectAll(sel, all));
    } else if (e.key === 'Escape' && sel.ids.size > 0) {
      e.preventDefault();
      setSel(emptySelection);
    } else if (bare && e.key.length === 1 && e.key !== ' ') {
      const now = Date.now();
      const t = typed.current;
      t.text = (now - t.at > TYPE_AHEAD_MS ? '' : t.text) + e.key;
      t.at = now;
      const i = findByPrefix(all, t.text);
      const name = i === null ? undefined : all[i];
      if (name !== undefined) {
        reveal.current = true;
        setSel(selectOnly(name));
      }
    }
  };

  // ---- 从访达 / 资源管理器拖进来上传 ----

  /** target 为 null：拖到了不能放的地方（工具栏） */
  const dragOver = (target: DropTarget | null) => (e: DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    window.clearTimeout(dropIdle.current);
    dropIdle.current = window.setTimeout(() => setDrop(null), DRAG_IDLE_MS);
    if (!target) {
      setDrop(null);
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setDrop((d) => (d && d.path === target.path && d.where === target.where ? d : target));
  };

  const dropOn = (path: string) => (e: DragEvent) => {
    if (!hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    dropDepth.current = 0;
    window.clearTimeout(dropIdle.current);
    setDrop(null);
    // 文件清单要在这里同步取出来，事件处理完就读不到了
    void itemsFromDrop(e.dataTransfer).then((got) => uploadTo(path, got));
  };

  return (
    <div
      className="files"
      onDragEnter={(e) => {
        if (hasFiles(e.dataTransfer)) dropDepth.current++;
      }}
      onDragLeave={(e) => {
        if (!hasFiles(e.dataTransfer)) return;
        dropDepth.current = Math.max(0, dropDepth.current - 1);
        if (dropDepth.current === 0) setDrop(null);
      }}
      onDragOver={dragOver(null)}
    >
      <nav aria-label="目录" className="files__tree scroll">
        <TreeRow
          node={state.root}
          depth={0}
          cwd={cwd}
          files={files}
          dropPath={drop?.where === 'tree' ? drop.path : null}
          onDragOverPath={(path) => dragOver({ path, where: 'tree' })}
          onDropPath={dropOn}
        />
      </nav>
      <div className="files__main">
        <div className="files__toolbar">
          <button type="button" className="tb tb--sm" aria-label="上级目录" disabled={cwd === '/'} onClick={() => files.up()}>
            <UpIcon size={14} />
          </button>
          <label htmlFor="pathbox" className="sr-only">
            当前路径
          </label>
          <input
            ref={pathRef}
            id="pathbox"
            className="field files__path mono"
            value={pathDraft ?? cwd}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setPathDraft(e.target.value)}
            onBlur={() => setPathDraft(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && pathDraft) {
                void files.open(pathDraft.trim() || '/');
                setPathDraft(null);
              } else if (e.key === 'Escape') setPathDraft(null);
            }}
          />
          <button type="button" className="btn" onClick={() => uploadRef.current?.click()}>
            上传
          </button>
          <input ref={uploadRef} type="file" multiple className="sr-only" tabIndex={-1} onChange={onUpload} />
          <button
            type="button"
            className="btn"
            disabled={!canDownload(picked)}
            onClick={() => void files.downloadMany(current())}
          >
            下载
          </button>
          <button type="button" className="tb tb--sm" aria-label="新建文件夹" onClick={() => void newFolder()}>
            <NewFolderIcon size={14} />
          </button>
          <button type="button" className="tb tb--sm" aria-label="刷新" onClick={() => files.refresh()}>
            <RefreshIcon size={14} />
          </button>
          <TransfersButton />
        </div>
        {state.opError && (
          <div role="alert" className="inline-error">
            <span className="ellipsis">{state.opError}</span>
            <button type="button" className="tb" aria-label="关闭提示" onClick={() => files.clearOpError()}>
              <CloseIcon size={8} />
            </button>
          </div>
        )}
        <div className="files__body">
          <div
            ref={tableRef}
            className="files__table scroll"
            role="listbox"
            aria-label="文件"
            aria-multiselectable="true"
            aria-activedescendant={focusIndex >= 0 ? `${rowId}-${focusIndex}` : undefined}
            tabIndex={0}
            onKeyDown={onKey}
            onMouseDown={(e) => {
              // 点在最后一行下面的空白处：取消选择（按在滚动条上不算）
              if (e.target !== e.currentTarget || e.button !== 0) return;
              const el = e.currentTarget;
              const r = el.getBoundingClientRect();
              if (e.clientX - r.left > el.clientWidth || e.clientY - r.top > el.clientHeight) return;
              if (!isToggleSelect(e) && !e.shiftKey) setSel(emptySelection);
            }}
            onContextMenu={(e) => {
              setSel(emptySelection);
              openMenu(e, contextItems([]));
            }}
            onDragOver={dragOver({ path: cwd, where: 'table' })}
            onDrop={dropOn(cwd)}
          >
            <div className="files__inner">
              <div className="grid-head grid-head--sticky files__cols">
                <span>名称</span>
                <span className="files__right">大小</span>
                <span>修改时间</span>
                <span>权限</span>
                <span>所有者</span>
              </div>
              {state.error ? (
                <div className="empty">{state.error}</div>
              ) : state.loading && (state.entries.length === 0 || slowLoading) ? (
                <div className="files__loading" role="status">
                  <span className="files__loading-box">
                    <span className="files__spinner" aria-hidden="true" />
                    正在载入…
                  </span>
                </div>
              ) : state.entries.length === 0 ? (
                <div className="empty">此目录为空</div>
              ) : (
                state.entries.map((f, i) => {
                  const on = state.selection.ids.has(f.name);
                  const path = joinPath(cwd, f.name);
                  const loading = opening.has(path);
                  const progress = opening.get(path) ?? null;
                  const isDropTarget = drop?.where === 'row' && drop.path === path;
                  return (
                    // 行不接收焦点，键盘操作由外层列表接管
                    <div
                      key={f.name}
                      id={`${rowId}-${i}`}
                      data-row={f.name}
                      role="option"
                      className={`grid-row files__cols files__row${on ? ' grid-row--on' : ''}${isDropTarget ? ' files__row--drop' : ''}`}
                      aria-busy={loading || undefined}
                      aria-selected={on}
                      onMouseDown={(e) => {
                        // Mac 上 Ctrl+单击是右键，交给 onContextMenu
                        if (e.button !== 0 || (isMac && e.ctrlKey)) return;
                        const mods = { toggle: isToggleSelect(e), range: e.shiftKey };
                        const next = clickSelect(files.store.get().selection, order(), f.name, mods);
                        setSel(next);
                        // 按住加选键单击、取消了这一项时不开始拖动
                        if (mods.toggle && !mods.range && !next.ids.has(f.name)) return;
                        if (tableRef.current) startDrag(e, tableRef.current, f.name);
                      }}
                      onDoubleClick={(e) => {
                        if (!isToggleSelect(e) && !e.shiftKey) activate(f);
                      }}
                      onContextMenu={(e) => {
                        e.stopPropagation();
                        const next = contextSelect(files.store.get().selection, f.name);
                        setSel(next);
                        openMenu(e, contextItems(state.entries.filter((x) => next.ids.has(x.name))));
                      }}
                      onDragOver={f.kind === 'dir' ? dragOver({ path, where: 'row' }) : undefined}
                      onDrop={f.kind === 'dir' ? dropOn(path) : undefined}
                    >
                      <span className="files__name">
                        {f.kind === 'dir' ? (
                          <FolderFillIcon size={15} />
                        ) : (
                          <FileIcon size={15} style={{ opacity: 0.7, flex: '0 0 auto' }} />
                        )}
                        <span className="ellipsis">{f.name}</span>
                      </span>
                      <span className="files__right muted">
                        {loading
                          ? `正在打开${progress === null ? '…' : ` ${Math.floor(progress * 100)}%`}`
                          : f.kind === 'dir'
                            ? '--'
                            : f.kind === 'link'
                              ? '链接'
                              : formatBytesLong(f.size)}
                      </span>
                      <span className="muted">{formatMtime(f.mtime)}</span>
                      <span className="muted mono files__perm">{f.perm}</span>
                      <span className="muted ellipsis">{f.owner}</span>
                      {loading && (
                        <span
                          className={`files__open-bar${progress === null ? ' files__open-bar--wait' : ''}`}
                          style={{ width: `${(progress ?? 0) * 100}%` }}
                          aria-hidden="true"
                        />
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
          {state.busy && (
            <div className="files__busy" role="status">
              <span className="files__loading-box">
                <span className="files__spinner" aria-hidden="true" />
                {state.busy}
              </span>
            </div>
          )}
          {drop?.where === 'table' && <div className="files__drop-frame" aria-hidden="true" />}
          {drop && (
            <div className="files__drop-tip" role="status">
              <UploadIcon size={13} />
              <span>松开即可上传到</span>
              <span className="mono ellipsis">{drop.path}</span>
            </div>
          )}
        </div>
      </div>
      {permFor && (
        <PermissionsDialog
          cwd={cwd}
          entries={permFor}
          onCancel={() => setPermFor(null)}
          onApply={(mode, scope) => {
            const list = permFor;
            setPermFor(null);
            void files.chmodMany(list, mode, scope);
          }}
        />
      )}
      {menu && (
        <ContextMenu
          state={menu}
          onClose={() => {
            setMenu(null);
            // 焦点回到文件列表：菜单里点开的对话框关掉后焦点也会回到这里，可以接着用键盘
            tableRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}

interface TreeRowProps {
  node: TreeNode;
  depth: number;
  cwd: string;
  files: FileBrowser;
  /** 拖着文件停在哪个目录上 */
  dropPath: string | null;
  onDragOverPath(path: string): (e: DragEvent) => void;
  onDropPath(path: string): (e: DragEvent) => void;
}

function TreeRow({ node, depth, cwd, files, dropPath, onDragOverPath, onDropPath }: TreeRowProps) {
  const on = node.path === cwd;
  return (
    <>
      <div
        className={`tree__row${on ? ' tree__row--on' : ''}${dropPath === node.path ? ' tree__row--drop' : ''}`}
        style={{ paddingLeft: 4 + depth * 14 }}
        onDragOver={onDragOverPath(node.path)}
        onDrop={onDropPath(node.path)}
      >
        <button
          type="button"
          className="tree__toggle"
          aria-label={node.expanded ? '折叠' : '展开'}
          aria-expanded={node.expanded}
          onClick={() => void files.toggleNode(node.path)}
        >
          {node.children?.length === 0 && !node.loading ? null : <DisclosureIcon open={node.expanded} />}
        </button>
        <button type="button" className="tree__pick mono" title={node.path} onClick={() => void files.open(node.path)}>
          <FolderFillIcon size={14} />
          <span className="ellipsis">{node.name}</span>
          {node.loading && <span className="tree__loading">…</span>}
        </button>
      </div>
      {node.expanded &&
        node.children?.map((c) => (
          <TreeRow
            key={c.path}
            node={c}
            depth={depth + 1}
            cwd={cwd}
            files={files}
            dropPath={dropPath}
            onDragOverPath={onDragOverPath}
            onDropPath={onDropPath}
          />
        ))}
    </>
  );
}
