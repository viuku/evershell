import { describe, expect, it } from 'vitest';
import { digest, knownHostId, sha256Hex, stableJson } from '../digest';
import { HybridClock, formatHlc, isHlc, parseHlc } from '../hlc';
import { detectChanges, isNewer, splitPendingKey, type Ledger } from '../ledger';
import { normalizeState, MemoryStateHolder, newState } from '../state';

const DEV_A = '0000000000000001';
const DEV_B = 'ffffffffffffffff';

describe('混合逻辑时钟', () => {
  it('格式照规格：15 位毫秒、4 位十六进制计数、16 位设备 id，能直接按字典序比大小', () => {
    const h = formatHlc(1793125352000, 0, '3f9a1c2b7d4e5f60');
    expect(h).toBe('001793125352000-0000-3f9a1c2b7d4e5f60');
    expect(isHlc(h)).toBe(true);
    expect(parseHlc(h)).toEqual({ ms: 1793125352000, c: 0, device: '3f9a1c2b7d4e5f60' });
    expect(formatHlc(999, 0, DEV_A) < formatHlc(1000, 0, DEV_A)).toBe(true);
    expect(formatHlc(1000, 15, DEV_A) < formatHlc(1000, 16, DEV_A)).toBe(true);
    expect(isHlc('1793125352000-0000-3f9a1c2b7d4e5f60')).toBe(false);
  });

  it('同一毫秒里计数往上加，时间往回跳也不倒退', () => {
    let t = 5000;
    const clock = new HybridClock(DEV_A, { ms: 0, c: 0 }, () => t);
    const a = clock.tick();
    const b = clock.tick();
    t = 4000;
    const c = clock.tick();
    expect(a < b && b < c).toBe(true);
    expect(parseHlc(c)).toMatchObject({ ms: 5000, c: 2 });
    t = 6000;
    expect(parseHlc(clock.tick())).toMatchObject({ ms: 6000, c: 0 });
  });

  it('收到更大的时间戳把自己拨上去：本机时钟落后时新改动仍然更新', () => {
    const clock = new HybridClock(DEV_A, { ms: 0, c: 0 }, () => 1000);
    const remote = formatHlc(9000, 3, DEV_B);
    clock.observe(remote);
    const next = clock.tick();
    expect(next > remote).toBe(true);
    expect(parseHlc(next)).toMatchObject({ ms: 9000, c: 4 });
  });

  it('毫秒和计数都相同时按设备 id 决胜，不会平手', () => {
    expect(formatHlc(1000, 0, DEV_A) < formatHlc(1000, 0, DEV_B)).toBe(true);
  });

  it('计数用完就借下一毫秒', () => {
    const clock = new HybridClock(DEV_A, { ms: 1000, c: 0xffff }, () => 1000);
    expect(parseHlc(clock.tick())).toMatchObject({ ms: 1001, c: 0 });
  });
});

describe('摘要', () => {
  it('字段先后不影响结果，内容变了就变', () => {
    expect(stableJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 }));
    expect(digest({ a: 1, b: 2 })).not.toBe(digest({ a: 1, b: 3 }));
    expect(digest({ a: 1, b: undefined })).toBe(digest({ a: 1 }));
  });

  it('known_hosts 一行的 id 是 SHA-256 前 16 个十六进制字符', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await knownHostId('abc')).toBe('ba7816bf8f01cfea');
  });
});

describe('账本：发现本机改动', () => {
  const tickFrom = () => {
    let n = 0;
    return () => formatHlc(1000, n++, DEV_A);
  };

  it('新增、修改记新时间戳并标为待上传；没变的不动；没了的记墓碑', () => {
    const ledger: Ledger = {};
    const pending = new Set<string>();
    const tick = tickFrom();
    expect(detectChanges(ledger, pending, 'server', new Map([['a', 'd1'], ['b', 'd2']]), tick, true)).toEqual(['a', 'b']);
    expect([...pending]).toEqual(['server/a', 'server/b']);
    pending.clear();
    const before = ledger.server!.a![0];
    expect(detectChanges(ledger, pending, 'server', new Map([['a', 'd1'], ['b', 'd2x']]), tick, true)).toEqual(['b']);
    expect(ledger.server!.a![0]).toBe(before);
    expect(detectChanges(ledger, pending, 'server', new Map([['b', 'd2x']]), tick, true)).toEqual(['a']);
    expect(ledger.server!.a![1]).toBeNull();
    expect(pending.has('server/a')).toBe(true);
    // 墓碑只记一次
    expect(detectChanges(ledger, pending, 'server', new Map([['b', 'd2x']]), tick, true)).toEqual([]);
  });

  it('历史、最近连接挤出去不发墓碑，只从账本和待上传里去掉', () => {
    const ledger: Ledger = {};
    const pending = new Set<string>();
    const tick = tickFrom();
    detectChanges(ledger, pending, 'history', new Map([['h1', 'x'], ['h2', 'y']]), tick, false);
    expect(detectChanges(ledger, pending, 'history', new Map([['h2', 'y']]), tick, false)).toEqual([]);
    expect(ledger.history).toEqual({ h2: expect.any(Array) });
    expect(pending.has('history/h1')).toBe(false);
  });

  it('远端的比账本新才要；一样大、更旧的不要', () => {
    const ledger: Ledger = { server: { a: [formatHlc(2000, 0, DEV_A), 'd'] } };
    expect(isNewer(ledger, 'server', 'a', formatHlc(2000, 0, DEV_A))).toBe(false);
    expect(isNewer(ledger, 'server', 'a', formatHlc(1999, 9, DEV_B))).toBe(false);
    expect(isNewer(ledger, 'server', 'a', formatHlc(2000, 1, DEV_A))).toBe(true);
    expect(isNewer(ledger, 'server', 'b', formatHlc(1, 0, DEV_A))).toBe(true);
  });

  it('待上传的键按第一个斜杠拆，id 里可以有斜杠', () => {
    expect(splitPendingKey('secret/srv_1.password')).toEqual({ collection: 'secret', id: 'srv_1.password' });
    expect(splitPendingKey('known-host/a/b')).toEqual({ collection: 'known-host', id: 'a/b' });
    expect(splitPendingKey('bad')).toBeNull();
  });
});

describe('同步状态的存储格式', () => {
  it('照规格的字段读回来；读到更高的版本标为 future，不当成没开同步', () => {
    const st = newState({ server: 'https://s', account: 'ops', deviceId: '3f9a1c2b7d4e5f60', deviceName: 'Mac' });
    st.ledger = { server: { a: [formatHlc(1, 0, DEV_A), 'x'], bad: ['nope', 'x'] as never } };
    const holder = new MemoryStateHolder();
    holder.save(st);
    const back = holder.load();
    expect(back).toMatchObject({ version: 1, server: 'https://s', account: 'ops', cursor: 0, pending: [], lastSyncAt: null });
    expect(back !== 'future' && back?.ledger.server).toEqual({ a: [formatHlc(1, 0, DEV_A), 'x'] });
    expect(normalizeState({ ...st, version: 2 })).toBe('future');
    expect(normalizeState({ version: 1, server: 1 })).toBeNull();
    expect(normalizeState(null)).toBeNull();
  });
});
