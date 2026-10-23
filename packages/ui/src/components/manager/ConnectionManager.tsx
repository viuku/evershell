import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  addFolder,
  getServer,
  hostsStore,
  renameFolder,
  setFolderDeleted,
  setServerDeleted,
  type FolderRecord,
  type ServerRecord,
} from '../../core/hosts-store';
import { exportConnections } from '../../core/importers/export';
import { dragRegion, isDeleteSelectedKey, isSelectAllKey, isToggleSelect } from '../../core/platform';
import {
  clickSelect,
  contextSelect,
  emptySelection,
  moveSelect,
  pruneSelection,
  selectAll,
  selectOnly,
  type Selection,
} from '../../core/selection';
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
  /** 连好（或放弃）再返回，选了好几台时一台一台连 */
  onConnect(server: ServerRecord): void | Promise<void>;
  /** 打开时直接进入导入流程（≡ 菜单的「导入连接…」） */
  openImport?: boolean;
  /** 已经开着时又要导入：每要一次加一（独立窗口用） */
  importSeq?: number;
  /** 'window'：桌面端的独立窗口，铺满整个窗口；默认是主窗口里的弹窗 */
  frame?: 'modal' | 'window';
}

type Row =
  | { kind: 'folder'; folder: FolderRecord; depth: number; open: boolean; count: number }
  | { kind: 'server'; server: ServerRecord; depth: number };

const idOf = (r: Row) => (r.kind === 'folder' ? r.folder.id : r.server.id);
const isDeleted = (r: Row) => !!(r.kind === 'folder' ? r.folder.deletedAt : r.server.deletedAt);

/** 连接管理器：Finder 式的文件夹 + 服务器树，多选的按键也照访达（core/selection.ts） */
export function ConnectionManager({ backend, onClose, onConnect, openImport = false, importSeq = 0, frame = 'modal' }: Props) {
  const data = useStore(hostsStore);
  const open = useStore(openFolders);
  const closeAfter = useStore(closeManagerAfterConnect);
  const dialogs = useDialogs();
  const [sel, setSel] = useState<Selection>(emptySelection);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [showDeleted, setShowDeleted] = useState(false);
  const [edit, setEdit] = useState<EditTarget | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [importOpen, setImportOpen] = useState(openImport);
  useEffect(() => {
    if (importSeq > 0) setImportOpen(true);
  }, [importSeq]);

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

  // 看得见的行的顺序，Shift 选段、方向键按它走；折叠、搜索后看不见的项不再算选中
  const order = useMemo(() => rows.map(idOf), [rows]);
  useEffect(() => setSel((s) => pruneSelection(s, order)), [order]);

  const selectedRows = rows.filter((r) => sel.ids.has(idOf(r)));
  const single = selectedRows.length === 1 ? selectedRows[0] : undefined;
  const selServer = single?.kind === 'server' ? single.server : null;
  const selFolder = single?.kind === 'folder' ? single.folder : null;
  /** 最近点的那一项：新建放到它所在的文件夹，←→ 展开折叠它 */
  const focusRow = sel.focus !== null && sel.ids.has(sel.focus) ? rows.find((r) => idOf(r) === sel.focus) : undefined;
  const focusFolder = focusRow?.kind === 'folder' ? focusRow.folder : null;
  const selectedFolderId = focusRow ? (focusRow.kind === 'folder' ? focusRow.folder.id : focusRow.server.parentId) : null;
  const connectable = selectedRows.flatMap((r) => (r.kind === 'server' && !r.server.deletedAt ? [r.server] : []));
  const allDeleted = selectedRows.length > 0 && selectedRows.every(isDeleted);
  const visibleCount = data.servers.filter((s) => !s.deletedAt).length;

  const toggleFolder = (id: string) => openFolders.set((o) => ({ ...o, [id]: !o[id] }));
  /** 连接一台或几台；几台时按列表顺序一台一台连，要密码的依次弹框 */
  const connect = (servers: ServerRecord[]) => {
    const list = servers.filter((s) => !s.deletedAt);
    if (list.length === 0) return;
    void (async () => {
      for (const s of list) await onConnect(s);
    })();
    if (closeAfter) onClose();
  };

  /** 删除或恢复几项，已经是那个状态的跳过 */
  const setRowsDeleted = (targets: Row[], deleted: boolean) => {
    for (const r of targets) {
      if (isDeleted(r) === deleted) continue;
      if (r.kind === 'server') setServerDeleted(r.server.id, deleted);
      else setFolderDeleted(r.folder.id, deleted);
    }
  };

  const newFolder = async () => {
    const name = await dialogs.prompt({ title: '新建文件夹', label: '名称', initial: '新建文件夹', validate: (v) => (v.trim() ? null : '名称不能为空') });
    if (!name) return;
    const f = addFolder(name.trim(), selectedFolderId);
    if (selectedFolderId) openFolders.set((o) => ({ ...o, [selectedFolderId]: true }));
    setSel(selectOnly(f.id));
  };

  const rename = async (f: FolderRecord) => {
    const name = await dialogs.prompt({ title: '重命名文件夹', label: '名称', initial: f.name, okText: '重命名', validate: (v) => (v.trim() ? null : '名称不能为空') });
    if (name && name.trim() !== f.name) renameFolder(f.id, name.trim());
  };

  const editSelected = () => {
    if (selServer) setEdit({ mode: 'edit', server: selServer });
    else if (selFolder) void rename(selFolder);
  };

  /** 选中的全是已删除的就恢复，否则删除 */
  const toggleDeleted = () => setRowsDeleted(selectedRows, !allDeleted);

  /** 选中了文件夹或连接就导出所选，否则导出全部 */
  const exportNow = async () => {
    const ids = selectedRows.length > 0 ? selectedRows.map(idOf) : null;
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
        { label: '连接', disabled: !!s.deletedAt, onSelect: () => connect([s]) },
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

  /** 在选中的几项上右键：对整组操作 */
  const groupMenu = (): MenuItem[] => {
    const n = selectedRows.length;
    return [
      {
        label: connectable.length > 0 ? `连接 ${connectable.length} 台服务器` : '连接',
        disabled: connectable.length === 0,
        onSelect: () => connect(connectable),
      },
      { label: `导出 ${n} 项…`, onSelect: () => void exportNow() },
      { type: 'separator' },
      allDeleted
        ? { label: `恢复 ${n} 项`, onSelect: () => setRowsDeleted(selectedRows, false) }
        : { label: `删除 ${n} 项`, danger: true, onSelect: () => setRowsDeleted(selectedRows, true) },
    ];
  };

  // 方向键在树里移动（按住 Shift 连选），左右展开折叠，回车连接，全选、删除同访达
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => moveSelect(s, order, e.key === 'ArrowDown' ? 1 : -1, e.shiftKey));
    } else if (e.key === 'ArrowRight' && focusFolder && !open[focusFolder.id]) {
      toggleFolder(focusFolder.id);
    } else if (e.key === 'ArrowLeft' && focusFolder && open[focusFolder.id]) {
      toggleFolder(focusFolder.id);
    } else if (e.key === 'Enter') {
      connect(connectable);
    } else if (isSelectAllKey(e)) {
      e.preventDefault();
      setSel((s) => selectAll(s, order));
    } else if (isDeleteSelectedKey(e)) {
      e.preventDefault();
      setRowsDeleted(selectedRows, true);
    }
  };

  const footHint = selServer
    ? `已选中 ${selServer.name} · 双击连接`
    : selFolder
      ? `已选中文件夹 ${selFolder.name}`
      : selectedRows.length > 1
        ? `已选中 ${selectedRows.length} 项${connectable.length > 0 ? ` · 点「连接」打开其中 ${connectable.length} 台服务器` : ''}`
        : `共 ${visibleCount} 台服务器 · 双击连接`;
  const editTip = selServer || selFolder ? '编辑' : selectedRows.length > 1 ? '编辑（一次只能编辑一项）' : '编辑（先选中一个连接或文件夹）';
  const deleteTip =
    selectedRows.length === 0
      ? '删除（先选中一个连接或文件夹）'
      : allDeleted
        ? selectedRows.length > 1 ? `恢复所选 ${selectedRows.length} 项` : '恢复'
        : `${selectedRows.length > 1 ? `删除所选 ${selectedRows.length} 项` : '删除'}（可在「显示已删除」里恢复）`;

  return (
    <Frame window={frame === 'window'} onClose={onClose}>
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
          data-tip={editTip}
          aria-label="编辑"
          disabled={!selServer && !selFolder}
          onClick={editSelected}
        >
          <EditIcon size={16} />
        </button>
        <button
          type="button"
          className="tb"
          data-tip={deleteTip}
          aria-label={allDeleted ? '恢复' : '删除'}
          disabled={selectedRows.length === 0}
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
          data-tip={selectedRows.length > 0 ? '导出所选（文件夹或连接）' : '导出全部连接'}
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
        aria-multiselectable="true"
        tabIndex={0}
        onKeyDown={onKey}
        onClick={(e) => {
          if (e.target === e.currentTarget) setSel(emptySelection);
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
              const id = idOf(row);
              const on = sel.ids.has(id);
              const deleted = isDeleted(row);
              return (
                // 行里还要放齿轮按钮，按钮不能套按钮，所以行用 div；键盘操作由外层列表接管
                <div
                  key={id}
                  role="treeitem"
                  className={`grid-row mgr__cols mgr__row${on ? ' grid-row--on' : ''}${deleted ? ' mgr__row--deleted' : ''}`}
                  aria-expanded={row.kind === 'folder' ? row.open : undefined}
                  aria-selected={on}
                  onClick={(e) => {
                    const mods = { toggle: isToggleSelect(e), range: e.shiftKey };
                    setSel((s) => clickSelect(s, order, id, mods));
                    // 按着修饰键只管选，不展开折叠
                    if (row.kind === 'folder' && !mods.toggle && !mods.range) toggleFolder(row.folder.id);
                  }}
                  onDoubleClick={(e) => {
                    if (row.kind === 'server' && !isToggleSelect(e) && !e.shiftKey) connect([row.server]);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    const group = on && selectedRows.length > 1;
                    setSel((s) => contextSelect(s, id));
                    setMenu({ x: e.clientX, y: e.clientY, items: group ? groupMenu() : rowMenu(row) });
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
                          setSel(selectOnly(id));
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
                  {/* 多行备注在列表里挤成一行，悬停看全文 */}
                  <span className="muted ellipsis" title={row.kind === 'server' && row.server.note ? row.server.note : undefined}>
                    {row.kind === 'server' ? row.server.note : ''}
                  </span>
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
        <button type="button" className="btn btn-primary" disabled={connectable.length === 0} onClick={() => connect(connectable)}>
          连接
        </button>
      </div>

      {edit && (
        <EditConnectionDialog
          backend={backend}
          target={edit}
          onClose={() => setEdit(null)}
          onSaved={(id) => {
            setSel(selectOnly(id));
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
    </Frame>
  );
}

/** 弹窗，或者独立窗口：顶上一条和主窗口标签栏一样高的标题栏，按住能拖（Mac 的红绿灯叠在左边） */
function Frame({ window: win, onClose, children }: { window: boolean; onClose(): void; children: ReactNode }) {
  if (!win) {
    return (
      <Modal title="连接管理器" onClose={onClose} width={920} height={580} className="mgr">
        {children}
      </Modal>
    );
  }
  return (
    <div className="mgr mgr-window">
      <header className="mgr-window__head" {...dragRegion}>
        <h1 className="mgr-window__title" {...dragRegion}>
          连接管理器
        </h1>
      </header>
      {children}
    </div>
  );
}
