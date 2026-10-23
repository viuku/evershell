import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** 鼠标停多久出提示 */
const SHOW_DELAY = 500;
/** 刚看完一个提示，这么短时间内移到旁边的按钮就立刻显示，和系统一样 */
const WARM_MS = 800;

interface Tip {
  text: string;
  x: number;
  /** 提示框上沿（放在元素下方时）或下沿（放在上方时）的位置 */
  y: number;
  above: boolean;
}

/** 找鼠标下面带说明的元素。灰掉的按钮在样式里设了不接收鼠标，事件落到外层，按坐标在外层的子元素里找回来 */
function tipTarget(e: PointerEvent): HTMLElement | null {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return null;
  const hit = t.closest<HTMLElement>('[data-tip]');
  if (hit) return hit;
  for (const el of t.children) {
    if (!(el instanceof HTMLElement) || !el.matches('[data-tip]:disabled')) continue;
    const r = el.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom) return el;
  }
  return null;
}

/**
 * 悬停提示：鼠标停在带 data-tip 的元素上，在它下方显示说明。整个界面挂一个就够。
 * 不用系统的 title 提示：Mac 桌面端的网页视图里它要停很久才出、有时不出；
 * 灰掉的按钮在 Mac 的网页引擎里收不到鼠标事件，title 提示也就不出。
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [shown, setShown] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current: HTMLElement | null = null;
    let timer = 0;
    let visible = false;
    let hiddenAt = 0;
    let pointerX = 0;

    const show = () => {
      const text = current?.dataset.tip;
      if (!current || !current.isConnected || !text) return;
      const r = current.getBoundingClientRect();
      const above = r.bottom + 34 > window.innerHeight;
      setTip({ text, x: pointerX, y: above ? r.top - 4 : r.bottom + 4, above });
      setShown(true);
      visible = true;
    };
    const hide = () => {
      window.clearTimeout(timer);
      current = null;
      if (!visible) return;
      visible = false;
      hiddenAt = Date.now();
      setShown(false);
    };
    // 点了、按了键、滚了：收起来，鼠标还在这个元素上就不再出，移开再回来才出
    const dismiss = () => {
      window.clearTimeout(timer);
      if (!visible) return;
      visible = false;
      setShown(false);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const el = tipTarget(e);
      if (el === current) return;
      hide();
      if (!el) return;
      current = el;
      pointerX = e.clientX;
      timer = window.setTimeout(show, Date.now() - hiddenAt < WARM_MS ? 0 : SHOW_DELAY);
    };
    const onLeave = (e: MouseEvent) => {
      if (!e.relatedTarget) hide();
    };

    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', dismiss, true);
    document.addEventListener('wheel', dismiss, { capture: true, passive: true });
    document.addEventListener('mouseout', onLeave);
    window.addEventListener('blur', hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', dismiss, true);
      document.removeEventListener('wheel', dismiss, true);
      document.removeEventListener('mouseout', onLeave);
      window.removeEventListener('blur', hide);
    };
  }, []);

  // 量出宽度后左右收进窗口里
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box || !tip) return;
    box.style.left = `${Math.max(8, Math.min(tip.x, window.innerWidth - box.offsetWidth - 8))}px`;
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={boxRef}
      role="tooltip"
      className={`tip${shown ? ' tip--on' : ''}`}
      style={tip.above ? { left: tip.x, bottom: window.innerHeight - tip.y } : { left: tip.x, top: tip.y }}
    >
      {tip.text}
    </div>
  );
}
