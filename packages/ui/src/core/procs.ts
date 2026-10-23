import type { MonitorSnapshot } from '../types';
import { PersistentStore } from './storage';

/** 状态栏进程表按哪列排：内存 / CPU，都是从高到低 */
export type ProcSort = 'mem' | 'cpu';

type Proc = MonitorSnapshot['procs'][number];

/** 进程表显示几行。后端给的是内存前 10 和 CPU 前 10 的并集，按哪列排都能凑满真正的前 10 */
export const PROC_ROWS = 10;

/** 选过的排法记下来，切会话、重开 App 都不变 */
export const procSort = new PersistentStore<ProcSort>('evershell.sidebar.proc-sort', 'mem', (raw, fb) =>
  raw === 'mem' || raw === 'cpu' ? raw : fb,
);

/** 按选中的列从高到低排，取前 PROC_ROWS 个；CPU 一样时（大多是 0）内存大的在前 */
export function sortProcs(procs: readonly Proc[], by: ProcSort): Proc[] {
  return [...procs]
    .sort((a, b) => (by === 'cpu' ? b.cpuPercent - a.cpuPercent || b.memBytes - a.memBytes : b.memBytes - a.memBytes))
    .slice(0, PROC_ROWS);
}
