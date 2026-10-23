import { useMemo, useState } from 'react';
import { formatBytes } from '../../core/format';
import { nextSort, procTableSort, sortProcTable, type ProcKey } from '../../core/monitor-tables';
import { useStore } from '../../core/store';
import type { ProcDetail } from '../../types';
import { SortHead } from './InfoTabView';

/** 进程页：服务器上的全部进程，表头点着排序，点一行选中 */
export function ProcessTab({ procs }: { procs: ProcDetail[] | null }) {
  const sort = useStore(procTableSort);
  const [selected, setSelected] = useState<number | null>(null);
  const rows = useMemo(() => (procs ? sortProcTable(procs, sort) : null), [procs, sort]);
  const onSort = (key: ProcKey) => procTableSort.set((cur) => nextSort(cur, key));

  return (
    <div className="info-table scroll">
      <div className="info-table__head procs-cols">
        <SortHead label="PID" by="pid" sort={sort} onSort={onSort} end />
        <SortHead label="用户" by="user" sort={sort} onSort={onSort} />
        <SortHead label="内存" by="mem" sort={sort} onSort={onSort} end />
        <SortHead label="CPU" by="cpu" sort={sort} onSort={onSort} end />
        <SortHead label="名称 · 命令行" by="name" sort={sort} onSort={onSort} />
        <SortHead label="位置" by="exe" sort={sort} onSort={onSort} />
      </div>
      {!rows ? (
        <div className="empty">读取中…</div>
      ) : (
        rows.map((p) => {
          const on = p.pid === selected;
          const cmd = p.cmdline && p.cmdline !== p.name ? p.cmdline : '';
          return (
            <button
              key={p.pid}
              type="button"
              className={`grid-row info-row procs-cols${on ? ' grid-row--on' : ''}`}
              aria-selected={on}
              onClick={() => setSelected(p.pid)}
            >
              <span className="num">{p.pid}</span>
              <span className="ellipsis">{p.user || '-'}</span>
              <span className="num">{formatBytes(p.memBytes)}</span>
              <span className="num">{p.cpuPercent.toFixed(1)}</span>
              <span className="ellipsis" title={cmd || p.name}>
                {p.name}
                {cmd && <span className="muted info-row__cmd">{cmd}</span>}
              </span>
              <span className="ellipsis muted" title={p.exe || undefined}>
                {p.exe}
              </span>
            </button>
          );
        })
      )}
    </div>
  );
}
