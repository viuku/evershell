// 列表多选，照访达的列表视图：
// - 单击只选这一项；按住 ⌘（其他系统 Ctrl）单击加选或取消这一项；
// - 按住 Shift 单击，选中从起点到这一项的一整段，之前 ⌘ 加选的保留；再 Shift 单击别处，这一段跟着变；
// - ↑↓ 移动，按住 Shift 时往上下扩大或缩小这一段；全选选中当前看得见的所有行。
// 列表顺序（看得见的行）由调用方传入，这里只管算选中了哪些。

export interface Selection {
  /** 选中的 id */
  ids: ReadonlySet<string>;
  /** 最近单击或键盘移到的那一项：新建放在它所在的文件夹，方向键从它出发 */
  focus: string | null;
  /** Shift 选一段的起点 */
  anchor: string | null;
  /** 定下起点时已经选中的项，Shift 选段时保留 */
  base: ReadonlySet<string>;
}

export const emptySelection: Selection = { ids: new Set(), focus: null, anchor: null, base: new Set() };

const EMPTY: ReadonlySet<string> = new Set();

/** 只选这一项 */
export function selectOnly(id: string): Selection {
  return { ids: new Set([id]), focus: id, anchor: id, base: EMPTY };
}

/** 从 a 到 b（含两头）的一段，a、b 不在列表里时为空 */
function span(order: readonly string[], a: string, b: string): string[] {
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return [];
  return order.slice(Math.min(i, j), Math.max(i, j) + 1);
}

function extendTo(sel: Selection, order: readonly string[], id: string): Selection {
  const anchor = sel.anchor !== null && order.includes(sel.anchor) ? sel.anchor : null;
  if (anchor === null) return selectOnly(id);
  return { ...sel, ids: new Set([...sel.base, ...span(order, anchor, id)]), focus: id, anchor };
}

/** 单击某一行。toggle：按住 ⌘ / Ctrl；range：按住 Shift（两个都按时按 Shift 算） */
export function clickSelect(
  sel: Selection,
  order: readonly string[],
  id: string,
  mods: { toggle: boolean; range: boolean },
): Selection {
  if (mods.range) return extendTo(sel, order, id);
  if (!mods.toggle) return selectOnly(id);
  const ids = new Set(sel.ids);
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, focus: id, anchor: id, base: new Set(ids) };
}

/** 右键：点在选中的项上保留整组，点在没选中的项上只选它 */
export function contextSelect(sel: Selection, id: string): Selection {
  return sel.ids.has(id) ? { ...sel, focus: id } : selectOnly(id);
}

/** ↑↓ 移动；extend：按住 Shift，把起点到新位置这一段选上 */
export function moveSelect(sel: Selection, order: readonly string[], delta: 1 | -1, extend: boolean): Selection {
  const at = sel.focus === null ? -1 : order.indexOf(sel.focus);
  const next = order[at < 0 ? (delta > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, at + delta))];
  if (next === undefined) return sel;
  if (!extend) return selectOnly(next);
  // 没有起点（比如起点被折叠起来了）就从当前这一项算起
  const anchor = sel.anchor !== null && order.includes(sel.anchor) ? sel.anchor : (order[at] ?? null);
  return extendTo({ ...sel, anchor }, order, next);
}

/** 全选看得见的行 */
export function selectAll(sel: Selection, order: readonly string[]): Selection {
  const first = order[0];
  if (first === undefined) return emptySelection;
  const focus = sel.focus !== null && order.includes(sel.focus) ? sel.focus : first;
  return { ids: new Set(order), focus, anchor: first, base: EMPTY };
}

/** 列表变了（搜索、折叠文件夹、删除后隐藏），去掉已经看不见的项；没变化时原样返回 */
export function pruneSelection(sel: Selection, order: readonly string[]): Selection {
  const visible = new Set(order);
  const gone = (id: string | null) => id !== null && !visible.has(id);
  if (![...sel.ids].some(gone) && ![...sel.base].some(gone) && !gone(sel.focus) && !gone(sel.anchor)) return sel;
  return {
    ids: new Set([...sel.ids].filter((id) => visible.has(id))),
    focus: gone(sel.focus) ? null : sel.focus,
    anchor: gone(sel.anchor) ? null : sel.anchor,
    base: new Set([...sel.base].filter((id) => visible.has(id))),
  };
}
