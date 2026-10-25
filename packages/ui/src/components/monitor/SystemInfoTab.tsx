import { Fragment, useEffect, type ReactNode } from 'react';
import { formatBytesLong, formatLoad, formatRateLong, formatUptime } from '../../core/format';
import type { SessionInfo, SessionManager } from '../../core/session-manager';
import { useMaybeStore } from '../../core/store';
import type { CpuDetail, MonitorSnapshot } from '../../types';

interface Props {
  manager: SessionManager;
  session: SessionInfo;
  snap: MonitorSnapshot | null;
}

/** CPU 占用各项的名字和解释。FinalShell 把最后一项写成「实时」，其实是 top 里的 st */
const CPU_PARTS: [keyof CpuDetail, string, string][] = [
  ['user', '用户', '用户态程序占用的 CPU 时间'],
  ['system', '系统', '内核占用的 CPU 时间'],
  ['nice', 'Nice', '低优先级程序占用的 CPU 时间'],
  ['idle', '空闲', 'CPU 处于空闲状态的时间'],
  ['iowait', 'IO 等待', '等待磁盘读写的时间'],
  ['irq', '硬件中断', '处理硬件中断的时间'],
  ['softirq', '软件中断', '处理软件中断的时间，网络流量大时会升高'],
  ['steal', '被抢占', '虚拟机的 CPU 被宿主机调度给其他虚拟机的时间（即 top 中的 st）；长期偏高说明该 VPS 存在超售'],
];

/**
 * 系统信息页：发行版、内核、CPU 型号这些不怎么变的打开时取一次（重连后重取），
 * CPU 占用、内存、网卡、磁盘跟着每次采样刷新
 */
export function SystemInfoTab({ manager, session, snap }: Props) {
  const sys = useMaybeStore(manager.getSystemInfo(session.id));
  const connected = session.status === 'connected';
  // 只在还没取过时自动取；失败了让用户点「重试」，免得服务器一直出错时反复去取
  useEffect(() => {
    if (connected && sys?.status === 'idle') manager.loadSystemInfo(session.id);
  }, [manager, session.id, connected, sys?.status]);

  const info = sys?.status === 'ok' ? sys.info : null;
  const pending = sys?.status === 'loading' || (connected && sys?.status === 'idle') ? '正在读取…' : '-';
  const live = snap?.supported ? snap : null;

  return (
    <div className="sysinfo-page scroll">
      {sys?.status === 'error' && (
        <div role="alert" className="inline-error sysinfo-page__error">
          <span className="ellipsis">读取系统信息失败：{sys.message}</span>
          <button type="button" className="btn btn--xs" disabled={!connected} onClick={() => manager.loadSystemInfo(session.id)}>
            重试
          </button>
        </div>
      )}
      <Section>
        <Pair k="操作系统" v={info ? info.os || '-' : pending} />
        <Pair k="内核" v={info ? info.kernel || '-' : pending} />
        <Pair k="内核版本" v={info ? info.kernelRelease || '-' : pending} />
        <Pair k="硬件架构" v={info ? info.arch || '-' : pending} />
        <Pair k="主机名称" v={info ? info.hostname || '-' : pending} />
        <Pair k="运行时间" v={live ? formatUptime(live.uptimeSecs) : '-'} />
        <Pair k="负载" v={live ? `${formatLoad(live.load)}（1 分钟、5 分钟、15 分钟）` : '-'} />
      </Section>

      {snap && !snap.supported && (
        <Section>
          <span className="sysinfo__k">监控</span>
          <span className="muted">暂不支持该系统的监控，无法显示以下 CPU、内存、网卡和磁盘信息</span>
        </Section>
      )}

      <Section label="CPU">
        <div className="sysinfo__table sysinfo__table--cpu">
          <span className="sysinfo__th">型号</span>
          <span className="sysinfo__th" title="主板上安装的 CPU 数量；虚拟机中为虚拟 CPU 的数量">
            颗数
          </span>
          <span className="sysinfo__th" title="每颗 CPU 的核心数">
            每颗核心
          </span>
          <span className="sysinfo__th" title="可同时运行的任务数，即 top 中显示的 CPU 数量；VPS 所说的「几核」通常指此项">
            线程数
          </span>
          <span className="sysinfo__th">频率</span>
          <span className="sysinfo__th">缓存</span>
          <span className="sysinfo__th">BogoMips</span>
          {info && info.cpus.length > 0 ? (
            info.cpus.map((c, i) => (
              <Fragment key={i}>
                <span className="ellipsis" title={c.model}>
                  {c.model || '-'}
                </span>
                <span>{c.sockets ?? '-'}</span>
                <span>{c.coresPerSocket ?? '-'}</span>
                <span>{c.threads}</span>
                <span>{c.mhz === null ? '-' : `${Math.round(c.mhz)} MHz`}</span>
                <span>{c.cache ?? '-'}</span>
                <span>{c.bogomips === null ? '-' : c.bogomips.toFixed(2)}</span>
              </Fragment>
            ))
          ) : (
            <span className="sysinfo__full muted">{info ? '-' : pending}</span>
          )}
        </div>
      </Section>

      <Section label="CPU 占用">
        <div className="sysinfo__table sysinfo__table--parts">
          {CPU_PARTS.map(([key, label, tip]) => (
            <span key={key} className="sysinfo__th" title={tip}>
              {label}
            </span>
          ))}
          {CPU_PARTS.map(([key]) => (
            <span key={key}>{live?.cpuDetail ? `${live.cpuDetail[key].toFixed(1)}%` : '-'}</span>
          ))}
        </div>
      </Section>

      <Section>
        <Usage label="内存" total={live?.memTotal} used={live?.memUsed} />
        <Usage label="交换" total={live?.swapTotal} used={live?.swapUsed} />
      </Section>

      <Section label="网络接口">
        <div className="sysinfo__table sysinfo__table--ifaces">
          <span className="sysinfo__th">名称</span>
          <span className="sysinfo__th">已发送</span>
          <span className="sysinfo__th">已接收</span>
          <span className="sysinfo__th">发送速度</span>
          <span className="sysinfo__th">接收速度</span>
          {live && live.ifaces.length > 0 ? (
            live.ifaces.map((n) => (
              <Fragment key={n.iface}>
                <span className="ellipsis">{n.iface}</span>
                <span>{formatBytesLong(n.txBytes)}</span>
                <span>{formatBytesLong(n.rxBytes)}</span>
                <span>{formatRateLong(n.txPerSec)}</span>
                <span>{formatRateLong(n.rxPerSec)}</span>
              </Fragment>
            ))
          ) : (
            <span className="sysinfo__full muted">-</span>
          )}
        </div>
      </Section>

      <Section label="磁盘">
        <div className="sysinfo__table sysinfo__table--disks">
          <span className="sysinfo__th">挂载点</span>
          <span className="sysinfo__th">设备</span>
          <span className="sysinfo__th">类型</span>
          <span className="sysinfo__th">大小</span>
          <span className="sysinfo__th">已用</span>
          <span className="sysinfo__th">可用</span>
          <span className="sysinfo__th">使用率</span>
          {live && live.disks.length > 0 ? (
            live.disks.map((d) => {
              const pct = d.size ? Math.round((d.used / d.size) * 100) : 0;
              return (
                <Fragment key={d.mount}>
                  <span className="ellipsis" title={d.mount}>
                    {d.mount}
                  </span>
                  <span className="ellipsis" title={d.device}>
                    {d.device || '-'}
                  </span>
                  <span>{d.fsType || '-'}</span>
                  <span>{formatBytesLong(d.size)}</span>
                  <span>{formatBytesLong(d.used)}</span>
                  <span>{formatBytesLong(d.avail)}</span>
                  <span className={pct >= 80 ? 'warn' : undefined}>{pct}%</span>
                </Fragment>
              );
            })
          ) : (
            <span className="sysinfo__full muted">-</span>
          )}
        </div>
      </Section>

      <Section>
        <Pair k="登录" v={`${session.user}@${session.host}:${session.port}`} />
        <Pair k="服务器指纹" v={session.fingerprint ?? '-'} mono />
      </Section>
    </div>
  );
}

/** 一节：左边一列标题（可以没有），右边内容；节之间一条细线 */
function Section({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <section className={`sysinfo__sec${label ? ' sysinfo__sec--labeled' : ''}`}>
      {label && <span className="sysinfo__k">{label}</span>}
      {label ? <div>{children}</div> : children}
    </section>
  );
}

function Pair({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <>
      <span className="sysinfo__k">{k}</span>
      <span className={mono ? 'mono' : undefined}>{v}</span>
    </>
  );
}

function Usage({ label, total, used }: { label: string; total?: number; used?: number }) {
  if (total === undefined || used === undefined) return <Pair k={label} v="-" />;
  if (total === 0) return <Pair k={label} v={label === '交换' ? '无交换分区' : '-'} />;
  return (
    <>
      <span className="sysinfo__k">{label}</span>
      <div className="sysinfo__usage">
        <span>{formatBytesLong(total)}</span>
        <span>已用 {formatBytesLong(used)}</span>
        <span>{Math.round((used / total) * 100)}%</span>
        <span>剩余 {formatBytesLong(total - used)}</span>
      </div>
    </>
  );
}
