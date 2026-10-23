import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import '../../styles/editor.css';
import { EditorDocs } from '../../core/editor-docs';
import type { MessagePort } from '../../core/remote-edit';
import { EditorWorkspace } from './EditorWorkspace';

interface Props {
  port: MessagePort;
  onClosed(): void;
}

/**
 * 没有独立窗口的平台（网页端）：编辑器浮在主窗口上，不挡主窗口的操作。
 * 按住文件标签栏的空白处拖动，右下角拉大小
 */
export default function FloatingEditor({ port, onClosed }: Props) {
  const docs = useMemo(() => new EditorDocs(port), [port]);
  useEffect(() => {
    docs.start();
    return () => docs.stop();
  }, [docs]);

  const ref = useRef<HTMLElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ px: number; py: number; x: number; y: number } | null>(null);

  // 第一次出现在主窗口正中偏上
  useEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ x: Math.max(8, (window.innerWidth - r.width) / 2), y: Math.max(8, (window.innerHeight - r.height) / 3) });
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    // 只认标签栏的空白处，标签和按钮照常点
    if (e.button !== 0 || (e.target as HTMLElement).closest('button') || !pos) return;
    drag.current = { px: e.clientX, py: e.clientY, x: pos.x, y: pos.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // 标签栏至少留 40px 在窗口里，免得拖丢了
    const x = Math.min(window.innerWidth - 80, Math.max(80 - (ref.current?.offsetWidth ?? 0), d.x + e.clientX - d.px));
    const y = Math.min(window.innerHeight - 40, Math.max(0, d.y + e.clientY - d.py));
    setPos({ x, y });
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const close = () => {
    port.post({ type: 'gone' });
    onClosed();
  };

  return (
    <section
      ref={ref}
      role="dialog"
      aria-label="编辑器"
      className="ed-float"
      style={pos ? { left: pos.x, top: pos.y } : { visibility: 'hidden' }}
    >
      <EditorWorkspace
        docs={docs}
        onClosed={close}
        closable
        stripProps={{ onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp }}
      />
    </section>
  );
}
