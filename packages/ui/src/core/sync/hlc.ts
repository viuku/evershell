// 混合逻辑时钟（docs/specs/sync.md「怎么判断谁新」）。时间戳是定长字符串，直接按字典序比大小：
// <15 位十进制毫秒>-<4 位十六进制计数>-<16 位十六进制设备 id>。
// 同一毫秒里靠计数往上加；收到更大的时间戳就把自己拨上去，所以本机时钟落后时新改动仍然比见过的都新。

const HLC_RE = /^(\d{15})-([0-9a-f]{4})-([0-9a-f]{16})$/;
const DEVICE_RE = /^[0-9a-f]{16}$/;
const MAX_COUNT = 0xffff;

export interface ClockState {
  ms: number;
  c: number;
}

export function formatHlc(ms: number, c: number, deviceId: string): string {
  return `${String(Math.max(0, Math.floor(ms))).padStart(15, '0')}-${c.toString(16).padStart(4, '0')}-${deviceId}`;
}

export function parseHlc(hlc: string): { ms: number; c: number; device: string } | null {
  const m = HLC_RE.exec(hlc);
  if (!m) return null;
  return { ms: Number(m[1]), c: parseInt(m[2]!, 16), device: m[3]! };
}

export function isHlc(value: unknown): value is string {
  return typeof value === 'string' && HLC_RE.test(value);
}

export function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && DEVICE_RE.test(value);
}

/** 新设备 id：8 字节随机数的十六进制 */
export function newDeviceId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class HybridClock {
  private state: ClockState;

  constructor(
    readonly deviceId: string,
    state: ClockState,
    private readonly now: () => number,
  ) {
    const ms = Number.isFinite(state.ms) ? Math.max(0, Math.floor(state.ms)) : 0;
    const c = Number.isFinite(state.c) ? Math.min(MAX_COUNT, Math.max(0, Math.floor(state.c))) : 0;
    this.state = { ms, c };
  }

  /** 给本机的一次改动取时间戳，保证比之前取过的、见过的都大 */
  tick(): string {
    const pt = this.now();
    if (pt > this.state.ms) this.state = { ms: pt, c: 0 };
    // 计数用完就借下一毫秒，仍然单调
    else if (this.state.c >= MAX_COUNT) this.state = { ms: this.state.ms + 1, c: 0 };
    else this.state = { ms: this.state.ms, c: this.state.c + 1 };
    return formatHlc(this.state.ms, this.state.c, this.deviceId);
  }

  /** 见到别的设备的时间戳：比自己大就拨上去 */
  observe(hlc: string): void {
    const p = parseHlc(hlc);
    if (!p) return;
    if (p.ms > this.state.ms || (p.ms === this.state.ms && p.c > this.state.c)) this.state = { ms: p.ms, c: p.c };
  }

  snapshot(): ClockState {
    return { ...this.state };
  }
}
