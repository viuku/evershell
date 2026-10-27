import { useEffect, useRef, useState } from 'react';

/** 离列表上下边缘多近开始自动滚动 */
const EDGE = 24;
/** 自动滚动每次最多滚多少（每 30ms 一次） */
const MAX_STEP = 20;

interface Drag {
  list: HTMLElement;
  x: number;
  y: number;
  last: string;
  timer: number;
}

type Start = (e: { clientX: number; clientY: number }, list: HTMLElement, from: string) => void;

/**
 * 在行上按住左键上下拖动来连续选择（照 FinalShell）。调用方在按下时先照单击算好选中，再调返回的 start；
 * 拖动中鼠标移到哪一行就回调 onOver(那一行的 id)，拖到列表上下边缘时列表自动滚动。
 * 行上要有 data-row="id"；鼠标在最后一行下面时算最后一行，在表头上时算看得见的第一行。
 */
export function useDragSelect(onOver: (id: string) => void): Start {
  const onOverRef = useRef(onOver);
  onOverRef.current = onOver;

  const [api] = useState(() => {
    let drag: Drag | null = null;

    const headHeight = (list: HTMLElement) => list.querySelector('.grid-head')?.getBoundingClientRect().height ?? 0;

    const hit = () => {
      if (!drag) return;
      const r = drag.list.getBoundingClientRect();
      const x = Math.max(r.left + 2, Math.min(r.right - 2, drag.x));
      const y = Math.max(r.top + headHeight(drag.list) + 1, Math.min(r.bottom - 2, drag.y));
      const row = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-row]');
      const rows = drag.list.querySelectorAll<HTMLElement>('[data-row]');
      const id = row && drag.list.contains(row) ? row.dataset.row : rows[rows.length - 1]?.dataset.row;
      if (id === undefined || id === drag.last) return;
      drag.last = id;
      onOverRef.current(id);
    };

    const scroll = () => {
      if (!drag) return;
      const r = drag.list.getBoundingClientRect();
      const below = drag.y - (r.bottom - EDGE);
      const above = r.top + headHeight(drag.list) + EDGE - drag.y;
      const step = below > 0 ? Math.min(MAX_STEP, below / 2 + 2) : above > 0 ? -Math.min(MAX_STEP, above / 2 + 2) : 0;
      if (step === 0) return;
      drag.list.scrollTop += step;
      hit();
    };

    const onMove = (e: MouseEvent) => {
      if (!drag) return;
      // 在窗口外面松开的鼠标收不到 mouseup，回来时按键已经放开了
      if ((e.buttons & 1) === 0) return stop();
      drag.x = e.clientX;
      drag.y = e.clientY;
      hit();
    };

    const stop = () => {
      if (!drag) return;
      window.clearInterval(drag.timer);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', stop);
      window.removeEventListener('blur', stop);
      drag = null;
    };

    const start: Start = (e, list, from) => {
      stop();
      drag = { list, x: e.clientX, y: e.clientY, last: from, timer: window.setInterval(scroll, 30) };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', stop);
      window.addEventListener('blur', stop);
    };

    return { start, stop };
  });

  useEffect(() => api.stop, [api]);
  return api.start;
}
