// java.util.Random 的移植：48 位线性同余发生器（Knuth TAOCP 3.2.1，JDK 文档给出了完整算法）。
// FinalShell 用它从随机头派生 DES 密钥，所以 next/nextInt(bound)/nextLong 的每个细节都得和 Java 一致：
// nextInt 的拒绝采样用 int 溢出判断，nextLong 是两个带符号 int 相加而不是按位或。

const MULT = 0x5deece66dn;
const ADD = 0xbn;
const MASK = (1n << 48n) - 1n;

export class JavaRandom {
  private seed: bigint;

  constructor(seed: bigint | number) {
    this.seed = (BigInt(seed) ^ MULT) & MASK;
  }

  /** 返回带符号 32 位 int */
  private next(bits: number): number {
    this.seed = (this.seed * MULT + ADD) & MASK;
    return Number(BigInt.asIntN(32, this.seed >> BigInt(48 - bits)));
  }

  nextInt(bound?: number): number {
    if (bound === undefined) return this.next(32);
    if (bound <= 0) throw new Error('bound 必须为正');
    let r = this.next(31);
    const m = bound - 1;
    if ((bound & m) === 0) return Number((BigInt(bound) * BigInt(r)) >> 31n);
    for (let u = r; ((u - (r = u % bound) + m) | 0) < 0; u = this.next(31));
    return r;
  }

  nextLong(): bigint {
    const hi = BigInt(this.next(32));
    const lo = BigInt(this.next(32));
    return BigInt.asIntN(64, (hi << 32n) + lo);
  }
}
