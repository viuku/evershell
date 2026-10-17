import { formatBytes, formatLoad, formatUptime } from '../../core/format';
import type { SessionInfo } from '../../core/session-manager';
import type { MonitorSnapshot } from '../../types';
import { Modal } from '../common/Modal';

/** “系统信息”：把监控快照里能拿到的静态信息列出来 */
export function SystemInfoDialog({ session, snap, onClose }: { session: SessionInfo; snap: MonitorSnapshot; onClose(): void }) {
  const rows: [string, string][] = [
    ['主机', `${session.user}@${session.host}:${session.port}`],
    ['服务器指纹', session.fingerprint ?? '-'],
    ['运行时间', formatUptime(snap.uptimeSecs)],
    ['平均负载', formatLoad(snap.load)],
    ['CPU 核心', String(snap.cpuCores)],
    ['内存', `${formatBytes(snap.memUsed)} / ${formatBytes(snap.memTotal)}`],
    ['交换分区', snap.swapTotal ? `${formatBytes(snap.swapUsed)} / ${formatBytes(snap.swapTotal)}` : '无'],
    ['网卡', snap.net.map((n) => n.iface).join('、') || '-'],
    ['磁盘', snap.disks.map((d) => `${d.mount}（${formatBytes(d.avail)} 可用 / ${formatBytes(d.size)}）`).join('\n') || '-'],
  ];
  return (
    <Modal title={`系统信息 · ${session.name}`} onClose={onClose} width={440} tone="sheet">
      <div className="dialog-body">
        <dl className="sysinfo">
          {rows.map(([k, v]) => (
            <div key={k} className="sysinfo__row">
              <dt>{k}</dt>
              <dd className="mono">{v}</dd>
            </div>
          ))}
        </dl>
        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" data-autofocus onClick={onClose}>
            好
          </button>
        </div>
      </div>
    </Modal>
  );
}
