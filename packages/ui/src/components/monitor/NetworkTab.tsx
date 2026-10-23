import { useMemo, useState } from 'react';
import { formatRateLong } from '../../core/format';
import { nextSort, socketRowKey, socketTableSort, sortSocketTable, type SocketKey } from '../../core/monitor-tables';
import { useStore } from '../../core/store';
import type { SocketTable } from '../../types';
import { SortHead } from './InfoTabView';

/**
 * 网络页：每个监听的地址和端口是哪个程序开的、连了几个 IP、几条连接、上传下载速度；
 * 主动连出去的连接按进程汇总成一行，监听 IP 和端口写「-」
 */
export function NetworkTab({ sockets }: { sockets: SocketTable | null }) {
  const sort = useStore(socketTableSort);
  const [selected, setSelected] = useState<string | null>(null);
  const rows = useMemo(() => (sockets ? sortSocketTable(sockets.rows, sort) : null), [sockets, sort]);
  const onSort = (key: SocketKey) => socketTableSort.set((cur) => nextSort(cur, key));
  const hidden = rows?.some((r) => r.pid === null) ?? false;

  if (sockets && !sockets.available) {
    return <div className="empty">服务器上没有 ss 命令，看不了网络连接（装上 iproute2 就有）</div>;
  }

  return (
    <div className="info-table scroll">
      <div className="info-table__head net-cols">
        <SortHead label="PID" by="pid" sort={sort} onSort={onSort} end />
        <SortHead label="名称" by="name" sort={sort} onSort={onSort} />
        <SortHead label="监听 IP" by="ip" sort={sort} onSort={onSort} />
        <SortHead label="端口" by="port" sort={sort} onSort={onSort} end />
        <SortHead label="IP 数" by="ips" sort={sort} onSort={onSort} end />
        <SortHead label="连接数" by="conns" sort={sort} onSort={onSort} end />
        <SortHead label="上传" by="up" sort={sort} onSort={onSort} end />
        <SortHead label="下载" by="down" sort={sort} onSort={onSort} end />
      </div>
      {hidden && <div className="info-table__note">不是用 root 登录，看不到别的用户开的端口属于哪个程序，这些行的 PID 和名称显示「-」</div>}
      {!rows ? (
        <div className="empty">读取中…</div>
      ) : rows.length === 0 ? (
        <div className="empty">没有监听的端口和连接</div>
      ) : (
        rows.map((r) => {
          const key = socketRowKey(r);
          const on = key === selected;
          return (
            <button
              key={key}
              type="button"
              className={`grid-row info-row net-cols${on ? ' grid-row--on' : ''}`}
              aria-selected={on}
              onClick={() => setSelected(key)}
            >
              <span className="num">{r.pid ?? '-'}</span>
              <span className="ellipsis">{r.name || '-'}</span>
              <span className="ellipsis">{r.listenIp ?? '-'}</span>
              <span className="num">{r.port ?? '-'}</span>
              <span className="num">{r.ips}</span>
              <span className="num">{r.conns}</span>
              <span className="num">{formatRateLong(r.txPerSec)}</span>
              <span className="num">{formatRateLong(r.rxPerSec)}</span>
            </button>
          );
        })
      )}
    </div>
  );
}
