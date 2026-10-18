// 终端输出的回执，和 crates/ssh-core/src/flow.rs 配对。
//
// xterm.js 画字比服务器发得慢，后端只在界面回执过之后才继续读 shell 输出，积压最多约 256 KB。
// 每块输出在 term.write 的回调里算“画完了”，攒够一批再回执一次，免得每块都跨一次进程。

/** 与 Rust 侧 OUTPUT_ACK_BATCH 相同；必须远小于后端的水位线，否则双方会互等 */
export const OUTPUT_ACK_BATCH = 32 * 1024;

/** 一次连接一个：重连时换新的，旧连接迟到的回调不会算到新连接头上 */
export class AckBatcher {
  private pending = 0;
  private sink: ((bytes: number) => void) | null = null;

  /** 会话建好后接上回执的去处。握手期间就到了的输出（登录提示）先攒着，这时一并回执 */
  attach(sink: (bytes: number) => void): void {
    this.sink = sink;
    this.flush();
  }

  /** 一块输出画完了 */
  done(bytes: number): void {
    this.pending += bytes;
    if (this.pending >= OUTPUT_ACK_BATCH) this.flush();
  }

  private flush(): void {
    if (!this.sink || this.pending === 0) return;
    this.sink(this.pending);
    this.pending = 0;
  }
}
