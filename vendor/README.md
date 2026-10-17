# vendor

## russh 0.64.1（打了补丁）

来源：crates.io 上的 russh 0.64.1 原样拷贝，删掉了 benches/、examples/。

补丁目的：让 SSH 客户端能在浏览器（wasm32-unknown-unknown）里运行。
russh 客户端直接调用 `tokio::time::sleep/timeout`，它们依赖 `std::time::Instant`，在 wasm32 上会 panic。

改动：

- 新增 `src/rt_time.rs`：原生平台直接转发给 tokio，wasm32 用 futures-timer（浏览器 setTimeout）。
- `src/client/mod.rs`：6 处 `tokio::time::*` 改为 `crate::rt_time::*`（换密钥计时、心跳、空闲超时、等待扩展信息）。
- `src/lib_inner.rs`：声明 `mod rt_time;`。
- `src/lib.rs`：wasm32 下关闭 dead_code / unused_imports 警告（服务端代码在浏览器里用不到）。
- `Cargo.toml`：wasm32 下增加 futures-timer 依赖。

另一处补丁（与 wasm 无关）：`src/client/encrypted.rs` 处理 CHANNEL_CLOSE 时，
客户端自己先关掉的 channel 已不在协议状态表里，原代码直接忽略服务器回的 CHANNEL_CLOSE，
导致 `Channel::wait()` 永远不结束（shell 关掉后收不到退出事件）。改成仍把 Close 转给 Channel 并清理。

完整差异见 `russh-wasm-timers.patch`（含上面两处；在 russh 源码目录里 `patch -p2 < russh-wasm-timers.patch` 可重新应用）。升级 russh 时：拷贝新版本，重新应用补丁；
上游修复后删掉本目录和根 Cargo.toml 里的 `[patch.crates-io]`。
