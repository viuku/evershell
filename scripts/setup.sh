#!/bin/sh
# 新文件夹（新 worktree、新克隆）第一次开工前跑一次；已经装好的会跳过，重复跑没关系。
#   1. 查工具链：cargo、wasm32 目标、llvm-tools、wasm-bindgen 版本、Node 22+
#   2. node_modules 没装或 package-lock.json 更新过 → npm install
#   3. 网页端的 WASM 包没编过 → scripts/build-wasm.sh（网页版 ?mock 预览也要它，否则 vite 报找不到 @evershell/ssh-wasm）
# 新 worktree 第一次编 Rust 要几分钟（target/ 不共用），可以放后台跑。
set -e
cd "$(dirname "$0")/.."
. scripts/dev-env.sh

problems=
need() { problems="$problems
  - $1"; }

command -v cargo >/dev/null || need "没有 cargo：装 Rust（https://rustup.rs）"
if command -v rustup >/dev/null; then
  rustup target list --installed | grep -q '^wasm32-unknown-unknown$' || need "rustup target add wasm32-unknown-unknown"
  rustup component list --installed | grep -q '^llvm-tools' || need "rustup component add llvm-tools"
fi
want=$(grep -A1 '^name = "wasm-bindgen"$' Cargo.lock | sed -n 's/^version = "\(.*\)"/\1/p')
have=$(wasm-bindgen --version 2>/dev/null | awk '{print $2}')
[ "$have" = "$want" ] || need "wasm-bindgen 版本要和 Cargo.lock 一致：cargo install wasm-bindgen-cli --version $want（现在是 ${have:-没装}）"
node_major=$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')
[ "${node_major:-0}" -ge 22 ] || need "Node.js 要 22 以上（现在是 $(node -v 2>/dev/null || echo 没装)）"

if [ -n "$problems" ]; then
  echo "先装好这些再跑：$problems"
  exit 1
fi
echo "✓ 工具链"

if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "… npm install"
  mkdir -p target
  npm install --no-audit --no-fund > target/npm-install.log 2>&1 || { tail -20 target/npm-install.log; exit 1; }
fi
echo "✓ node_modules"

if [ ! -f crates/ssh-wasm/pkg/ssh_wasm.js ]; then
  echo "… 编网页端 WASM 包（第一次要几分钟）"
  scripts/build-wasm.sh
fi
echo "✓ WASM 包"
echo "准备好了"
