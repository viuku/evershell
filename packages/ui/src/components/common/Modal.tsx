import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react';

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
 * Esc 关闭；点遮罩不关，防止误触丢掉表单。
 */
export function Modal({ title, onClose, children, width = 470, height, tone = 'window', className, titleExtra }: Props) {
  const titleId = useId();
  const ref = useRef<HTMLElement>(null);

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
        <header className="modal__head">
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
