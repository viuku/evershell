import { useState } from 'react';
import { formatBytes, formatLoad, formatPercent, formatRate, formatUptime, niceCeil, niceCeilBytes } from '../../core/format';
import { dragRegion } from '../../core/platform';
import { procSort, sortProcs, type ProcSort } from '../../core/procs';
import { NET_SAMPLES, PING_SAMPLES, type MonitorState, type MonitorStore, type SessionInfo } from '../../core/session-manager';
import { useMaybeStore, useStore } from '../../core/store';
import type { MonitorSnapshot } from '../../types';
import { SidebarToggle } from './SidebarToggle';
import { SystemInfoDialog } from './SystemInfoDialog';

interface Props {
  session: SessionInfo | null;
  monitor: MonitorStore | null;
  onToggleSidebar(): void;
  /** 顶部左边让出的宽度，给叠在窗口左上角的系统按钮 */
  leadingInset?: number;
}

/**
 * 左侧状态栏。只订阅当前会话的 MonitorStore，监控刷新时只有这里重绘。
 * 三种状态：没有会话 / 会话断开 / 已连接；已连接但服务器不支持采集时显示提示。
 */
export function MonitorSidebar({ session, monitor, onToggleSidebar, leadingInset }: Props) {
  const state = useMaybeStore(monitor);
  const connected = session?.status === 'connected';
  const snap = connected ? (state?.snapshot ?? null) : null;
  const [infoOpen, setInfoOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyIp = async () => {
    if (!session) return;
    try {
      await navigator.clipboard.writeText(session.host);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  return (
    <aside aria-label="服务器状态" className="sidebar scroll">
      <div className="sidebar__head" style={leadingInset ? { paddingLeft: leadingInset } : undefined} {...dragRegion}>
        <SidebarToggle onToggle={onToggleSidebar} />
      </div>
      <div className="sidebar__body">
        <div className="sidebar__row">
          <span>同步状态</span>
          <span className="sidebar__sync muted" title="云同步在后续版本提供">
            <span className="sidebar__dot" />
            本地
          </span>
        </div>
        <div className="sidebar__row">
          <span>IP</span>
          {session ? (
            <span className="sidebar__ip">
              <span className="mono sidebar__ipText" title={session.host}>
                {session.host}
              </span>
              <button type="button" className="btn btn--xs" onClick={copyIp}>
                {copied ? '已复制' : '复制'}
              </button>
            </span>
          ) : (
            <span className="muted">-</span>
          )}
        </div>
        <button type="button" className="btn sidebar__info" disabled={!snap} onClick={() => setInfoOpen(true)}>
          系统信息
        </button>

        {snap && !snap.supported ? (
          <>
            <div className="sidebar__unsupported">暂不支持该系统的监控</div>
            <Latency state={state} snap={snap} />
          </>
        ) : (
          <>
            <div className="sidebar__kv">
              <span>
                运行 <span className="muted">{snap ? formatUptime(snap.uptimeSecs) : '-'}</span>
              </span>
              <span>
                负载 <span className="muted mono sidebar__load">{snap ? formatLoad(snap.load) : '-'}</span>
              </span>
            </div>
            <div className="sidebar__meters">
              <Meter label="CPU" pct={snap?.cpuPercent ?? 0} used="" live={!!snap} />
              <Meter
                label="内存"
                pct={snap && snap.memTotal ? (snap.memUsed / snap.memTotal) * 100 : 0}
                used={snap ? `${formatBytes(snap.memUsed)}/${formatBytes(snap.memTotal)}` : '0/0'}
                live={!!snap}
              />
              <Meter
                label="交换"
                pct={snap && snap.swapTotal ? (snap.swapUsed / snap.swapTotal) * 100 : 0}
                used={snap ? `${formatBytes(snap.swapUsed)}/${formatBytes(snap.swapTotal)}` : '0/0'}
                live={!!snap}
              />
            </div>
            <Procs snap={snap} session={session} />
            <Net state={state} snap={snap} monitor={monitor} />
            <Latency state={state} snap={snap} />
            <Disks snap={snap} />
          </>
        )}
      </div>
      {infoOpen && session && snap && <SystemInfoDialog session={session} snap={snap} onClose={() => setInfoOpen(false)} />}
    </aside>
  );
}

function Meter({ label, pct, used, live }: { label: string; pct: number; used: string; live: boolean }) {
  const p = Math.max(0, Math.min(100, pct));
  const warn = p >= 85;
  return (
    <div className="meter">
      <span>{label}</span>
      <div className="meter__track">
        {live && <div className={`meter__fill${warn ? ' meter__fill--warn' : ''}`} style={{ width: `${p}%` }} />}
        <div className={`meter__text${live ? '' : ' muted'}`}>
          <span>{formatPercent(p)}</span>
          <span>{used}</span>
        </div>
      </div>
    </div>
  );
}

function Procs({ snap, session }: { snap: MonitorSnapshot | null; session: SessionInfo | null }) {
  const sort = useStore(procSort);
  const placeholder = !session
    ? '未连接'
    : session.status === 'connecting'
      ? '连接中…'
      : session.status === 'connected'
        ? '采集中…'
        : '会话已断开';
  return (
    <div className="sidebar__table">
      <div className="sidebar__th sidebar__th--procs">
        <SortHeader label="内存" by="mem" sort={sort} />
        <SortHeader label="CPU" by="cpu" sort={sort} />
        <span>命令</span>
      </div>
      {snap && snap.procs.length > 0 ? (
        sortProcs(snap.procs, sort).map((p) => (
          <div key={p.pid} className="sidebar__tr sidebar__tr--procs mono">
            <span>{formatBytes(p.memBytes)}</span>
            <span>{p.cpuPercent.toFixed(1)}</span>
            <span className="ellipsis">{p.name}</span>
          </div>
        ))
      ) : (
        <div className="sidebar__placeholder">{placeholder}</div>
      )}
    </div>
  );
}

/** 进程表能点的表头：点了按这列从高到低排，选中的那列字变亮、带小箭头 */
function SortHeader({ label, by, sort }: { label: string; by: ProcSort; sort: ProcSort }) {
  const on = sort === by;
  return (
    <button
      type="button"
      className={`sidebar__sort${on ? ' sidebar__sort--on' : ''}`}
      aria-pressed={on}
      title={`按${label}从高到低排`}
      onClick={() => procSort.set(by)}
    >
      {label}
      {on && (
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <polyline points="1.5,3 4,5.5 6.5,3" />
        </svg>
      )}
    </button>
  );
}

function Net({ state, snap, monitor }: { state: MonitorState | null; snap: MonitorSnapshot | null; monitor: MonitorStore | null }) {
  const samples = snap ? (state?.net ?? []) : [];
  const last = samples[samples.length - 1];
  const max = niceCeilBytes(Math.max(1024, ...samples.map((s) => Math.max(s.rx, s.tx))));
  const ifaces = snap?.net.map((n) => n.iface) ?? [];
  return (
    <div className="sidebar__chart">
      <div className="sidebar__chartHead mono">
        <span>
          <span className="up">↑</span>
          {last ? formatRate(last.tx) : '0B/s'}
          {'  '}
          <span className="down">↓</span>
          {last ? formatRate(last.rx) : '0B/s'}
        </span>
        {ifaces.length > 0 ? (
          <>
            <label htmlFor="nic" className="sr-only">
              网卡
            </label>
            <select
              id="nic"
              className="sidebar__nic"
              value={state?.iface ?? ''}
              onChange={(e) => monitor?.setIface(e.target.value || null)}
            >
              <option value="">全部</option>
              {ifaces.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </>
        ) : (
          <span className="muted sidebar__nicText">网卡 ▾</span>
        )}
      </div>
      {snap ? (
        <div className="sidebar__netPlot">
          <div className="sidebar__axis mono">
            <span>{formatBytes(max)}</span>
            <span>{formatBytes(max / 2)}</span>
            <span>0</span>
          </div>
          <div className="sidebar__bars grid-bg" aria-hidden="true">
            {Array.from({ length: NET_SAMPLES }, (_, i) => {
              const s = samples[i - (NET_SAMPLES - samples.length)];
              return (
                <div key={i} className="sidebar__barPair">
                  <div className="sidebar__bar up" style={{ height: s ? `${Math.max(2, (s.tx / max) * 100)}%` : 0 }} />
                  <div className="sidebar__bar down" style={{ height: s ? `${Math.max(2, (s.rx / max) * 100)}%` : 0 }} />
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="sidebar__emptyPlot sidebar__emptyPlot--net" />
      )}
    </div>
  );
}

function Latency({ state, snap }: { state: MonitorState | null; snap: MonitorSnapshot | null }) {
  const samples = snap ? (state?.ping ?? []) : [];
  const max = niceCeil(Math.max(10, ...samples));
  const latency = snap?.latencyMs;
  return (
    <div className="sidebar__chart">
      <div className="sidebar__chartHead">
        <span className={snap ? '' : 'muted'}>{latency == null ? '延迟 -- ms' : `${Math.round(latency)} ms`}</span>
        <span className="muted">本机 → 服务器</span>
      </div>
      {snap ? (
        <div className="sidebar__bars sidebar__bars--ping grid-bg" aria-hidden="true">
          {Array.from({ length: PING_SAMPLES }, (_, i) => {
            const v = samples[i - (PING_SAMPLES - samples.length)];
            return <div key={i} className="sidebar__bar accent" style={{ height: v ? `${Math.max(3, (v / max) * 100)}%` : 0 }} />;
          })}
        </div>
      ) : (
        <div className="sidebar__emptyPlot sidebar__emptyPlot--ping" />
      )}
    </div>
  );
}

function Disks({ snap }: { snap: MonitorSnapshot | null }) {
  return (
    <div className="sidebar__table">
      <div className="sidebar__th sidebar__th--disks">
        <span>路径</span>
        <span>可用 / 大小</span>
      </div>
      {snap && snap.disks.length > 0 ? (
        snap.disks.map((d) => {
          const usedPct = d.size ? ((d.size - d.avail) / d.size) * 100 : 0;
          return (
            <div key={d.mount} className="sidebar__tr sidebar__tr--disks mono">
              <span className="ellipsis">{d.mount}</span>
              <span className={usedPct >= 80 ? 'warn' : ''}>
                {formatBytes(d.avail)} / {formatBytes(d.size)}
              </span>
            </div>
          );
        })
      ) : (
        <div className="sidebar__placeholder sidebar__placeholder--short" />
      )}
    </div>
  );
}
