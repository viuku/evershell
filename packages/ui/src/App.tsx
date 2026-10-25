import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import '@xterm/xterm/css/xterm.css';
import './styles/base.css';
import './styles/app.css';
import './styles/sidebar.css';
import './styles/terminal.css';
import './styles/panels.css';
import './styles/commands.css';
import './styles/newtab.css';
import './styles/manager.css';
import './styles/monitor.css';
import { DialogsProvider, useDialogs } from './components/common/Dialogs';
import { TooltipLayer } from './components/common/Tooltip';
import type { MenuItem } from './components/common/Menu';
import { RemoteEditContext } from './components/editor/remote-edit-context';
import { ConnectionManager } from './components/manager/ConnectionManager';
import { InfoTabView } from './components/monitor/InfoTabView';
import { EditConnectionDialog } from './components/manager/EditConnectionDialog';
import { NewTabPage } from './components/newtab/NewTabPage';
import type { BottomTab } from './components/panels/BottomPanels';
import { SessionView } from './components/SessionView';
import { MonitorSidebar } from './components/sidebar/MonitorSidebar';
import { StatusBar } from './components/StatusBar';
import { TabBar } from './components/TabBar';
import { askServerPassword, resolveAuth } from './core/connect';
import { KeyLibrary, migrateServerKeys } from './core/key-library';
import { getServer, hostsStore, touchServerConnected, type ServerRecord } from './core/hosts-store';
import { exportConnections } from './core/importers/export';
import { parentPath } from './core/paths';
import { ManagerLink } from './core/manager-link';
import { localChannelPair, RemoteEdit } from './core/remote-edit';
import { pushRecent } from './core/recents-store';
import { SessionManager, type SessionInfo, type TerminalLook } from './core/session-manager';
import { isAppShortcut, shortcutLabel } from './core/platform';
import { appearanceClass, appearanceMode, sidebarOpen, useEffectiveScheme } from './core/settings';
import { useStore } from './core/store';
import { resolveScheme, tabNeedsEdge, terminalAppearance, terminalBgImage, toXtermTheme } from './core/terminal-appearance';
import type { SshBackend } from './types';

// 编辑器（CodeMirror）按需加载，不拖慢启动
const FloatingEditor = lazy(() => import('./components/editor/FloatingEditor'));

/** 界面现在的底色，新开的独立窗口先铺上它，深色模式下不会先白一下（见 WindowLink.open） */
function contentColor(): string | undefined {
  const app = document.querySelector('.app');
  const value = app ? getComputedStyle(app).getPropertyValue('--content').trim() : '';
  return /^#[0-9a-f]{6}$/i.test(value) ? value : undefined;
}

export interface AppProps {
  backend: SshBackend;
  /** ≡ 菜单末尾追加的项（网页端放“中转设置…”） */
  menuExtras?: MenuItem[];
  /** 系统窗口按钮叠在界面左上角时占的宽度（桌面端 Mac 的红绿灯）；状态栏顶部、状态栏收起后的标签栏都要让开 */
  windowButtonsInset?: number;
}

export function App(props: AppProps) {
  const mode = useStore(appearanceMode);
  // 询问密码等小对话框渲染在 .app 旁边，主题变量和字体要放在它们共同的外层
  return (
    <div className={`app-root ${appearanceClass(mode)}`}>
      <DialogsProvider pickKeyFile={props.backend.pickPrivateKeyFile}>
        <AppInner {...props} />
      </DialogsProvider>
      <TooltipLayer />
    </div>
  );
}

function AppInner({ backend, menuExtras, windowButtonsInset }: AppProps) {
  const mode = useStore(appearanceMode);
  const scheme = useEffectiveScheme();
  const appearance = useStore(terminalAppearance);
  const bgImage = useStore(terminalBgImage);
  const sidebar = useStore(sidebarOpen);
  const dialogs = useDialogs();

  const resolved = useMemo(() => resolveScheme(appearance, scheme), [appearance, scheme]);
  const look = useMemo<TerminalLook>(
    () => ({ theme: toXtermTheme(resolved, !!bgImage), fontSize: appearance.fontSize, isLight: resolved.isLight }),
    [resolved, bgImage, appearance.fontSize],
  );
  const lookRef = useRef(look);
  lookRef.current = look;

  const manager = useMemo(() => new SessionManager(backend, lookRef.current), [backend]);
  const keyLibrary = useMemo(() => KeyLibrary.of(backend), [backend]);
  // 以前跟着服务器存的私钥搬进私钥库（docs/specs/key-library.md），只在主窗口跑
  useEffect(() => void migrateServerKeys(keyLibrary, backend.secrets), [keyLibrary, backend]);
  useEffect(() => manager.applyLook(look), [manager, look]);
  useEffect(() => manager.setHostKeyPrompt((problem) => dialogs.hostKey(problem)), [manager, dialogs]);
  useEffect(() => manager.setPasswordPrompt((target) => askServerPassword(target, backend.secrets, dialogs)), [manager, backend, dialogs]);

  // 远程文件编辑：桌面端开独立的编辑窗口，网页端浮在主窗口里（两头用一对内存里的消息口）
  const editorPorts = useMemo(() => (backend.editorWindow ? null : localChannelPair()), [backend]);
  const [floatingEditor, setFloatingEditor] = useState(false);
  const remoteEdit = useMemo(
    () =>
      new RemoteEdit(
        backend.editorWindow ?? editorPorts![0],
        (sid) => {
          const c = manager.connected(sid);
          return c ? { session: c.session, host: `${c.info.user}@${c.info.name}` } : null;
        },
        () => (backend.editorWindow ? backend.editorWindow.open(contentColor()) : setFloatingEditor(true)),
        (sid, path) => manager.getFiles(sid)?.refreshIfShowing(parentPath(path) ?? '/'),
      ),
    [backend, manager, editorPorts],
  );
  useEffect(() => remoteEdit.start(), [remoteEdit]);
  // 启动时默认打开一个新标签页
  useEffect(() => {
    if (manager.getSnapshot().tabs.length === 0) manager.openNewTab();
  }, [manager]);

  const { tabs, activeId, groups } = useSyncExternalStore(manager.subscribe, manager.getSnapshot);
  const active = tabs.find((t) => t.id === activeId) ?? null;
  // 信息页也带着所属的会话：状态栏、底部状态条照常显示这台服务器
  const session = active?.session ?? null;
  const monitor = manager.getMonitor(session?.id ?? null);

  const [managerOpen, setManagerOpen] = useState(false);
  const [managerImport, setManagerImport] = useState(false);
  const [lookOpen, setLookOpen] = useState(false);
  const [bottomTab, setBottomTab] = useState<BottomTab>('files');
  /** 搜索框开在哪个标签上；seq 每按一次快捷键加一，用来重新选中输入框 */
  const [find, setFind] = useState<{ id: string; seq: number } | null>(null);
  const [editing, setEditing] = useState<ServerRecord | null>(null);
  const hosts = useStore(hostsStore);
  const savedServer = getServer(hosts, session?.serverId);
  const editableServer = savedServer && !savedServer.deletedAt ? savedServer : null;

  /** 连接一台服务器：凑齐认证信息，开一个会话标签（当前是新标签页则原地替换） */
  const connectServer = useCallback(
    async (server: ServerRecord) => {
      const auth = await resolveAuth(server, backend.secrets, dialogs, keyLibrary);
      if (!auth) return;
      const snap = manager.getSnapshot();
      const current = snap.tabs.find((t) => t.id === snap.activeId);
      manager.openSession(
        { serverId: server.id, name: server.name, host: server.host, port: server.port, user: server.user, auth },
        current && current.session === null ? current.id : null,
      );
      pushRecent(server.id);
      touchServerConnected(server.id);
    },
    [backend, manager, dialogs, keyLibrary],
  );

  // 桌面端的连接管理器是独立窗口：它让连哪台，就在这里连；网页端照旧是弹窗
  const managerLink = useMemo(
    () =>
      backend.managerWindow
        ? new ManagerLink(backend.managerWindow, async (id) => {
            let server = getServer(hostsStore.get(), id);
            // 刚在管理器里新建的，同步通知可能还没到，直接从硬盘上读一遍
            if (!server) {
              hostsStore.reload();
              server = getServer(hostsStore.get(), id);
            }
            if (server && !server.deletedAt) await connectServer(server);
          })
        : null,
    [backend, connectServer],
  );
  useEffect(() => managerLink?.start(), [managerLink]);

  // 点主窗口的关闭按钮先问一句（照 FinalShell）；连着会话的话说清会断开
  const askingClose = useRef(false);
  useEffect(
    () =>
      backend.onCloseRequested?.(async () => {
        if (askingClose.current) return false;
        askingClose.current = true;
        try {
          const n = manager.connectedCount();
          return await dialogs.confirm({
            title: '关闭窗口',
            message: n > 0 ? `确定要关闭窗口吗？当前连接的 ${n} 个会话将断开。` : '确定要关闭窗口吗？',
            okText: '关闭',
          });
        } finally {
          askingClose.current = false;
        }
      }),
    [backend, manager, dialogs],
  );
  // 主窗口画好后，在后台把连接管理器窗口先建好藏着，点开时直接亮出来（新建窗口要等它加载）
  useEffect(() => {
    const preload = backend.managerWindow?.preload;
    if (!preload) return;
    const timer = setTimeout(() => preload(contentColor()), 1500);
    return () => clearTimeout(timer);
  }, [backend]);
  /** 打开连接管理器；importing：直接进导入 */
  const openManager = useCallback(
    (importing = false) => {
      if (managerLink) {
        void managerLink.open(importing, contentColor());
        return;
      }
      setManagerImport(importing);
      setManagerOpen(true);
    },
    [managerLink],
  );

  /** 重连：按连接管理器里的最新设置连（用齿轮改过的这时生效）；记录已经删了就照上次的连 */
  const reconnect = useCallback(
    async (s: SessionInfo) => {
      const server = getServer(hostsStore.get(), s.serverId);
      if (!server || server.deletedAt) return manager.reconnect(s.id);
      const auth = await resolveAuth(server, backend.secrets, dialogs, keyLibrary);
      if (!auth) return;
      manager.reconnect(s.id, { serverId: server.id, name: server.name, host: server.host, port: server.port, user: server.user, auth });
    },
    [backend, manager, dialogs, keyLibrary],
  );

  const openFind = useCallback((id: string) => setFind((f) => ({ id, seq: (f?.seq ?? 0) + 1 })), []);

  const closeTab = useCallback(
    async (id: string) => {
      const tab = manager.getSnapshot().tabs.find((t) => t.id === id);
      if (tab && !tab.info && tab.session?.status === 'connected') {
        const ok = await dialogs.confirm({ title: '关闭会话', message: `${tab.session.name} 仍在连接中，确定要关闭吗？`, okText: '关闭' });
        if (!ok) return;
      }
      manager.closeTab(id);
    },
    [manager, dialogs],
  );

  // 快捷键：连接管理器、新标签页、关闭标签，按键见 core/platform.ts（浏览器里后两个可能被浏览器自己接管）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 浮动编辑器里的 ⌘W、⌘F 归编辑器
      if ((e.target as HTMLElement | null)?.closest?.('.ed-float')) return;
      if (isAppShortcut(e, 'o')) {
        e.preventDefault();
        openManager();
      } else if (isAppShortcut(e, 't')) {
        e.preventDefault();
        manager.openNewTab();
      } else if (isAppShortcut(e, 'w')) {
        const id = manager.getSnapshot().activeId;
        if (id) {
          e.preventDefault();
          void closeTab(id);
        }
      } else if (isAppShortcut(e, 'f')) {
        const { tabs, activeId } = manager.getSnapshot();
        const tab = tabs.find((t) => t.id === activeId);
        if (activeId && tab?.session && !tab.info) {
          e.preventDefault();
          openFind(activeId);
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [manager, closeTab, openFind, openManager]);

  const menuItems: MenuItem[] = [
    { label: '连接管理器…', hint: shortcutLabel('o'), onSelect: () => openManager() },
    { label: '新标签页', hint: shortcutLabel('t'), onSelect: () => manager.openNewTab() },
    { type: 'separator' },
    {
      label: '导入连接…',
      onSelect: () => openManager(true),
    },
    {
      label: '导出连接…',
      onSelect: () => {
        void exportConnections(hostsStore.get(), null, (name, bytes) => backend.saveFile(name, bytes))
          .then((where) =>
            dialogs.alert('导出连接', where ? `已导出至 ${where}（不含密码和私钥）` : '暂无可导出的连接'),
          )
          .catch((e: unknown) => dialogs.alert('导出失败', e instanceof Error ? e.message : String(e)));
      },
    },
    { type: 'separator' },
    { type: 'label', label: '外观' },
    { label: '跟随系统', checked: mode === 'system', onSelect: () => appearanceMode.set('system') },
    { label: '浅色', checked: mode === 'light', onSelect: () => appearanceMode.set('light') },
    { label: '深色', checked: mode === 'dark', onSelect: () => appearanceMode.set('dark') },
    ...(menuExtras && menuExtras.length > 0 ? [{ type: 'separator' } as MenuItem, ...menuExtras] : []),
  ];

  // 终端配色暴露成变量：终端区底色（也是选中会话标签的底色）、前景色
  const style = {
    '--t-bg': resolved.bg,
    '--t-fg': resolved.fg,
    // 选中标签的背景跟终端底色走，文字要和它有对比，而不是和界面深浅色走
    '--tab-on-fg': resolved.isLight ? '#1D1D1F' : '#ECECEE',
    '--tab-on-dim': resolved.isLight ? '#5C5C63' : '#A3A3AA',
    '--tab-on-edge': tabNeedsEdge(resolved.bg, scheme) ? 'var(--strip-sep)' : undefined,
  } as CSSProperties;

  return (
    <RemoteEditContext.Provider value={remoteEdit}>
      <div className={`app ${appearanceClass(mode)}`} style={style}>
        {sidebar && (
          <MonitorSidebar
            session={session}
            monitor={monitor}
            onToggleSidebar={() => sidebarOpen.set(false)}
            onOpenInfo={(kind) => session && manager.openInfo(session.id, kind)}
            leadingInset={windowButtonsInset}
          />
        )}
        <div className="app__main">
          <TabBar
            tabs={tabs}
            activeId={activeId}
            groups={groups}
            onSelect={(id) => manager.activate(id)}
            onClose={(id) => void closeTab(id)}
            onToggleGroup={(id) => manager.toggleGroup(id)}
            onNewTab={() => manager.openNewTab()}
            onOpenManager={() => openManager()}
            onShowSidebar={sidebar ? undefined : () => sidebarOpen.set(true)}
            menuItems={menuItems}
            leadingInset={sidebar ? undefined : windowButtonsInset}
          />
          {active?.info && session ? (
            <InfoTabView
              key={active.id}
              kind={active.info}
              manager={manager}
              session={session}
              monitor={monitor}
              onReconnect={() => void reconnect(session)}
            />
          ) : session ? (
            <SessionView
              manager={manager}
              session={session}
              backend={backend}
              scheme={scheme}
              lookOpen={lookOpen}
              onToggleLook={() => setLookOpen((o) => !o)}
              bottomTab={bottomTab}
              onBottomTab={setBottomTab}
              findSeq={find?.id === session.id ? find.seq : null}
              onToggleFind={() => (find?.id === session.id ? setFind(null) : openFind(session.id))}
              onReconnect={() => void reconnect(session)}
              onEditConnection={editableServer ? () => setEditing(editableServer) : null}
            />
          ) : (
            <NewTabPage onConnect={(s) => void connectServer(s)} onOpenManager={() => openManager()} />
          )}
          <StatusBar session={session} monitor={monitor} />
        </div>
        {managerOpen && (
          <ConnectionManager
            backend={backend}
            openImport={managerImport}
            onClose={() => {
              setManagerOpen(false);
              setManagerImport(false);
            }}
            onConnect={connectServer}
          />
        )}
        {editing && (
          <EditConnectionDialog backend={backend} target={{ mode: 'edit', server: editing }} onClose={() => setEditing(null)} onSaved={() => {}} />
        )}
        {floatingEditor && editorPorts && (
          <Suspense fallback={null}>
            <FloatingEditor port={editorPorts[1]} onClosed={() => setFloatingEditor(false)} />
          </Suspense>
        )}
      </div>
    </RemoteEditContext.Provider>
  );
}
