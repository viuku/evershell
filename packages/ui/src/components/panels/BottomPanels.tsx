import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionInfo, SessionManager } from '../../core/session-manager';
import { followTerminalDir } from '../../core/settings';
import { PersistentStore } from '../../core/storage';
import { useStore } from '../../core/store';
import { transfersStore } from '../../core/transfers-store';
import { Segmented } from '../common/Segmented';
import { FilesPanel } from './FilesPanel';
import { HistoryPanel } from './HistoryPanel';
import { SnippetsPanel } from './SnippetsPanel';
import { TransfersPanel } from './TransfersPanel';

export type BottomTab = 'files' | 'snippets' | 'history' | 'transfers';

/** 底部面板高度，拖动分隔条可调 */
const bottomHeight = new PersistentStore<number>('evershell.bottom-height', 280, (raw, fb) =>
  typeof raw === 'number' && raw >= 120 && raw <= 900 ? raw : fb,
);

interface Props {
  manager: SessionManager;
  session: SessionInfo;
  tab: BottomTab;
  onTab(tab: BottomTab): void;
}

/** 终端下方的四个分页：文件 / 快捷命令 / 历史命令 / 传输 */
export function BottomPanels({ manager, session, tab, onTab }: Props) {
  const follow = useStore(followTerminalDir);
  const height = useStore(bottomHeight);
  const transfers = useStore(transfersStore);
  const running = transfers.filter((t) => t.status === 'running').length;
  const files = manager.getFiles(session.status === 'connected' ? session.id : null);

  const sendCurrent = useCallback((cmd: string) => manager.sendCommand(session.id, cmd), [manager, session.id]);
  const sendAll = useCallback((cmd: string) => manager.sendToAll(cmd), [manager]);

  return (
    <section aria-label="文件与命令" className="bottom" style={{ flexBasis: height, height }}>
      <Splitter onResize={(h) => bottomHeight.set(h)} />
      <div className="bottom__bar">
        <Segmented<BottomTab>
          ariaLabel="底部面板"
          value={tab}
          onChange={onTab}
          options={[
            { id: 'files', label: '文件' },
            { id: 'snippets', label: '快捷命令' },
            { id: 'history', label: '历史命令' },
            { id: 'transfers', label: running > 0 ? `传输 (${running})` : '传输' },
          ]}
        />
        {tab === 'files' && (
          <label className="check bottom__follow muted">
            <input type="checkbox" checked={follow} onChange={(e) => followTerminalDir.set(e.target.checked)} />
            跟随终端目录
          </label>
        )}
      </div>
      {tab === 'files' && <FilesPanel files={files} session={session} follow={follow} />}
      {tab === 'snippets' && <SnippetsPanel onSend={sendCurrent} onSendAll={sendAll} />}
      {tab === 'history' && <HistoryPanel onSend={sendCurrent} />}
      {tab === 'transfers' && <TransfersPanel />}
    </section>
  );
}

/** 面板顶部的拖动条 */
function Splitter({ onResize }: { onResize(height: number): void }) {
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ y: number; h: number } | null>(null);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      if (!start.current) return;
      const h = Math.max(120, Math.min(window.innerHeight - 260, start.current.h + (start.current.y - e.clientY)));
      onResize(h);
    };
    const up = () => setDragging(false);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging, onResize]);

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="调整面板高度"
      className={`splitter${dragging ? ' splitter--on' : ''}`}
      onMouseDown={(e) => {
        const section = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
        start.current = { y: e.clientY, h: section.height };
        setDragging(true);
      }}
    />
  );
}
