import type { TabInfo } from '../core/session-manager';
import { CloseIcon, FolderOutlineIcon, MenuIcon, PlusIcon, SidebarIcon } from './common/Icons';
import { Dropdown, type MenuItem } from './common/Menu';

interface Props {
  tabs: TabInfo[];
  activeId: string | null;
  onSelect(id: string): void;
  onClose(id: string): void;
  onNewTab(): void;
  onOpenManager(): void;
  onToggleSidebar(): void;
  menuItems: MenuItem[];
}

/** 顶部标签栏：连接管理器按钮、编号标签、「+」、状态栏开关、≡ 菜单 */
export function TabBar({ tabs, activeId, onSelect, onClose, onNewTab, onOpenManager, onToggleSidebar, menuItems }: Props) {
  return (
    <div className="tabbar">
      <button type="button" className="tb tabbar__manager" aria-label="连接管理器" title="连接管理器（⌘O）" onClick={onOpenManager}>
        <FolderOutlineIcon size={18} />
      </button>
      <nav aria-label="会话" className="tabbar__tabs">
        {tabs.map((t, i) => {
          const on = t.id === activeId;
          const s = t.session;
          const name = s ? s.name : '新标签页';
          return (
            <div key={t.id} className={`tab${on ? ' tab--on' : ''}${s ? '' : ' tab--newtab'}`} title={s ? `${s.user}@${s.host}:${s.port}` : undefined}>
              <button
                type="button"
                className="tab__pick"
                aria-current={on ? 'page' : undefined}
                onClick={() => onSelect(t.id)}
                onAuxClick={(e) => {
                  if (e.button === 1) onClose(t.id);
                }}
              >
                <span className="tab__num">{i + 1}</span>
                {s && <span className={`tab__dot tab__dot--${s.status}`} />}
                <span className="tab__name">{name}</span>
              </button>
              <button
                type="button"
                className="tb tab__close"
                aria-label={s ? `关闭会话 ${name}` : '关闭标签页'}
                onClick={() => onClose(t.id)}
              >
                <CloseIcon size={9} />
              </button>
            </div>
          );
        })}
        <button type="button" className="tb tabbar__new" aria-label="新标签页" title="新标签页（⌘T）" onClick={onNewTab}>
          <PlusIcon size={14} />
        </button>
      </nav>
      <button type="button" className="tb tabbar__tool" aria-label="显示或隐藏状态栏" title="显示或隐藏状态栏" onClick={onToggleSidebar}>
        <SidebarIcon size={16} />
      </button>
      <Dropdown
        align="right"
        ariaLabel="菜单"
        items={menuItems}
        trigger={(p) => (
          <button type="button" className="tb tabbar__tool" aria-label="菜单" {...p}>
            <MenuIcon size={16} />
          </button>
        )}
      />
    </div>
  );
}
