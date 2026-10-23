/** 拖动弹窗时，标题栏左右至少留这么宽在窗口里，免得拖出去够不着 */
export const MODAL_KEEP_VISIBLE = 100;

export interface Offset {
  x: number;
  y: number;
}

/** 弹窗没拖动时（居中）的位置和宽度 */
export interface ModalBase {
  left: number;
  top: number;
  width: number;
}

/**
 * 把拖动后的偏移量限制在窗口内：标题栏上下不出窗口，左右至少露出 MODAL_KEEP_VISIBLE。
 * 和 Mac 的窗口一样，正文可以拖到窗口外面，标题栏总能抓回来。
 */
export function clampModalOffset(
  want: Offset,
  base: ModalBase,
  viewport: { width: number; height: number },
  headHeight: number,
): Offset {
  const keep = Math.min(MODAL_KEEP_VISIBLE, base.width);
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max));
  return {
    x: clamp(want.x, keep - base.width - base.left, viewport.width - keep - base.left),
    y: clamp(want.y, -base.top, viewport.height - headHeight - base.top),
  };
}
