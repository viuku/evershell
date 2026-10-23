import { describe, expect, it } from 'vitest';
import type { MonitorSnapshot } from '../../types';
import { MonitorStore, NET_SAMPLES } from '../session-manager';

function snap(net: Record<string, [rx: number, tx: number]>): MonitorSnapshot {
  return {
    supported: true,
    uptimeSecs: 0,
    load: [0, 0, 0],
    cpuPercent: 0,
    cpuCores: 1,
    memTotal: 0,
    memUsed: 0,
    swapTotal: 0,
    swapUsed: 0,
    net: Object.entries(net).map(([iface, [rxPerSec, txPerSec]]) => ({ iface, rxPerSec, txPerSec })),
    procs: [],
    disks: [],
    latencyMs: 10,
  };
}

describe('MonitorStore 网速', () => {
  it('不选网卡时画所有网卡相加', () => {
    const m = new MonitorStore();
    m.push(snap({ eth0: [100, 10], eth1: [1, 2] }));
    expect(m.get().net).toEqual([{ rx: 101, tx: 12 }]);
  });

  it('换网卡不清空，直接画这块网卡之前的数据', () => {
    const m = new MonitorStore();
    m.push(snap({ eth0: [100, 10], eth1: [1, 2] }));
    m.push(snap({ eth0: [200, 20], eth1: [3, 4] }));
    m.setIface('eth1');
    expect(m.get().net).toEqual([
      { rx: 1, tx: 2 },
      { rx: 3, tx: 4 },
    ]);
    m.push(snap({ eth0: [300, 30], eth1: [5, 6] }));
    m.setIface(null);
    expect(m.get().net).toEqual([
      { rx: 101, tx: 12 },
      { rx: 203, tx: 24 },
      { rx: 305, tx: 36 },
    ]);
  });

  it('换网卡不算新采样，柱子编号不变', () => {
    const m = new MonitorStore();
    m.push(snap({ eth0: [1, 1], eth1: [2, 2] }));
    m.push(snap({ eth0: [1, 1], eth1: [2, 2] }));
    m.setIface('eth0');
    expect(m.get().netTotal).toBe(2);
  });

  it('那块网卡某次没出现，那一次记 0', () => {
    const m = new MonitorStore();
    m.push(snap({ eth0: [100, 10] }));
    m.push(snap({ eth0: [200, 20], docker0: [7, 8] }));
    m.setIface('docker0');
    expect(m.get().net).toEqual([
      { rx: 0, tx: 0 },
      { rx: 7, tx: 8 },
    ]);
  });

  it('选中的网卡消失后改回所有网卡相加', () => {
    const m = new MonitorStore();
    m.push(snap({ eth0: [100, 10], wg0: [5, 5] }));
    m.setIface('wg0');
    m.push(snap({ eth0: [200, 20] }));
    expect(m.get().iface).toBeNull();
    expect(m.get().net).toEqual([
      { rx: 105, tx: 15 },
      { rx: 200, tx: 20 },
    ]);
  });

  it('只留图上的格数再多一个', () => {
    const m = new MonitorStore();
    for (let i = 0; i < NET_SAMPLES + 5; i++) m.push(snap({ eth0: [i, i] }));
    const { net, netTotal } = m.get();
    expect(net).toHaveLength(NET_SAMPLES + 1);
    expect(net.at(-1)).toEqual({ rx: NET_SAMPLES + 4, tx: NET_SAMPLES + 4 });
    expect(netTotal).toBe(NET_SAMPLES + 5);
  });
});
