#!/bin/sh
# 构建网页端 SSH 内核：crates/ssh-wasm → crates/ssh-wasm/pkg（npm 包 @evershell/ssh-wasm）
# 依赖：rustup target add wasm32-unknown-unknown；rustup component add llvm-tools；
#       cargo install wasm-bindgen-cli --version <与 Cargo.lock 中 wasm-bindgen 相同的版本>
set -e
cd "$(dirname "$0")/.."

cargo build -p ssh-wasm --target wasm32-unknown-unknown --profile wasm-release
wasm-bindgen --target web --out-dir crates/ssh-wasm/pkg \
  target/wasm32-unknown-unknown/wasm-release/ssh_wasm.wasm

ls -l crates/ssh-wasm/pkg/ssh_wasm_bg.wasm | awk '{printf "wasm: %.1f MB", $5/1e6}'
gzip -9 -c crates/ssh-wasm/pkg/ssh_wasm_bg.wasm | wc -c | awk '{printf "（gzip 后 %.1f MB）\n", $1/1e6}'
