import { describe, expect, it } from 'vitest';
import {
  clickSelect,
  contextSelect,
  emptySelection,
  moveSelect,
  pruneSelection,
  selectAll,
  selectOnly,
  type Selection,
} from '../selection';

const order = ['a', 'b', 'c', 'd', 'e', 'f'];
const plain = { toggle: false, range: false };
const cmd = { toggle: true, range: false };
const shift = { toggle: false, range: true };
const ids = (s: Selection) => [...s.ids].sort();

describe('clickSelect', () => {
  it('单击只选这一项', () => {
    const s = clickSelect(selectAll(emptySelection, order), order, 'c', plain);
    expect(ids(s)).toEqual(['c']);
    expect(s.focus).toBe('c');
  });

  it('⌘ 单击加选，再点一次取消', () => {
    let s = clickSelect(emptySelection, order, 'b', plain);
    s = clickSelect(s, order, 'e', cmd);
    expect(ids(s)).toEqual(['b', 'e']);
    s = clickSelect(s, order, 'b', cmd);
    expect(ids(s)).toEqual(['e']);
  });

  it('Shift 单击选中起点到终点的一段，往回点这一段跟着变', () => {
    let s = clickSelect(emptySelection, order, 'b', plain);
    s = clickSelect(s, order, 'e', shift);
    expect(ids(s)).toEqual(['b', 'c', 'd', 'e']);
    s = clickSelect(s, order, 'c', shift);
    expect(ids(s)).toEqual(['b', 'c']);
    // 越过起点往上
    s = clickSelect(s, order, 'a', shift);
    expect(ids(s)).toEqual(['a', 'b']);
  });

  it('⌘ 加选的项在 Shift 选段时保留', () => {
    let s = clickSelect(emptySelection, order, 'a', plain);
    s = clickSelect(s, order, 'd', cmd);
    s = clickSelect(s, order, 'f', shift);
    expect(ids(s)).toEqual(['a', 'd', 'e', 'f']);
    s = clickSelect(s, order, 'e', shift);
    expect(ids(s)).toEqual(['a', 'd', 'e']);
  });

  it('没有起点时 Shift 单击等于单击', () => {
    expect(ids(clickSelect(emptySelection, order, 'c', shift))).toEqual(['c']);
  });
});

describe('contextSelect', () => {
  it('右键点在选中的项上保留整组', () => {
    const s = contextSelect(clickSelect(selectOnly('a'), order, 'c', shift), 'b');
    expect(ids(s)).toEqual(['a', 'b', 'c']);
    expect(s.focus).toBe('b');
  });

  it('右键点在没选中的项上只选它', () => {
    expect(ids(contextSelect(selectAll(emptySelection, ['a', 'b']), 'z'))).toEqual(['z']);
  });
});

describe('moveSelect', () => {
  it('没选东西时 ↓ 选第一行，↑ 选最后一行', () => {
    expect(ids(moveSelect(emptySelection, order, 1, false))).toEqual(['a']);
    expect(ids(moveSelect(emptySelection, order, -1, false))).toEqual(['f']);
  });

  it('↓ 移到下一行，到底不动', () => {
    expect(ids(moveSelect(selectOnly('c'), order, 1, false))).toEqual(['d']);
    expect(ids(moveSelect(selectOnly('f'), order, 1, false))).toEqual(['f']);
  });

  it('Shift+↓ 扩大，Shift+↑ 缩回', () => {
    let s = moveSelect(selectOnly('b'), order, 1, true);
    s = moveSelect(s, order, 1, true);
    expect(ids(s)).toEqual(['b', 'c', 'd']);
    s = moveSelect(s, order, -1, true);
    expect(ids(s)).toEqual(['b', 'c']);
  });
});

describe('selectAll / pruneSelection', () => {
  it('全选看得见的行', () => {
    expect(ids(selectAll(selectOnly('c'), order))).toEqual(order);
  });

  it('看不见的项从选中里去掉', () => {
    const s = pruneSelection(clickSelect(selectOnly('b'), order, 'e', shift), ['a', 'b', 'f']);
    expect(ids(s)).toEqual(['b']);
    expect(s.focus).toBeNull();
    expect(s.anchor).toBe('b');
  });

  it('都还在时原样返回，不触发重画', () => {
    const s = selectOnly('b');
    expect(pruneSelection(s, order)).toBe(s);
  });
});
