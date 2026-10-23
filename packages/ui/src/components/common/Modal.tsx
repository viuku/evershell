import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';
import { clampModalOffset, type ModalBase, type Offset } from '../../core/modal-position';

interface Props {
  title: string;
  onClose(): void;
  children: ReactNode;
  /** 对话框宽度，默认 470 */
  width?: number;
  height?: number;
  /** 'sheet' 用于弹窗里的小弹窗，背景更浅 */
  tone?: 'window' | 'sheet';
  className?: string;
  /** 标题栏右侧附加内容 */
  titleExtra?: ReactNode;
}

/**
 * 模态窗：遮罩 + 居中对话框，顶部是 Mac 式标题栏，左边的红点就是关闭按钮。
 * Esc 关闭；点遮罩不关，防止误触丢掉表单。按住标题栏能拖动，每次打开都回到正中。
 */
export function Modal({ title, onClose, children, width = 470, height, tone = 'window', className, titleExtra }: Props) {
  const titleId = useId();
  const ref = useRef<HTMLElement>(null);
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 });
  const drag = useRef<{ pointerX: number; pointerY: number; from: Offset; base: ModalBase; headHeight: number } | null>(
    null,
  );

  /** 没拖动时（居中）的位置：现在的位置减掉已经拖过的偏移 */
  const measureBase = (current: Offset): ModalBase | null => {
    const r = ref.current?.getBoundingClientRect();
    return r ? { left: r.left - current.x, top: r.top - current.y, width: r.width } : null;
  };
  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight });

  const onHeadPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, a, input, select, textarea')) return;
    const base = measureBase(offset);
    if (!base) return;
    drag.current = { pointerX: e.clientX, pointerY: e.clientY, from: offset, base, headHeight: e.currentTarget.offsetHeight };
    e.currentTarget.setPointerCapture(e.pointerId);
    // 不让输入框失焦，也不选中文字
    e.preventDefault();
  };
  const onHeadPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d) return;
    const want = { x: d.from.x + e.clientX - d.pointerX, y: d.from.y + e.clientY - d.pointerY };
    setOffset(clampModalOffset(want, d.base, viewport(), d.headHeight));
  };
  const onHeadPointerUp = () => {
    drag.current = null;
  };

  // 主窗口变小时，拖到边上的弹窗跟着拉回来，标题栏不会落到窗口外
  useEffect(() => {
    const onResize = () =>
      setOffset((o) => {
        const base = measureBase(o);
        const head = ref.current?.querySelector<HTMLElement>('.modal__head');
        if (!base || !head || (o.x === 0 && o.y === 0)) return o;
        const next = clampModalOffset(o, base, viewport(), head.offsetHeight);
        return next.x === o.x && next.y === o.y ? o : next;
      });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const previous = document.activeElement as HTMLElement | null;
    // 优先聚焦第一个可输入控件
    const first = el.querySelector<HTMLElement>('input:not([type=checkbox]), select, textarea, [data-autofocus]');
    (first ?? el).focus();
    return () => previous?.focus();
  }, []);

  const style: CSSProperties = { maxWidth: width };
  if (height) style.height = height;
  // 用 left/top 挪，不用 transform：transform 会让里面的右键菜单、套着的小弹窗以弹窗为准定位，还被它裁掉
  if (offset.x || offset.y) Object.assign(style, { left: offset.x, top: offset.y });

  return (
    <div
      className="modal-scrim"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <section
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`modal modal--${tone}${className ? ` ${className}` : ''}`}
        style={style}
      >
        <header
          className="modal__head"
          onPointerDown={onHeadPointerDown}
          onPointerMove={onHeadPointerMove}
          onPointerUp={onHeadPointerUp}
          onPointerCancel={onHeadPointerUp}
        >
          <div className="modal__lights">
            <button type="button" className="modal__light modal__light--close" aria-label="关闭" onClick={onClose} />
            <span className="modal__light" />
            <span className="modal__light" />
          </div>
          <h2 id={titleId} className="modal__title">
            {title}
          </h2>
          {titleExtra && <div className="modal__extra">{titleExtra}</div>}
        </header>
        {children}
      </section>
    </div>
  );
}
