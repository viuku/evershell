import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CheckIcon, ChevronRightIcon } from './Icons';

export type MenuItem =
  | { type: 'separator' }
  | { type: 'label'; label: string }
  /** 二级菜单：鼠标移上去、单击或按 → 打开 */
  | { type: 'submenu'; label: string; items: MenuItem[]; disabled?: boolean }
  | {
      type?: 'item';
      label: string;
      onSelect(): void;
      /** 单选项：显示勾 */
      checked?: boolean;
      disabled?: boolean;
      danger?: boolean;
      hint?: string;
    };

interface ListProps {
  items: MenuItem[];
  onClose(): void;
  ariaLabel?: string;
  /** 打开时把焦点放到第一项。鼠标移上去打开的二级菜单不抢焦点 */
  autoFocus?: boolean;
  /** 二级菜单里按 ← 或 Esc：收起它，焦点回到上一级 */
  onBack?(): void;
}

/** 菜单项列表，Dropdown、ContextMenu 和二级菜单共用 */
function MenuList({ items, onClose, ariaLabel, autoFocus = true, onBack }: ListProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  /** 打开着的二级菜单是第几项，keyboard：是按键打开的（焦点要进去） */
  const [sub, setSub] = useState<{ index: number; keyboard: boolean } | null>(null);

  const enabled = () => refs.current.filter((b): b is HTMLButtonElement => !!b && !b.disabled);

  useEffect(() => {
    if (autoFocus) enabled()[0]?.focus();
  }, [autoFocus]);

  const move = (dir: 1 | -1) => {
    const nodes = enabled();
    const i = nodes.indexOf(document.activeElement as HTMLButtonElement);
    const next = nodes[(i + dir + nodes.length) % nodes.length];
    next?.focus();
  };

  return (
    <div
      role="menu"
      aria-label={ariaLabel}
      className="menu"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          if (onBack) onBack();
          else onClose();
        } else if (e.key === 'ArrowLeft' && onBack) {
          e.stopPropagation();
          onBack();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          e.stopPropagation();
          move(e.key === 'ArrowDown' ? 1 : -1);
        }
      }}
    >
      {items.map((item, i) => {
        if (item.type === 'separator') return <div key={i} role="separator" className="menu__sep" />;
        if (item.type === 'label')
          return (
            <div key={i} className="menu__label">
              {item.label}
            </div>
          );
        if (item.type === 'submenu') {
          const open = sub?.index === i;
          return (
            <div key={i} className="menu__subwrap" onMouseEnter={() => !item.disabled && setSub({ index: i, keyboard: false })}>
              <button
                ref={(el) => {
                  refs.current[i] = el;
                }}
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-disabled={item.disabled || undefined}
                disabled={item.disabled}
                className={`menu__item${open ? ' menu__item--open' : ''}`}
                onMouseEnter={(e) => !item.disabled && e.currentTarget.focus()}
                onClick={() => setSub(open ? null : { index: i, keyboard: false })}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    setSub({ index: i, keyboard: true });
                  }
                }}
              >
                <span className="menu__check" />
                <span className="menu__text">{item.label}</span>
                <ChevronRightIcon size={11} className="menu__more" />
              </button>
              {open && (
                <SubMenu
                  items={item.items}
                  onClose={onClose}
                  keyboard={sub.keyboard}
                  onBack={() => {
                    setSub(null);
                    refs.current[i]?.focus();
                  }}
                />
              )}
            </div>
          );
        }
        const radio = item.checked !== undefined;
        return (
          <button
            key={i}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role={radio ? 'menuitemradio' : 'menuitem'}
            aria-checked={radio ? item.checked : undefined}
            aria-disabled={item.disabled || undefined}
            disabled={item.disabled}
            className={`menu__item${item.danger ? ' menu__item--danger' : ''}`}
            onMouseEnter={(e) => {
              // 高亮跟着鼠标走：焦点也移过来，免得键盘焦点停在第一项、和鼠标指着的那项同时亮着
              setSub(null);
              if (!item.disabled) e.currentTarget.focus();
            }}
            onClick={() => {
              if (item.disabled) return;
              onClose();
              item.onSelect();
            }}
          >
            <span className="menu__check">{item.checked && <CheckIcon size={11} />}</span>
            <span className="menu__text">{item.label}</span>
            {item.hint && <span className="menu__hint">{item.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** 二级菜单贴在那一项右边，右边放不下就放左边 */
function SubMenu({ items, onClose, onBack, keyboard }: { items: MenuItem[]; onClose(): void; onBack(): void; keyboard: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(false);
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r && r.right > window.innerWidth - 4) setLeft(true);
  }, []);
  return (
    <div ref={ref} className={`menu__sub${left ? ' menu__sub--left' : ''}`}>
      <MenuList items={items} onClose={onClose} onBack={onBack} autoFocus={keyboard} />
    </div>
  );
}

function useDismiss(onClose: () => void, ignore?: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ignore?.current?.contains(target)) return;
      if ((target as HTMLElement).closest?.('.menu')) return;
      onClose();
    };
    const onBlur = () => onClose();
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [onClose, ignore]);
}

interface DropdownProps {
  /** 触发按钮；菜单贴在它下方 */
  trigger: (props: { onClick(): void; 'aria-expanded': boolean; 'aria-haspopup': 'menu'; ref: React.RefObject<HTMLButtonElement | null> }) => ReactNode;
  items: MenuItem[];
  align?: 'left' | 'right';
  /** 向上弹（命令栏在底部时用） */
  direction?: 'down' | 'up';
  ariaLabel?: string;
}

export function Dropdown({ trigger, items, align = 'left', direction = 'down', ariaLabel }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  useDismiss(close, btnRef);

  return (
    <div className="dropdown">
      {trigger({ onClick: () => setOpen((o) => !o), 'aria-expanded': open, 'aria-haspopup': 'menu', ref: btnRef })}
      {open && (
        <div className={`dropdown__pop dropdown__pop--${align} dropdown__pop--${direction}`}>
          <MenuList items={items} onClose={close} ariaLabel={ariaLabel} />
        </div>
      )}
    </div>
  );
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/** 右键菜单：固定定位在鼠标位置，超出窗口时往回挪 */
export function ContextMenu({ state, onClose }: { state: ContextMenuState; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: state.x, y: state.y });
  useDismiss(onClose);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      x: Math.max(4, Math.min(state.x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(state.y, window.innerHeight - r.height - 4)),
    });
  }, [state]);

  return (
    <div ref={ref} className="context-menu" style={{ left: pos.x, top: pos.y }}>
      <MenuList items={state.items} onClose={onClose} />
    </div>
  );
}
