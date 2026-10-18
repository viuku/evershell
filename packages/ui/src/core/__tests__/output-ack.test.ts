import { describe, expect, it } from 'vitest';
import { AckBatcher, OUTPUT_ACK_BATCH } from '../output-ack';

describe('AckBatcher', () => {
  it('攒够一批才回执', () => {
    const sent: number[] = [];
    const acks = new AckBatcher();
    acks.attach((n) => sent.push(n));
    acks.done(OUTPUT_ACK_BATCH - 1);
    expect(sent).toEqual([]);
    acks.done(1);
    expect(sent).toEqual([OUTPUT_ACK_BATCH]);
    acks.done(10);
    expect(sent).toEqual([OUTPUT_ACK_BATCH]);
  });

  it('会话建好之前画完的输出，接上时一并回执，不论够不够一批', () => {
    const sent: number[] = [];
    const acks = new AckBatcher();
    acks.done(100);
    acks.done(OUTPUT_ACK_BATCH);
    expect(sent).toEqual([]);
    acks.attach((n) => sent.push(n));
    expect(sent).toEqual([OUTPUT_ACK_BATCH + 100]);
  });

  it('回执总数等于画完的字节数', () => {
    let total = 0;
    const acks = new AckBatcher();
    acks.attach((n) => (total += n));
    let drawn = 0;
    for (let i = 0; i < 1000; i++) {
      const n = (i * 7919) % 16384;
      drawn += n;
      acks.done(n);
    }
    // 还没回执的部分不到一批
    expect(drawn - total).toBeLessThan(OUTPUT_ACK_BATCH);
    expect(drawn - total).toBeGreaterThanOrEqual(0);
  });
});
