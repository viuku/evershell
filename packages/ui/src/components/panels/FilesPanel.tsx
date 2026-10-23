import { useEffect, useRef, useState, type ChangeEvent, type MouseEvent } from 'react';
import type { FileBrowser, TreeNode } from '../../core/file-browser';
import { formatBytesLong, formatMtime } from '../../core/format';
import { isValidName, joinPath } from '../../core/paths';
import { EDIT_MAX_BYTES } from '../../core/remote-edit';
import type { SessionInfo } from '../../core/session-manager';
import { useMaybeStore } from '../../core/store';
import type { FileEntry } from '../../types';
import { useDialogs } from '../common/Dialogs';
import { useRemoteEdit } from '../editor/remote-edit-context';
import { TransfersButton } from './TransfersButton';
import { CloseIcon, DisclosureIcon, FileIcon, FolderFillIcon, NewFolderIcon, RefreshIcon, UpIcon } from '../common/Icons';
import { ContextMenu, type ContextMenuState, type MenuItem } from '../common/Menu';

interface Props {
  files: FileBrowser | null;
  session: SessionInfo;
  follow: boolean;
}

/** SFTP 文件面板：左边目录树，右边文件表 */
export function FilesPanel({ files, session, follow }: Props) {
  const state = useMaybeStore(files ? files.store : null);
  const dialogs = useDialogs();
  const remoteEdit = useRemoteEdit();
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [pathDraft, setPathDraft] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  /** 正在读进编辑器的文件：路径 → 进度（0～1，还没开始读时为 null）。网络慢时那一行显示“打开中”，不然像没点上 */
  const [opening, setOpening] = useState<ReadonlyMap<string, number | null>>(new Map());
  const markOpening = (path: string, progress: number | null | undefined) =>
    setOpening((m) => {
      const next = new Map(m);
      if (progress === undefined) next.delete(path);
      else next.set(path, progress);
      return next;
    });

  // 勾选“跟随终端目录”时，终端 cd 到哪里文件区就跳到哪里
  const termCwd = session.cwd;
  useEffect(() => {
    if (!follow || !files || !termCwd) return;
    if (files.store.get().cwd !== termCwd) void files.open(termCwd);
  }, [follow, files, termCwd]);

  if (session.status !== 'connected' || !files || !state) {
    return (
      <div className="empty bottom__offline">
        {session.status === 'connecting' ? '连接中…' : '会话已断开，重连后显示远程文件'}
      </div>
    );
  }

  const cwd = state.cwd ?? '/';
  const selected = state.entries.find((e) => e.name === state.selected) ?? null;

  const newFolder = async () => {
    const name = await dialogs.prompt({
      title: '新建文件夹',
      label: `在 ${cwd} 下新建`,
      initial: '未命名文件夹',
      validate: (v) => (isValidName(v.trim()) ? null : '名称不能为空，也不能包含 /'),
    });
    if (name) await files.mkdir(name.trim());
  };

  const rename = async (entry: FileEntry) => {
    const name = await dialogs.prompt({
      title: '重命名',
      label: entry.name,
      initial: entry.name,
      okText: '重命名',
      validate: (v) => (isValidName(v.trim()) ? null : '名称不能为空，也不能包含 /'),
    });
    if (name && name.trim() !== entry.name) await files.rename(entry, name.trim());
  };

  const remove = async (entry: FileEntry) => {
    const ok = await dialogs.confirm({
      title: entry.kind === 'dir' ? '删除文件夹' : '删除文件',
      message: `确定要删除“${entry.name}”吗？远程文件删除后无法恢复。`,
      okText: '删除',
      danger: true,
    });
    if (ok) await files.remove(entry);
  };

  /** 双击、右键「编辑」：读进编辑器，改完保存直接传回服务器；打不开的问要不要下载 */
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
        await offer('这个文件不能在编辑器里打开', `${entry.name} 有 ${formatBytesLong(r.size)}，编辑器最多打开 ${EDIT_MAX_BYTES / 2 ** 20} MB。`);
      } else if (r.kind === 'not-text') {
        await offer('这个文件不能在编辑器里打开', `${entry.name} 不像文本文件，可能是图片、压缩包或程序。`);
      }
    } catch (err) {
      await dialogs.alert('打不开这个文件', err instanceof Error ? err.message : String(err));
    }
  };

  /** 双击：目录进去，文件编辑；链接先当文件编辑，指向目录的话进目录 */
  const activate = (entry: FileEntry) => {
    if (entry.kind === 'dir') void files.open(`${cwd}/${entry.name}`);
    else if (entry.kind === 'link') void openLink(entry);
    else void edit(entry);
  };

  const openLink = async (entry: FileEntry) => {
    const path = joinPath(cwd, entry.name);
    const target = await files.statTarget(path);
    if (target?.kind === 'dir') void files.open(path);
    else void edit(entry);
  };

  const onUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const list = e.target.files ? [...e.target.files] : [];
    e.target.value = '';
    void files.upload(list);
  };

  const entryMenu = (entry: FileEntry): MenuItem[] => [
    ...(entry.kind === 'dir'
      ? [{ label: '打开', onSelect: () => void files.open(`${cwd}/${entry.name}`) }]
      : [
          { label: '编辑', onSelect: () => void (entry.kind === 'link' ? openLink(entry) : edit(entry)) },
          { label: '下载到本机', onSelect: () => void files.download(entry) },
        ]),
    { type: 'separator' },
    { label: '重命名…', onSelect: () => void rename(entry) },
    { label: '删除…', danger: true, onSelect: () => void remove(entry) },
  ];

  const blankMenu: MenuItem[] = [
    { label: '新建文件夹…', onSelect: () => void newFolder() },
    { label: '上传…', onSelect: () => uploadRef.current?.click() },
    { type: 'separator' },
    { label: '刷新', onSelect: () => files.refresh() },
  ];

  const openMenu = (e: MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  return (
    <div className="files">
      <nav aria-label="目录" className="files__tree scroll">
        <TreeRow node={state.root} depth={0} cwd={cwd} files={files} />
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
            disabled={!selected || selected.kind === 'dir'}
            onClick={() => selected && void files.download(selected)}
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
        <div
          className="files__table scroll"
          onContextMenu={(e) => openMenu(e, blankMenu)}
          onClick={(e) => {
            if (e.target === e.currentTarget) files.select(null);
          }}
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
            ) : state.loading && state.entries.length === 0 ? (
              <div className="empty">读取中…</div>
            ) : state.entries.length === 0 ? (
              <div className="empty">空目录</div>
            ) : (
              state.entries.map((f) => {
                const on = f.name === state.selected;
                const path = joinPath(cwd, f.name);
                const loading = opening.has(path);
                const progress = opening.get(path) ?? null;
                return (
                  <button
                    key={f.name}
                    type="button"
                    className={`grid-row files__cols files__row${on ? ' grid-row--on' : ''}`}
                    aria-busy={loading || undefined}
                    aria-selected={on}
                    onClick={() => files.select(f.name)}
                    onDoubleClick={() => activate(f)}
                    onContextMenu={(e) => {
                      e.stopPropagation();
                      files.select(f.name);
                      openMenu(e, entryMenu(f));
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') activate(f);
                      else if (e.key === 'Backspace' || e.key === 'Delete') void remove(f);
                    }}
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
                        ? `打开中${progress === null ? '…' : ` ${Math.floor(progress * 100)}%`}`
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
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>
      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function TreeRow({ node, depth, cwd, files }: { node: TreeNode; depth: number; cwd: string; files: FileBrowser }) {
  const on = node.path === cwd;
  return (
    <>
      <div className={`tree__row${on ? ' tree__row--on' : ''}`} style={{ paddingLeft: 4 + depth * 14 }}>
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
      {node.expanded && node.children?.map((c) => <TreeRow key={c.path} node={c} depth={depth + 1} cwd={cwd} files={files} />)}
    </>
  );
}
