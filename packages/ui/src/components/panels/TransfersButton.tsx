import { useEffect, useRef, useState } from 'react';
import { formatBytesLong, formatEta, formatRate } from '../../core/format';
import { useStore } from '../../core/store';
import { clearFinishedTransfers, transfersStore, type TransferItem } from '../../core/transfers-store';

function statusText(t: TransferItem): string {
  if (t.status === 'done') return `已完成 · ${formatBytesLong(t.total)}`;
  if (t.status === 'error') return `失败 · ${t.error ?? ''}`;
  const pct = t.total > 0 ? Math.floor((t.done / t.total) * 100) : 0;
  const eta = t.speed > 0 ? formatEta((t.total - t.done) / t.speed) : '';
  return [`${pct}%`, t.speed > 0 ? formatRate(t.speed) : '', eta].filter(Boolean).join(' · ');
}

/** 按钮上的字：正在传的数量和总进度；都传完了只写“传输”，有失败的带上 */
function summary(list: TransferItem[]): { label: string; pct: number | null; failed: number } {
  const running = list.filter((t) => t.status === 'running');
  const failed = list.filter((t) => t.status === 'error').length;
  if (running.length === 0) return { label: failed > 0 ? `传输 · ${failed} 个失败` : '传输', pct: null, failed };
  const done = running.reduce((n, t) => n + t.done, 0);
  const total = running.reduce((n, t) => n + t.total, 0);
  const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
  const ups = running.filter((t) => t.dir === 'up').length;
  const verb = ups === running.length ? '上传' : ups === 0 ? '下载' : '传输';
  return { label: `${verb} ${running.length} 个 · ${pct}%`, pct, failed };
}

/**
 * 文件工具栏右边的传输按钮：有上传下载时出现，显示总进度；点开是传输列表。
 * 原来底栏单独的「传输」页（FinalShell 没有这一页）
 */
export function TransfersButton() {
  const list = useStore(transfersStore);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (list.length === 0) return null;
  const s = summary(list);
  const finished = list.some((t) => t.status !== 'running');

  return (
    <div ref={ref} className="xfer-btn">
      <span className="files__sep" aria-hidden="true" />
      <button
        type="button"
        className={`btn${s.failed > 0 && s.pct === null ? ' xfer-btn--failed' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        {s.label}
        {s.pct !== null && (
          <span className="xfer__track xfer-btn__track" aria-hidden="true">
            <span className="xfer__fill" style={{ width: `${s.pct}%` }} />
          </span>
        )}
      </button>
      {open && (
        <div role="dialog" aria-label="传输" className="xfer-pop">
          <div className="xfer-pop__head">
            <strong>传输</strong>
            <button type="button" className="btn" disabled={!finished} onClick={clearFinishedTransfers}>
              清除已完成
            </button>
          </div>
          <div className="scroll xfer-pop__list">
            {list.map((t) => {
              const pct = t.status === 'done' ? 100 : t.total > 0 ? (t.done / t.total) * 100 : 0;
              return (
                <div key={t.id} className="grid-row xfer__cols xfer__row">
                  <span className={t.dir === 'up' ? 'xfer__up' : 'xfer__down'}>{t.dir === 'up' ? '↑' : '↓'}</span>
                  <span className="ellipsis" title={t.name}>
                    {t.name}
                  </span>
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
            })}
          </div>
        </div>
      )}
    </div>
  );
}
