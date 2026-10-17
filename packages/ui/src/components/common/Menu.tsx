import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CheckIcon } from './Icons';

export type MenuItem =
  | { type: 'separator' }
  | { type: 'label'; label: string }
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
}

/** 菜单项列表，Dropdown 和 ContextMenu 共用 */
function MenuList({ items, onClose, ariaLabel }: ListProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])');
    first?.focus();
  }, []);

  const move = (dir: 1 | -1) => {
    const nodes = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? [])];
    const i = nodes.indexOf(document.activeElement as HTMLElement);
    const next = nodes[(i + dir + nodes.length) % nodes.length];
    next?.focus();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={ariaLabel}
      className="menu"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          move(-1);
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
        const radio = item.checked !== undefined;
        return (
          <button
            key={i}
            type="button"
            role={radio ? 'menuitemradio' : 'menuitem'}
            aria-checked={radio ? item.checked : undefined}
            aria-disabled={item.disabled || undefined}
            disabled={item.disabled}
            className={`menu__item${item.danger ? ' menu__item--danger' : ''}`}
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
