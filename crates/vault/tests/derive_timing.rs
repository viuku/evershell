//! 量默认参数派生一次同步密码要多久（登录、注册、改密码时用户要等这么久）。
//! 放在 tests/ 而不是 src/：内核源码里不许直接用 std::time::Instant（scripts/check-guards.sh）。
//! 要在 release 下跑才有意义：
//!   cargo test -p vault --release --test derive_timing -- --ignored --nocapture

use std::time::Instant;

use vault::sync::{KdfParams, derive};

#[test]
#[ignore]
fn time_default_derive() {
    let salt = *b"evershell-salt-1";
    let rounds = 5;
    let started = Instant::now();
    for _ in 0..rounds {
        derive("correct horse battery staple", &salt, &KdfParams::default()).unwrap();
    }
    println!("默认参数（64 MiB、3 轮、1 线程）派生一次平均：{:?}", started.elapsed() / rounds);
}
