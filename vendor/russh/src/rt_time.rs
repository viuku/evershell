//! 定时器抽象（本仓库补丁，见 vendor/README.md）。
//!
//! tokio 的定时器依赖 `std::time::Instant`，在 wasm32-unknown-unknown 上会直接 panic，
//! 所以 wasm32 下改用 futures-timer（底层是浏览器的 setTimeout）。原生平台行为不变。

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

#[cfg(not(target_arch = "wasm32"))]
pub(crate) use tokio::time::{Sleep, sleep};

#[cfg(not(target_arch = "wasm32"))]
pub(crate) fn reset(sleep: Pin<&mut Sleep>, after: Duration) {
    sleep.reset(tokio::time::Instant::now() + after);
}

/// 超时返回 None
#[cfg(not(target_arch = "wasm32"))]
pub(crate) async fn timeout<F: Future>(after: Duration, fut: F) -> Option<F::Output> {
    tokio::time::timeout(after, fut).await.ok()
}

#[cfg(target_arch = "wasm32")]
pub(crate) struct Sleep(futures_timer::Delay);

#[cfg(target_arch = "wasm32")]
pub(crate) fn sleep(after: Duration) -> Sleep {
    Sleep(futures_timer::Delay::new(after))
}

#[cfg(target_arch = "wasm32")]
impl Future for Sleep {
    type Output = ();
    fn poll(mut self: Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<()> {
        Pin::new(&mut self.0).poll(cx)
    }
}

#[cfg(target_arch = "wasm32")]
pub(crate) fn reset(mut sleep: Pin<&mut Sleep>, after: Duration) {
    sleep.0.reset(after);
}

#[cfg(target_arch = "wasm32")]
pub(crate) async fn timeout<F: Future>(after: Duration, fut: F) -> Option<F::Output> {
    use futures::future::{Either, select};
    let fut = std::pin::pin!(fut);
    match select(fut, futures_timer::Delay::new(after)).await {
        Either::Left((out, _)) => Some(out),
        Either::Right(_) => None,
    }
}
