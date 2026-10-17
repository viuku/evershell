import { useState } from 'react';
import { formatClock } from '../../core/format';
import { clearHistory, historyStore } from '../../core/history-store';
import { useStore } from '../../core/store';
import { useDialogs } from '../common/Dialogs';
import { ContextMenu, type ContextMenuState } from '../common/Menu';

/** 历史命令：命令栏和快捷命令发出的记录，可再次发送 */
export function HistoryPanel({ onSend }: { onSend(cmd: string): boolean }) {
  const list = useStore(historyStore);
  const dialogs = useDialogs();
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const clear = async () => {
    const ok = await dialogs.confirm({ title: '清空历史命令', message: '确定要清空全部历史命令吗？', okText: '清空', danger: true });
    if (ok) clearHistory();
  };

  return (
    <div
      className="scroll hist"
      onContextMenu={(e) => {
        if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains('hist__inner')) return;
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, items: [{ label: '清空历史…', danger: true, disabled: list.length === 0, onSelect: () => void clear() }] });
      }}
    >
      <div className="hist__inner">
        <div className="grid-head hist__cols">
          <span>时间</span>
          <span>命令</span>
          <span>会话</span>
          <span />
        </div>
        {list.length === 0 ? (
          <div className="empty">还没有历史命令。命令栏和快捷命令发出的命令会记录在这里</div>
        ) : (
          list.map((h) => (
            <div
              key={h.id}
              className="grid-row hist__cols hist__row"
              onDoubleClick={() => onSend(h.cmd)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenu({
                  x: e.clientX,
                  y: e.clientY,
                  items: [
                    { label: '再次发送', onSelect: () => void onSend(h.cmd) },
                    { label: '复制命令', onSelect: () => void navigator.clipboard.writeText(h.cmd).catch(() => {}) },
                    { type: 'separator' },
                    { label: '清空历史…', danger: true, onSelect: () => void clear() },
                  ],
                });
              }}
            >
              <span className="muted">{formatClock(h.at)}</span>
              <code className="mono ellipsis hist__cmd" title={h.cmd}>
                {h.cmd}
              </code>
              <span className="muted ellipsis">{h.target}</span>
              <button type="button" className="btn btn--row hist__send" onClick={() => onSend(h.cmd)}>
                再次发送
              </button>
            </div>
          ))
        )}
      </div>
      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}
