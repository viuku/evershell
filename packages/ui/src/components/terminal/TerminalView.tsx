import { useEffect, useRef } from 'react';
import type { SessionInfo, SessionManager } from '../../core/session-manager';
import { useStore } from '../../core/store';
import { terminalBgImage } from '../../core/terminal-appearance';

interface Props {
  manager: SessionManager;
  session: SessionInfo;
}

/** 把会话持有的 xterm 容器放进 DOM，跟随尺寸变化 fit。断线后重连走命令栏的闪电 */
export function TerminalView({ manager, session }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const bgImage = useStore(terminalBgImage);
  const id = session.id;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    manager.attach(id, host);

    // 拖窗口时事件很密，合并到下一帧再 fit
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => manager.fit(id));
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      manager.detach(id);
    };
  }, [manager, id]);

  return (
    <div className="term-wrap">
      {bgImage && <div className="term-bg" style={{ backgroundImage: `url(${bgImage})` }} aria-hidden="true" />}
      <div ref={hostRef} className="term-view" onMouseDown={() => manager.focus(id)} />
    </div>
  );
}
