import type { ProcDetail, SocketRow } from '../types';
import { PersistentStore } from './storage';

/** 进程页、网络页的表按哪列排、是不是从高到低 */
export interface TableSort<K extends string> {
  key: K;
  desc: boolean;
}

export type ProcKey = 'pid' | 'user' | 'mem' | 'cpu' | 'name' | 'exe';
export type SocketKey = 'pid' | 'name' | 'ip' | 'port' | 'ips' | 'conns' | 'up' | 'down';

/** 文字列第一次点从小到大（A→Z），数字列第一次点从高到低 */
const TEXT_KEYS: readonly string[] = ['user', 'name', 'exe', 'ip'];

function sortStore<K extends string>(key: string, keys: readonly K[], fallback: TableSort<K>): PersistentStore<TableSort<K>> {
  return new PersistentStore<TableSort<K>>(key, fallback, (raw, fb) => {
    const r = raw as Partial<TableSort<K>> | null;
    return r && keys.includes(r.key as K) && typeof r.desc === 'boolean' ? { key: r.key as K, desc: r.desc } : fb;
  });
}

/** 选过的排法记下来，和 FinalShell 一样默认按 CPU 从高到低 */
export const procTableSort = sortStore<ProcKey>('evershell.procs-tab.sort', ['pid', 'user', 'mem', 'cpu', 'name', 'exe'], {
  key: 'cpu',
  desc: true,
});

/** 默认按上传从高到低 */
export const socketTableSort = sortStore<SocketKey>(
  'evershell.net-tab.sort',
  ['pid', 'name', 'ip', 'port', 'ips', 'conns', 'up', 'down'],
  { key: 'up', desc: true },
);

/** 点了表头之后的排法：点的是当前列就反过来，换列时文字列从小到大、数字列从高到低 */
export function nextSort<K extends string>(cur: TableSort<K>, key: K): TableSort<K> {
  return cur.key === key ? { key, desc: !cur.desc } : { key, desc: !TEXT_KEYS.includes(key) };
}

/** 文字比较：空的排在最后，不管正着排还是倒着排 */
function compareText(a: string, b: string, desc: boolean): number {
  if (!a !== !b) return a ? -1 : 1;
  const d = a.localeCompare(b);
  return desc ? -d : d;
}

/** 数字比较：null（看不到的 PID、主动连出去的端口）排在最后 */
function compareNum(a: number | null, b: number | null, desc: boolean): number {
  if ((a === null) !== (b === null)) return a === null ? 1 : -1;
  const d = (a ?? 0) - (b ?? 0);
  return desc ? -d : d;
}

export function sortProcTable(rows: readonly ProcDetail[], sort: TableSort<ProcKey>): ProcDetail[] {
  const { key, desc } = sort;
  const cmp = (a: ProcDetail, b: ProcDetail): number => {
    switch (key) {
      case 'pid':
        return compareNum(a.pid, b.pid, desc);
      case 'user':
        return compareText(a.user, b.user, desc);
      case 'mem':
        return compareNum(a.memBytes, b.memBytes, desc);
      case 'cpu':
        // CPU 一样时（大多是 0）内存大的在前，和状态栏一致
        return compareNum(a.cpuPercent, b.cpuPercent, desc) || b.memBytes - a.memBytes;
      case 'name':
        return compareText(a.name, b.name, desc);
      case 'exe':
        return compareText(a.exe, b.exe, desc);
    }
  };
  return [...rows].sort((a, b) => cmp(a, b) || a.pid - b.pid);
}

export function sortSocketTable(rows: readonly SocketRow[], sort: TableSort<SocketKey>): SocketRow[] {
  const { key, desc } = sort;
  const cmp = (a: SocketRow, b: SocketRow): number => {
    switch (key) {
      case 'pid':
        return compareNum(a.pid, b.pid, desc);
      case 'name':
        return compareText(a.name, b.name, desc);
      case 'ip':
        return compareText(a.listenIp ?? '', b.listenIp ?? '', desc);
      case 'port':
        return compareNum(a.port, b.port, desc);
      case 'ips':
        return compareNum(a.ips, b.ips, desc);
      case 'conns':
        return compareNum(a.conns, b.conns, desc);
      case 'up':
        return compareNum(a.txPerSec, b.txPerSec, desc);
      case 'down':
        return compareNum(a.rxPerSec, b.rxPerSec, desc);
    }
  };
  // 一样的再按端口、PID 排，刷新时行不会来回跳
  return [...rows].sort((a, b) => cmp(a, b) || compareNum(a.port, b.port, false) || compareNum(a.pid, b.pid, false));
}

/** 网络页一行的身份：选中的行刷新后还能认出来 */
export function socketRowKey(r: SocketRow): string {
  return `${r.pid ?? '-'}|${r.listenIp ?? '-'}|${r.port ?? '-'}|${r.name}`;
}
