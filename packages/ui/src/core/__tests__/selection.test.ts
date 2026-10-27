import { describe, expect, it } from 'vitest';
import {
  clickSelect,
  contextSelect,
  emptySelection,
  extendTo,
  findByPrefix,
  jumpSelect,
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

describe('按住拖动', () => {
  it('按下时照单击算，拖到哪一行就从起点选到哪一行，往回拖跟着缩', () => {
    const down = clickSelect(selectAll(emptySelection, order), order, 'b', plain);
    let s = extendTo(down, order, 'e');
    expect(ids(s)).toEqual(['b', 'c', 'd', 'e']);
    expect(s.focus).toBe('e');
    s = extendTo(down, order, 'a');
    expect(ids(s)).toEqual(['a', 'b']);
  });

  it('按住 ⌘ 拖动，加在原来选中的后面', () => {
    const down = clickSelect(selectOnly('a'), order, 'd', cmd);
    expect(ids(extendTo(down, order, 'f'))).toEqual(['a', 'd', 'e', 'f']);
  });
});

describe('jumpSelect', () => {
  it('Home / End 跳到第一项、最后一项', () => {
    expect(ids(jumpSelect(selectOnly('c'), order, 'first', false))).toEqual(['a']);
    expect(ids(jumpSelect(selectOnly('c'), order, 'last', false))).toEqual(['f']);
  });

  it('按住 Shift 从起点选到头', () => {
    expect(ids(jumpSelect(selectOnly('d'), order, 'last', true))).toEqual(['d', 'e', 'f']);
    expect(ids(jumpSelect(selectOnly('c'), order, 'first', true))).toEqual(['a', 'b', 'c']);
  });

  it('列表为空时不变', () => {
    expect(jumpSelect(emptySelection, [], 'first', false)).toBe(emptySelection);
  });
});

describe('findByPrefix', () => {
  it('第一个以输入开头的，不分大小写', () => {
    const names = ['apt', 'auth.log', 'Kern.log', 'kern.log.1'];
    expect(findByPrefix(names, 'au')).toBe(1);
    expect(findByPrefix(names, 'ke')).toBe(2);
    expect(findByPrefix(names, 'zz')).toBeNull();
  });
});
