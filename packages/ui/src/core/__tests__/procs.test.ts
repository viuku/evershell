import { describe, expect, it } from 'vitest';
import { PROC_ROWS, sortProcs } from '../procs';

const proc = (pid: number, memBytes: number, cpuPercent: number) => ({ pid, name: `p${pid}`, memBytes, cpuPercent });

describe('sortProcs', () => {
  // 后端给的并集：内存大的 CPU 低，后面几个内存小但 CPU 高
  const procs = [
    ...Array.from({ length: 12 }, (_, i) => proc(i + 1, 1000 - i, 0)),
    proc(20, 5, 90),
    proc(21, 3, 40),
  ];

  it('按内存排取前 10', () => {
    const rows = sortProcs(procs, 'mem');
    expect(rows).toHaveLength(PROC_ROWS);
    expect(rows.map((p) => p.pid)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('按 CPU 排，CPU 一样的按内存', () => {
    const rows = sortProcs(procs, 'cpu');
    expect(rows.map((p) => p.pid)).toEqual([20, 21, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('不改动传进来的数组', () => {
    const copy = [...procs];
    sortProcs(procs, 'cpu');
    expect(procs).toEqual(copy);
  });
});
