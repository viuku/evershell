import { useMemo, useState, type KeyboardEvent } from 'react';
import {
  addFolder,
  getFolder,
  getServer,
  hostsStore,
  renameFolder,
  setFolderDeleted,
  setServerDeleted,
  type FolderRecord,
  type ServerRecord,
} from '../../core/hosts-store';
import { exportConnections } from '../../core/importers/export';
import { closeManagerAfterConnect } from '../../core/settings';
import { PersistentStore } from '../../core/storage';
import { useStore } from '../../core/store';
import type { SshBackend } from '../../types';
import { useDialogs } from '../common/Dialogs';
import {
  CollapseAllIcon,
  DisclosureIcon,
  EditIcon,
  ExpandAllIcon,
  ExportIcon,
  FolderFillIcon,
  GearIcon,
  ImportIcon,
  NewConnectionIcon,
  NewFolderIcon,
  ServerIcon,
  SortIcon,
  TrashIcon,
} from '../common/Icons';
import { ContextMenu, type ContextMenuState, type MenuItem } from '../common/Menu';
import { Modal } from '../common/Modal';
import { EditConnectionDialog, type EditTarget } from './EditConnectionDialog';
import { ImportDialog } from './ImportDialog';

type Kind = 'all' | 'ssh' | 'rdp';

/** 展开的文件夹 id，记住上次的状态 */
const openFolders = new PersistentStore<Record<string, boolean>>('evershell.manager.open', {}, (raw, fb) =>
  raw && typeof raw === 'object' ? (raw as Record<string, boolean>) : fb,
);

interface Props {
  backend: SshBackend;
  onClose(): void;
  onConnect(server: ServerRecord): void;
  /** 打开时直接进入导入流程（≡ 菜单的「导入连接…」） */
  openImport?: boolean;
}

type Row =
  | { kind: 'folder'; folder: FolderRecord; depth: number; open: boolean; count: number }
  | { kind: 'server'; server: ServerRecord; depth: number };

/** 连接管理器：Finder 式的文件夹 + 服务器树 */
export function ConnectionManager({ backend, onClose, onConnect, openImport = false }: Props) {
  const data = useStore(hostsStore);
  const open = useStore(openFolders);
  const closeAfter = useStore(closeManagerAfterConnect);
  const dialogs = useDialogs();
  const [sel, setSel] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [showDeleted, setShowDeleted] = useState(false);
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [importOpen, setImportOpen] = useState(openImport);

  const query = q.trim().toLowerCase();
  const filtering = query !== '' || kind !== 'all';

  const rows = useMemo(() => {
    const matches = (s: ServerRecord) => {
      if (s.deletedAt && !showDeleted) return false;
      if (kind !== 'all' && s.proto !== kind) return false;
      if (!query) return true;
      return `${s.name} ${s.host} ${s.note} ${s.user}`.toLowerCase().includes(query);
    };
    const folderVisible = (f: FolderRecord) => !f.deletedAt || showDeleted;
    const countIn = (fid: string): number => {
      let c = data.servers.filter((s) => s.parentId === fid && matches(s)).length;
      for (const f of data.folders) if (f.parentId === fid && folderVisible(f)) c += countIn(f.id);
      return c;
    };
    const out: Row[] = [];
    const walk = (parentId: string | null, depth: number) => {
      const folders = data.folders
        .filter((f) => f.parentId === parentId && folderVisible(f))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
      for (const f of folders) {
        const count = countIn(f.id);
        if (filtering && count === 0) continue;
        const isOpen = filtering ? true : !!open[f.id];
        out.push({ kind: 'folder', folder: f, depth, open: isOpen, count });
        if (isOpen) walk(f.id, depth + 1);
      }
      const servers = data.servers
        .filter((s) => s.parentId === parentId && matches(s))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
      for (const s of servers) out.push({ kind: 'server', server: s, depth });
    };
    walk(null, 0);
    return out;
  }, [data, open, query, kind, showDeleted, filtering]);

  const selServer = getServer(data, sel);
  const selFolder = getFolder(data, sel);
  const selectedFolderId = selFolder ? selFolder.id : (selServer?.parentId ?? null);
  const visibleCount = data.servers.filter((s) => !s.deletedAt).length;

  const toggleFolder = (id: string) => openFolders.set((o) => ({ ...o, [id]: !o[id] }));
  const connect = (s: ServerRecord) => {
    if (s.deletedAt) return;
    onConnect(s);
    if (closeAfter) onClose();
  };

  const newFolder = async () => {
    const name = await dialogs.prompt({ title: '新建文件夹', label: '名称', initial: '新建文件夹', validate: (v) => (v.trim() ? null : '名称不能为空') });
    if (!name) return;
    const f = addFolder(name.trim(), selectedFolderId);
    if (selectedFolderId) openFolders.set((o) => ({ ...o, [selectedFolderId]: true }));
    setSel(f.id);
  };

  const rename = async (f: FolderRecord) => {
    const name = await dialogs.prompt({ title: '重命名文件夹', label: '名称', initial: f.name, okText: '重命名', validate: (v) => (v.trim() ? null : '名称不能为空') });
    if (name && name.trim() !== f.name) renameFolder(f.id, name.trim());
  };

  const editSelected = () => {
    if (selServer) setEdit({ mode: 'edit', server: selServer });
    else if (selFolder) void rename(selFolder);
  };

  const toggleDeleted = () => {
    if (selServer) setServerDeleted(selServer.id, !selServer.deletedAt);
    else if (selFolder) setFolderDeleted(selFolder.id, !selFolder.deletedAt);
  };

  const selDeleted = !!(selServer?.deletedAt || selFolder?.deletedAt);

  /** 选中了文件夹或连接就导出所选，否则导出全部 */
  const exportNow = async () => {
    const ids = sel && (selServer || selFolder) ? [sel] : null;
    try {
      const where = await exportConnections(data, ids, (name, bytes) => backend.saveFile(name, bytes));
      if (!where) await dialogs.alert('导出连接', ids ? '所选内容里没有可导出的连接' : '还没有可导出的连接');
      else await dialogs.alert('导出连接', `已导出：${where}（不含密码和私钥）`);
    } catch (e) {
      await dialogs.alert('导出失败', e instanceof Error ? e.message : String(e));
    }
  };

  const rowMenu = (row: Row): MenuItem[] => {
    if (row.kind === 'server') {
      const s = row.server;
      return [
        { label: '连接', disabled: !!s.deletedAt, onSelect: () => connect(s) },
        { label: '编辑…', onSelect: () => setEdit({ mode: 'edit', server: s }) },
        { type: 'separator' },
        s.deletedAt
          ? { label: '恢复', onSelect: () => setServerDeleted(s.id, false) }
          : { label: '删除', danger: true, onSelect: () => setServerDeleted(s.id, true) },
      ];
    }
    const f = row.folder;
    return [
      { label: '在此新建连接…', onSelect: () => setEdit({ mode: 'new', parentId: f.id }) },
      { label: '重命名…', onSelect: () => void rename(f) },
      { type: 'separator' },
      f.deletedAt
        ? { label: '恢复', onSelect: () => setFolderDeleted(f.id, false) }
        : { label: '删除', danger: true, onSelect: () => setFolderDeleted(f.id, true) },
    ];
  };

  // 方向键在树里移动，左右展开折叠，回车连接
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
    const idx = rows.findIndex((r) => (r.kind === 'folder' ? r.folder.id : r.server.id) === sel);
    const idOf = (r: Row) => (r.kind === 'folder' ? r.folder.id : r.server.id);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = rows[Math.min(rows.length - 1, idx + 1)];
      if (next) setSel(idOf(next));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const prev = rows[Math.max(0, idx - 1)];
      if (prev) setSel(idOf(prev));
    } else if (e.key === 'ArrowRight' && selFolder && !open[selFolder.id]) {
      toggleFolder(selFolder.id);
    } else if (e.key === 'ArrowLeft' && selFolder && open[selFolder.id]) {
      toggleFolder(selFolder.id);
    } else if (e.key === 'Enter' && selServer) {
      connect(selServer);
    }
  };

  const footHint = selServer
    ? `已选中 ${selServer.name} · 双击连接`
    : selFolder
      ? `已选中文件夹 ${selFolder.name}`
      : `共 ${visibleCount} 台服务器 · 双击连接`;

  return (
    <Modal title="连接管理器" onClose={onClose} width={920} height={580} className="mgr">
      <div className="mgr__toolbar">
        <button type="button" className="tb" data-tip="新建连接" aria-label="新建连接" onClick={() => setEdit({ mode: 'new', parentId: selectedFolderId })}>
          <NewConnectionIcon size={18} />
        </button>
        <button type="button" className="tb" data-tip="新建文件夹" aria-label="新建文件夹" onClick={() => void newFolder()}>
          <NewFolderIcon size={18} />
        </button>
        <span className="mgr__sep" />
        <button
          type="button"
          className="tb"
          data-tip={selServer || selFolder ? '编辑' : '编辑（先选中一个连接或文件夹）'}
          aria-label="编辑"
          disabled={!selServer && !selFolder}
          onClick={editSelected}
        >
          <EditIcon size={16} />
        </button>
        <button
          type="button"
          className="tb"
          data-tip={!selServer && !selFolder ? '删除（先选中一个连接或文件夹）' : selDeleted ? '恢复' : '删除（可在「显示已删除」里恢复）'}
          aria-label={selDeleted ? '恢复' : '删除'}
          disabled={!selServer && !selFolder}
          onClick={toggleDeleted}
        >
          <TrashIcon size={16} />
        </button>
        <span className="mgr__sep" />
        <button type="button" className="tb" data-tip="全部折叠" aria-label="全部折叠" onClick={() => openFolders.set({})}>
          <CollapseAllIcon size={16} />
        </button>
        <button
          type="button"
          className="tb"
          data-tip="全部展开"
          aria-label="全部展开"
          onClick={() => openFolders.set(Object.fromEntries(data.folders.map((f) => [f.id, true])))}
        >
          <ExpandAllIcon size={16} />
        </button>
        <span className="mgr__sep" />
        <button type="button" className="tb" data-tip="导入连接…" aria-label="导入连接" onClick={() => setImportOpen(true)}>
          <ImportIcon size={16} />
        </button>
        <button
          type="button"
          className="tb"
          data-tip={selServer || selFolder ? '导出所选（文件夹或连接）' : '导出全部连接'}
          aria-label="导出连接"
          onClick={() => void exportNow()}
        >
          <ExportIcon size={16} />
        </button>
        <label className="check mgr__deleted">
          <input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} />
          显示已删除
        </label>
        <div className="mgr__filters">
          <label htmlFor="mgr-search" className="sr-only">
            搜索
          </label>
          <input
            id="mgr-search"
            className="field mgr__search"
            type="search"
            value={q}
            placeholder="搜索名称、主机、备注"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQ(e.target.value)}
          />
          <label htmlFor="mgr-kind" className="sr-only">
            类型
          </label>
          <select id="mgr-kind" className="field mgr__kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <option value="all">全部</option>
            <option value="ssh">SSH</option>
            <option value="rdp">远程桌面</option>
          </select>
        </div>
      </div>

      <div
        className="scroll mgr__list"
        role="tree"
        aria-label="连接"
        tabIndex={0}
        onKeyDown={onKey}
        onClick={(e) => {
          if (e.target === e.currentTarget) setSel(null);
        }}
      >
        <div className="mgr__inner">
          <div className="grid-head grid-head--sticky mgr__cols">
            <span className="mgr__sortCol">
              名称 <SortIcon />
            </span>
            <span>主机</span>
            <span>端口</span>
            <span>用户名</span>
            <span>备注</span>
          </div>
          {rows.length === 0 ? (
            <div className="empty">{data.servers.length === 0 && !filtering ? '还没有连接。点左上角「新建连接」添加一台服务器。' : '没有匹配的连接'}</div>
          ) : (
            rows.map((row) => {
              const id = row.kind === 'folder' ? row.folder.id : row.server.id;
              const on = sel === id;
              const deleted = row.kind === 'folder' ? !!row.folder.deletedAt : !!row.server.deletedAt;
              return (
                // 行里还要放齿轮按钮，按钮不能套按钮，所以行用 div；键盘操作由外层列表接管
                <div
                  key={id}
                  role="treeitem"
                  className={`grid-row mgr__cols mgr__row${on ? ' grid-row--on' : ''}${deleted ? ' mgr__row--deleted' : ''}`}
                  aria-expanded={row.kind === 'folder' ? row.open : undefined}
                  aria-selected={on}
                  onClick={() => {
                    setSel(id);
                    if (row.kind === 'folder') toggleFolder(row.folder.id);
                  }}
                  onDoubleClick={() => {
                    if (row.kind === 'server') connect(row.server);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setSel(id);
                    setMenu({ x: e.clientX, y: e.clientY, items: rowMenu(row) });
                  }}
                >
                  <span className="mgr__name" style={{ paddingLeft: row.depth * 18 }}>
                    <span className="mgr__disclosure">{row.kind === 'folder' && <DisclosureIcon open={row.open} />}</span>
                    {/* 选中时图标保持原色，不跟着变白 */}
                    {row.kind === 'folder' ? <FolderFillIcon size={16} /> : <ServerIcon size={16} fill="var(--server)" />}
                    <span className={`ellipsis${deleted ? ' mgr__strike' : ''}`}>
                      {row.kind === 'folder' ? row.folder.name : row.server.name}
                      {deleted && '（已删除）'}
                    </span>
                    {row.kind === 'folder' && <span className="muted mgr__count">{row.count} 台</span>}
                    {row.kind === 'server' && (
                      <button
                        type="button"
                        className="mgr__gear"
                        data-tip="编辑连接"
                        aria-label={`编辑 ${row.server.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setSel(id);
                          setEdit({ mode: 'edit', server: row.server });
                        }}
                        onDoubleClick={(e) => e.stopPropagation()}
                      >
                        <GearIcon size={14} />
                      </button>
                    )}
                  </span>
                  <span className="mono mgr__mono ellipsis">{row.kind === 'server' ? row.server.host : ''}</span>
                  <span className="mono mgr__mono">{row.kind === 'server' ? row.server.port : ''}</span>
                  <span className="ellipsis">{row.kind === 'server' ? row.server.user : ''}</span>
                  <span className="muted ellipsis">{row.kind === 'server' ? row.server.note : ''}</span>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="mgr__foot">
        <label className="check">
          <input type="checkbox" checked={closeAfter} onChange={(e) => closeManagerAfterConnect.set(e.target.checked)} />
          连接后关闭窗口
        </label>
        <span className="muted mgr__hint">{footHint}</span>
        <button type="button" className="btn mgr__edit" disabled={!selServer} onClick={() => selServer && setEdit({ mode: 'edit', server: selServer })}>
          编辑…
        </button>
        <button type="button" className="btn btn-primary" disabled={!selServer || !!selServer.deletedAt} onClick={() => selServer && connect(selServer)}>
          连接
        </button>
      </div>

      {edit && (
        <EditConnectionDialog
          backend={backend}
          target={edit}
          onClose={() => setEdit(null)}
          onSaved={(id) => {
            setSel(id);
            const s = getServer(hostsStore.get(), id);
            if (s?.parentId) openFolders.set((o) => ({ ...o, [s.parentId!]: true }));
          }}
        />
      )}
      {importOpen && (
        <ImportDialog
          backend={backend}
          onClose={() => setImportOpen(false)}
          onImported={(folderIds) => openFolders.set((o) => ({ ...o, ...Object.fromEntries(folderIds.map((id) => [id, true])) }))}
        />
      )}
      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </Modal>
  );
}
