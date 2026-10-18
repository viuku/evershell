import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { dragRegion, shortcutLabel } from '../core/platform';
import type { TabInfo } from '../core/session-manager';
import { CloseIcon, FolderOutlineIcon, MenuIcon, PlusIcon } from './common/Icons';
import { Dropdown, type MenuItem } from './common/Menu';
import { SidebarToggle } from './sidebar/SidebarToggle';

interface Props {
  tabs: TabInfo[];
  activeId: string | null;
  onSelect(id: string): void;
  onClose(id: string): void;
  onNewTab(): void;
  onOpenManager(): void;
  /** 状态栏收起时传入：最前面放状态栏开关（展开时开关在状态栏顶部） */
  onShowSidebar?: () => void;
  menuItems: MenuItem[];
  /** 左边让出的宽度，给叠在窗口左上角的系统按钮 */
  leadingInset?: number;
}

/** 换行后的排布：哪些标签是每行的第一个（不画左边的分隔线），选中的标签是否不在最后一行 */
interface Rows {
  rowStarts: ReadonlySet<string>;
  activeUpper: boolean;
}

const NO_ROWS: Rows = { rowStarts: new Set(), activeUpper: false };

/**
 * 顶部标签栏：状态栏开关（收起时）、连接管理器按钮、标签、「+」、≡ 菜单。
 * 标签多了像 FinalShell 一样换行，「+」始终跟在最后一个标签后面。空白处可拖动窗口
 */
export function TabBar({ tabs, activeId, onSelect, onClose, onNewTab, onOpenManager, onShowSidebar, menuItems, leadingInset }: Props) {
  const navRef = useRef<HTMLElement>(null);
  const rows = useRows(navRef, tabs, activeId);

  return (
    <div className="tabbar" style={leadingInset ? { paddingLeft: leadingInset } : undefined} {...dragRegion}>
      {onShowSidebar && <SidebarToggle onToggle={onShowSidebar} />}
      <button type="button" className="tb tabbar__manager" aria-label="连接管理器" title={`连接管理器（${shortcutLabel('o')}）`} onClick={onOpenManager}>
        <FolderOutlineIcon size={18} />
      </button>
      <nav ref={navRef} aria-label="会话" className="tabbar__tabs" {...dragRegion}>
        {tabs.map((t) => {
          const on = t.id === activeId;
          const s = t.session;
          const name = s ? s.name : '新标签页';
          const cls = [
            'tab',
            on && 'tab--on',
            on && rows.activeUpper && 'tab--upper',
            !s && 'tab--newtab',
            rows.rowStarts.has(t.id) && 'tab--row-start',
          ];
          return (
            <div key={t.id} data-tab={t.id} className={cls.filter(Boolean).join(' ')} title={s ? `${s.user}@${s.host}:${s.port}` : undefined}>
              <button
                type="button"
                className="tab__pick"
                aria-current={on ? 'page' : undefined}
                onClick={() => onSelect(t.id)}
                onAuxClick={(e) => {
                  if (e.button === 1) onClose(t.id);
                }}
              >
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
        <button type="button" className="tb tabbar__new" aria-label="新标签页" title={`新标签页（${shortcutLabel('t')}）`} onClick={onNewTab}>
          <PlusIcon size={14} />
        </button>
      </nav>
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

/** 量出标签换行后的排布。只影响分隔线和选中标签的画法，不改变尺寸，所以不会来回触发 */
function useRows(navRef: RefObject<HTMLElement | null>, tabs: TabInfo[], activeId: string | null): Rows {
  const [rows, setRows] = useState<Rows>(NO_ROWS);

  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const els = Array.from(nav.querySelectorAll<HTMLElement>('[data-tab]'));
      const rowStarts = new Set<string>();
      let top = Number.NaN;
      let active: HTMLElement | null = null;
      for (const el of els) {
        if (el.offsetTop !== top) rowStarts.add(el.dataset.tab!);
        top = el.offsetTop;
        if (el.dataset.tab === activeId) active = el;
      }
      const activeUpper = !!active && active.offsetTop < top;
      setRows((prev) =>
        prev.activeUpper === activeUpper && sameSet(prev.rowStarts, rowStarts) ? prev : { rowStarts, activeUpper },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [navRef, tabs, activeId]);

  return rows;
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}
