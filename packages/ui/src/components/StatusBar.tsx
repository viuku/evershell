import type { MonitorStore, SessionInfo, SessionStatus } from '../core/session-manager';
import { useMaybeStore } from '../core/store';

const STATUS_TEXT: Record<SessionStatus, string> = {
  connecting: '连接中…',
  connected: '已连接',
  closed: '连接已断开',
  error: '连接失败',
};

/** 底部状态条：连接信息、编码、终端尺寸、延迟 */
export function StatusBar({ session, monitor }: { session: SessionInfo | null; monitor: MonitorStore | null }) {
  const state = useMaybeStore(monitor);
  const latency = session?.status === 'connected' ? state?.snapshot?.latencyMs : undefined;

  if (!session) {
    return (
      <footer className="footer">
        <span className="footer__status">
          <span className="footer__dot" />
          <span className="muted">未连接</span>
        </span>
      </footer>
    );
  }

  const where = `${session.user}@${session.host}${session.port === 22 ? '' : `:${session.port}`}`;
  const detail =
    (session.status === 'error' || session.status === 'closed') && session.error
      ? session.error
      : session.status === 'closed' && session.exitCode !== null
        ? `退出码 ${session.exitCode}`
        : null;

  return (
    <footer className="footer">
      <span className="footer__status">
        <span className={`footer__dot footer__dot--${session.status}`} />
        {STATUS_TEXT[session.status]} · {where}
        {detail && <span className="muted ellipsis footer__detail" title={detail}>{` · ${detail}`}</span>}
      </span>
      <span>UTF-8</span>
      <span>
        xterm-256color · {session.cols}×{session.rows}
      </span>
      <span className="footer__right" title={session.fingerprint ? `服务器指纹 ${session.fingerprint}` : undefined}>
        {latency != null ? `延迟 ${Math.round(latency)} ms` : ''}
      </span>
    </footer>
  );
}
