import { describe, expect, it } from 'vitest';
import { nextSort, sortProcTable, sortSocketTable } from '../monitor-tables';
import { pickGroupColor, GROUP_COLORS } from '../session-manager';
import type { ProcDetail, SocketRow } from '../../types';

const proc = (pid: number, user: string, memBytes: number, cpuPercent: number, exe = ''): ProcDetail => ({
  pid,
  user,
  name: `p${pid}`,
  cmdline: '',
  exe,
  memBytes,
  cpuPercent,
});

const sock = (pid: number | null, port: number | null, txPerSec: number, name = 'x'): SocketRow => ({
  pid,
  name,
  listenIp: port === null ? null : '0.0.0.0',
  port,
  ips: 0,
  conns: 0,
  txPerSec,
  rxPerSec: 0,
});

describe('nextSort', () => {
  it('点当前列就反过来', () => {
    expect(nextSort({ key: 'cpu', desc: true }, 'cpu')).toEqual({ key: 'cpu', desc: false });
  });

  it('换到数字列从高到低，换到文字列从小到大', () => {
    expect(nextSort({ key: 'user', desc: false }, 'mem')).toEqual({ key: 'mem', desc: true });
    expect(nextSort({ key: 'cpu', desc: true }, 'user')).toEqual({ key: 'user', desc: false });
  });
});

describe('sortProcTable', () => {
  const rows = [proc(3, 'root', 100, 0), proc(1, 'www', 300, 5), proc(2, '', 200, 0, '/usr/bin/a')];

  it('按 CPU 从高到低，一样的内存大的在前', () => {
    expect(sortProcTable(rows, { key: 'cpu', desc: true }).map((p) => p.pid)).toEqual([1, 2, 3]);
  });

  it('文字列空的总在最后', () => {
    expect(sortProcTable(rows, { key: 'user', desc: false }).map((p) => p.pid)).toEqual([3, 1, 2]);
    expect(sortProcTable(rows, { key: 'user', desc: true }).map((p) => p.pid)).toEqual([1, 3, 2]);
    expect(sortProcTable(rows, { key: 'exe', desc: false }).map((p) => p.pid)).toEqual([2, 1, 3]);
  });

  it('不改动传进来的数组', () => {
    const copy = [...rows];
    sortProcTable(rows, { key: 'pid', desc: false });
    expect(rows).toEqual(copy);
  });
});

describe('sortSocketTable', () => {
  it('看不到的 PID、主动连出去的端口排在最后', () => {
    const rows = [sock(null, 22, 10), sock(5, null, 30), sock(1, 80, 20)];
    expect(sortSocketTable(rows, { key: 'pid', desc: false }).map((r) => r.pid)).toEqual([1, 5, null]);
    expect(sortSocketTable(rows, { key: 'pid', desc: true }).map((r) => r.pid)).toEqual([5, 1, null]);
    expect(sortSocketTable(rows, { key: 'port', desc: false }).map((r) => r.port)).toEqual([22, 80, null]);
  });

  it('按上传从高到低，一样的按端口', () => {
    const rows = [sock(1, 443, 0), sock(2, 22, 0), sock(3, 80, 9)];
    expect(sortSocketTable(rows, { key: 'up', desc: true }).map((r) => r.port)).toEqual([80, 22, 443]);
  });
});

describe('pickGroupColor', () => {
  it('挑别的组没在用的颜色', () => {
    expect(pickGroupColor({})).toBe(0);
    expect(pickGroupColor({ a: { color: 0, collapsed: false }, b: { color: 2, collapsed: true } })).toBe(1);
  });

  it('都用上了就轮着来', () => {
    const all = Object.fromEntries(Array.from({ length: GROUP_COLORS }, (_, i) => [`s${i}`, { color: i, collapsed: false }]));
    expect(pickGroupColor(all)).toBe(0);
  });
});
