import { useEffect, useRef, useState } from 'react';
import type { SessionInfo, SessionManager } from '../../core/session-manager';
import { followTerminalDir } from '../../core/settings';
import { PersistentStore } from '../../core/storage';
import { useStore } from '../../core/store';
import { Segmented } from '../common/Segmented';
import { CommandsPanel } from './CommandsPanel';
import { FilesPanel } from './FilesPanel';

export type BottomTab = 'files' | 'commands';

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

/** 终端下方的两个分页：文件 / 命令 */
export function BottomPanels({ manager, session, tab, onTab }: Props) {
  const follow = useStore(followTerminalDir);
  const height = useStore(bottomHeight);
  const files = manager.getFiles(session.status === 'connected' ? session.id : null);

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
            { id: 'commands', label: '命令' },
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
      {tab === 'commands' && <CommandsPanel manager={manager} session={session} />}
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
