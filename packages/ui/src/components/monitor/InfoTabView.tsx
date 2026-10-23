import type { InfoKind, MonitorStore, SessionInfo, SessionManager } from '../../core/session-manager';
import { useMaybeStore } from '../../core/store';
import { NetworkTab } from './NetworkTab';
import { ProcessTab } from './ProcessTab';
import { SystemInfoTab } from './SystemInfoTab';

interface Props {
  kind: InfoKind;
  manager: SessionManager;
  /** 这一页所属的会话 */
  session: SessionInfo;
  monitor: MonitorStore | null;
  onReconnect(): void;
}

const TITLE: Record<InfoKind, string> = { sysinfo: '系统信息', procs: '进程', net: '网络' };

/**
 * 信息页（系统信息 / 进程 / 网络）的外壳：会话没连着时顶上一条提示，数据停在断开时的样子；
 * 服务器不支持采集、还没采到数据时显示提示，否则交给各页
 */
export function InfoTabView({ kind, manager, session, monitor, onReconnect }: Props) {
  const state = useMaybeStore(monitor);
  const snap = state?.snapshot ?? null;
  const connected = session.status === 'connected';

  let body;
  if (kind === 'sysinfo') {
    body = <SystemInfoTab manager={manager} session={session} snap={snap} />;
  } else if (!snap) {
    body = <div className="empty">{connected ? '采集中…' : '没有数据'}</div>;
  } else if (!snap.supported) {
    body = <div className="empty">暂不支持该系统的监控</div>;
  } else {
    body = kind === 'procs' ? <ProcessTab procs={snap.allProcs} /> : <NetworkTab sockets={snap.sockets} />;
  }

  return (
    <section aria-label={`${TITLE[kind]} · ${session.name}`} className={`info-tab${connected ? '' : ' info-tab--stale'}`}>
      {!connected && (
        <div role="status" className="info-tab__banner">
          <span>{session.status === 'connecting' ? '正在连接…' : '连接已断开，下面是断开前的数据'}</span>
          {session.status !== 'connecting' && (
            <button type="button" className="btn btn--xs" onClick={onReconnect}>
              重新连接
            </button>
          )}
        </div>
      )}
      {body}
    </section>
  );
}

/** 能点的表头：点了按这列排，再点一次反过来；选中的那列字变亮、带小箭头 */
export function SortHead<K extends string>({
  label,
  by,
  sort,
  onSort,
  end,
}: {
  label: string;
  by: K;
  sort: { key: K; desc: boolean };
  onSort(key: K): void;
  /** 数字列靠右 */
  end?: boolean;
}) {
  const on = sort.key === by;
  return (
    <button
      type="button"
      className={`info-sort${on ? ' info-sort--on' : ''}${end ? ' info-sort--end' : ''}`}
      aria-pressed={on}
      title={`按${label}排序，再点一次反过来`}
      onClick={() => onSort(by)}
    >
      {label}
      {on && (
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <polyline points={sort.desc ? '1.5,3 4,5.5 6.5,3' : '1.5,5 4,2.5 6.5,5'} />
        </svg>
      )}
    </button>
  );
}
