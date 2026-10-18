//! 终端输出的流控（回压）。
//!
//! 界面画字的速度（xterm.js 约 5–35 MB/s）远比服务器能发的慢。如果把输出一股脑读走，
//! 数据会堆在内存里，xterm.js 的写缓冲超过 50 MB 还会直接丢字，Ctrl-C 也要等积压的输出画完才停。
//!
//! 做法照 xterm.js 的流控指南：界面每处理完一批输出就“回执”（[`OutputAck::ack`]）已处理的字节数；
//! 读 shell 的任务发现没回执的字节超过 [`OUTPUT_HIGH_WATER`] 就停下不读。不读 channel，
//! russh 的缓冲满了就不再读网络，服务器那边的 TCP 发送窗口随之填满，`yes` 这类程序就被挂起。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use tokio::sync::Notify;

/// 已经交给界面、但界面还没回执的输出最多这么多字节，超过就暂停读 shell。
/// 按 xterm.js 指南，为了按键响应快不宜超过 500 KB；界面每处理 [`OUTPUT_ACK_BATCH`] 回执一次，
/// 必须远小于这个值，否则可能双方互等。
pub const OUTPUT_HIGH_WATER: usize = 256 * 1024;

/// 界面攒够这么多已处理字节再回执一次，免得每块输出都跨一次进程。
/// 前端（packages/ui/src/core/session-manager.ts）用同一个数。
pub const OUTPUT_ACK_BATCH: usize = 32 * 1024;

#[derive(Default)]
struct Flow {
    unacked: AtomicUsize,
    /// 放开以后不再限速：会话要关了，或者界面已经不看输出了
    released: AtomicBool,
    room: Notify,
}

/// 界面用来回执终端输出的句柄，可以克隆后放到别的任务里。
///
/// 回执不能和按键排在同一个队列里：读任务停下时 russh 的会话循环也会跟着停，
/// 排在后面的按键发不出去，回执就永远到不了，两边互等。
#[derive(Clone, Default)]
pub struct OutputAck(Arc<Flow>);

impl OutputAck {
    /// 界面处理完了 `bytes` 字节输出
    pub fn ack(&self, bytes: usize) {
        let flow = &self.0;
        // 多回执（比如重连前的旧回调）只会让窗口宽一点，不会出错
        let mut cur = flow.unacked.load(Ordering::Acquire);
        while let Err(now) =
            flow.unacked
                .compare_exchange_weak(cur, cur.saturating_sub(bytes), Ordering::AcqRel, Ordering::Acquire)
        {
            cur = now;
        }
        flow.room.notify_one();
    }

    /// 不再限速。关会话之前调：读任务停着的时候 russh 处理不了断开请求，
    /// 界面也不会再回执，不放开就会一直卡着。
    pub fn release(&self) {
        self.0.released.store(true, Ordering::Release);
        self.0.room.notify_one();
    }

    pub(crate) fn sent(&self, bytes: usize) {
        self.0.unacked.fetch_add(bytes, Ordering::AcqRel);
    }

    /// 等到没回执的字节降到水位线以下
    pub(crate) async fn wait_room(&self) {
        let flow = &self.0;
        loop {
            if flow.released.load(Ordering::Acquire) || flow.unacked.load(Ordering::Acquire) < OUTPUT_HIGH_WATER {
                return;
            }
            // notify_one 在没人等的时候会留一个许可，所以先检查再等不会漏掉唤醒
            flow.room.notified().await;
        }
    }

    #[cfg(test)]
    fn unacked(&self) -> usize {
        self.0.unacked.load(Ordering::Acquire)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ack_never_goes_negative() {
        let ack = OutputAck::default();
        ack.sent(100);
        ack.ack(300);
        assert_eq!(ack.unacked(), 0);
    }

    #[test]
    fn batch_is_well_below_high_water() {
        // 读任务停下时至少压着 HIGH_WATER 字节没回执，界面处理完一定攒得够一批，不会互等
        const { assert!(OUTPUT_ACK_BATCH * 4 <= OUTPUT_HIGH_WATER) };
    }
}
