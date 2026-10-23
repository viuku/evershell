import { describe, expect, it } from 'vitest';
import { clampModalOffset, MODAL_KEEP_VISIBLE } from '../modal-position';

// 1200×780 的窗口里居中放一个 920×580 的连接管理器
const viewport = { width: 1200, height: 780 };
const base = { left: 140, top: 100, width: 920 };
const HEAD = 30;

describe('clampModalOffset', () => {
  it('窗口内随便拖，原样返回', () => {
    expect(clampModalOffset({ x: -50, y: 80 }, base, viewport, HEAD)).toEqual({ x: -50, y: 80 });
  });

  it('标题栏不能拖出窗口上沿', () => {
    expect(clampModalOffset({ x: 0, y: -500 }, base, viewport, HEAD).y).toBe(-100);
  });

  it('往下拖，标题栏停在窗口底部，正文可以出界', () => {
    expect(clampModalOffset({ x: 0, y: 2000 }, base, viewport, HEAD).y).toBe(780 - HEAD - 100);
  });

  it('左右拖出去，标题栏至少露出一截', () => {
    const left = clampModalOffset({ x: -5000, y: 0 }, base, viewport, HEAD);
    expect(base.left + left.x + base.width).toBe(MODAL_KEEP_VISIBLE);
    const right = clampModalOffset({ x: 5000, y: 0 }, base, viewport, HEAD);
    expect(base.left + right.x).toBe(viewport.width - MODAL_KEEP_VISIBLE);
  });

  it('窗口缩小后，原来的偏移被拉回来', () => {
    const small = { width: 800, height: 500 };
    const smallBase = { left: 0, top: 0, width: 800 };
    expect(clampModalOffset({ x: 900, y: 600 }, smallBase, small, HEAD)).toEqual({
      x: 800 - MODAL_KEEP_VISIBLE,
      y: 500 - HEAD,
    });
  });
});
