import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import '@xterm/xterm/css/xterm.css';
import './styles/base.css';
import './styles/app.css';
import './styles/sidebar.css';
import './styles/terminal.css';
import './styles/panels.css';
import './styles/newtab.css';
import './styles/manager.css';
import { DialogsProvider, useDialogs } from './components/common/Dialogs';
import type { MenuItem } from './components/common/Menu';
import { ConnectionManager } from './components/manager/ConnectionManager';
import { NewTabPage } from './components/newtab/NewTabPage';
import type { BottomTab } from './components/panels/BottomPanels';
import { SessionView } from './components/SessionView';
import { MonitorSidebar } from './components/sidebar/MonitorSidebar';
import { StatusBar } from './components/StatusBar';
import { TabBar } from './components/TabBar';
import { resolveAuth } from './core/connect';
import { hostsStore, touchServerConnected, type ServerRecord } from './core/hosts-store';
import { exportConnections } from './core/importers/export';
import { pushRecent } from './core/recents-store';
import { SessionManager, type TerminalLook } from './core/session-manager';
import { isAppShortcut, shortcutLabel } from './core/platform';
import { appearanceClass, appearanceMode, sidebarOpen, useEffectiveScheme } from './core/settings';
import { useStore } from './core/store';
import { resolveScheme, tabNeedsEdge, terminalAppearance, terminalBgImage, toXtermTheme } from './core/terminal-appearance';
import type { SshBackend } from './types';

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
      <DialogsProvider>
        <AppInner {...props} />
      </DialogsProvider>
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
    () => ({ theme: toXtermTheme(resolved, !!bgImage), fontSize: appearance.fontSize }),
    [resolved, bgImage, appearance.fontSize],
  );
  const lookRef = useRef(look);
  lookRef.current = look;

  const manager = useMemo(() => new SessionManager(backend, lookRef.current), [backend]);
  useEffect(() => manager.applyLook(look), [manager, look]);
  useEffect(() => manager.setHostKeyPrompt((problem) => dialogs.hostKey(problem)), [manager, dialogs]);
  // 启动时默认打开一个新标签页
  useEffect(() => {
    if (manager.getSnapshot().tabs.length === 0) manager.openNewTab();
  }, [manager]);

  const { tabs, activeId } = useSyncExternalStore(manager.subscribe, manager.getSnapshot);
  const active = tabs.find((t) => t.id === activeId) ?? null;
  const session = active?.session ?? null;
  const monitor = manager.getMonitor(session?.id ?? null);
  const connectedCount = tabs.filter((t) => t.session?.status === 'connected').length;

  const [managerOpen, setManagerOpen] = useState(false);
  const [managerImport, setManagerImport] = useState(false);
  const [lookOpen, setLookOpen] = useState(false);
  const [bottomTab, setBottomTab] = useState<BottomTab>('files');

  /** 连接一台服务器：凑齐认证信息，开一个会话标签（当前是新标签页则原地替换） */
  const connectServer = useCallback(
    async (server: ServerRecord) => {
      const auth = await resolveAuth(server, backend.secrets, dialogs);
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
    [backend, manager, dialogs],
  );

  const closeTab = useCallback(
    async (id: string) => {
      const tab = manager.getSnapshot().tabs.find((t) => t.id === id);
      if (tab?.session?.status === 'connected') {
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
      if (isAppShortcut(e, 'o')) {
        e.preventDefault();
        setManagerOpen(true);
      } else if (isAppShortcut(e, 't')) {
        e.preventDefault();
        manager.openNewTab();
      } else if (isAppShortcut(e, 'w')) {
        const id = manager.getSnapshot().activeId;
        if (id) {
          e.preventDefault();
          void closeTab(id);
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [manager, closeTab]);

  const menuItems: MenuItem[] = [
    { label: '连接管理器…', hint: shortcutLabel('o'), onSelect: () => setManagerOpen(true) },
    { label: '新标签页', hint: shortcutLabel('t'), onSelect: () => manager.openNewTab() },
    { type: 'separator' },
    {
      label: '导入连接…',
      onSelect: () => {
        setManagerImport(true);
        setManagerOpen(true);
      },
    },
    {
      label: '导出连接…',
      onSelect: () => {
        void exportConnections(hostsStore.get(), null, (name, bytes) => backend.saveFile(name, bytes))
          .then((where) =>
            dialogs.alert('导出连接', where ? `已导出：${where}（不含密码和私钥）` : '还没有可导出的连接'),
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

  // 终端配色暴露成变量：终端区底色（也是选中会话标签的底色）、重连按钮颜色
  const style = {
    '--t-bg': resolved.bg,
    '--t-fg': resolved.fg,
    '--t-amber': resolved.amber,
    // 选中标签的背景跟终端底色走，文字要和它有对比，而不是和界面深浅色走
    '--tab-on-fg': resolved.isLight ? '#1D1D1F' : '#ECECEE',
    '--tab-on-dim': resolved.isLight ? '#5C5C63' : '#A3A3AA',
    '--tab-on-edge': tabNeedsEdge(resolved.bg, scheme) ? 'var(--strip-sep)' : undefined,
  } as CSSProperties;

  return (
    <div className={`app ${appearanceClass(mode)}`} style={style}>
      {sidebar && (
        <MonitorSidebar
          session={session}
          monitor={monitor}
          onToggleSidebar={() => sidebarOpen.set(false)}
          leadingInset={windowButtonsInset}
        />
      )}
      <div className="app__main">
        <TabBar
          tabs={tabs}
          activeId={activeId}
          onSelect={(id) => manager.activate(id)}
          onClose={(id) => void closeTab(id)}
          onNewTab={() => manager.openNewTab()}
          onOpenManager={() => setManagerOpen(true)}
          onShowSidebar={sidebar ? undefined : () => sidebarOpen.set(true)}
          menuItems={menuItems}
          leadingInset={sidebar ? undefined : windowButtonsInset}
        />
        {session ? (
          <SessionView
            manager={manager}
            session={session}
            scheme={scheme}
            connectedCount={connectedCount}
            lookOpen={lookOpen}
            onToggleLook={() => setLookOpen((o) => !o)}
            bottomTab={bottomTab}
            onBottomTab={setBottomTab}
          />
        ) : (
          <NewTabPage onConnect={(s) => void connectServer(s)} onOpenManager={() => setManagerOpen(true)} />
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
          onConnect={(s) => void connectServer(s)}
        />
      )}
    </div>
  );
}
