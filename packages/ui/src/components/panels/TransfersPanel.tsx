import { useState } from 'react';
import { formatBytesLong, formatEta, formatRate } from '../../core/format';
import { useStore } from '../../core/store';
import { clearFinishedTransfers, transfersStore, type TransferItem } from '../../core/transfers-store';
import { ContextMenu, type ContextMenuState } from '../common/Menu';

function statusText(t: TransferItem): string {
  if (t.status === 'done') return `已完成 · ${formatBytesLong(t.total)}`;
  if (t.status === 'error') return `失败 · ${t.error ?? ''}`;
  const pct = t.total > 0 ? Math.floor((t.done / t.total) * 100) : 0;
  const eta = t.speed > 0 ? formatEta((t.total - t.done) / t.speed) : '';
  return [`${pct}%`, t.speed > 0 ? formatRate(t.speed) : '', eta].filter(Boolean).join(' · ');
}

/** 传输队列：上传下载的进度和状态 */
export function TransfersPanel() {
  const list = useStore(transfersStore);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const finished = list.some((t) => t.status !== 'running');

  return (
    <div
      className="scroll xfer"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, items: [{ label: '清除已完成', disabled: !finished, onSelect: clearFinishedTransfers }] });
      }}
    >
      <div className="xfer__inner">
        <div className="grid-head xfer__cols">
          <span />
          <span>文件</span>
          <span>路径</span>
          <span>进度</span>
          <span>状态</span>
        </div>
        {list.length === 0 ? (
          <div className="empty">没有传输任务。在「文件」里上传或下载后会显示在这里</div>
        ) : (
          list.map((t) => {
            const pct = t.status === 'done' ? 100 : t.total > 0 ? (t.done / t.total) * 100 : 0;
            return (
              <div key={t.id} className="grid-row xfer__cols xfer__row">
                <span className="muted">{t.dir === 'up' ? '↑' : '↓'}</span>
                <span className="ellipsis">{t.name}</span>
                <span className="mono muted ellipsis xfer__route" title={t.route}>
                  {t.route}
                </span>
                <span className="xfer__progress">
                  <span className="xfer__track">
                    <span className={`xfer__fill${t.status === 'error' ? ' xfer__fill--error' : ''}`} style={{ width: `${pct}%` }} />
                  </span>
                </span>
                <span className={`ellipsis ${t.status === 'error' ? 'xfer__error' : 'muted'}`} title={statusText(t)}>
                  {statusText(t)}
                </span>
              </div>
            );
          })
        )}
      </div>
      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
