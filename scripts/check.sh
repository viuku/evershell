#!/bin/sh
# 按改动范围跑检查。每步一行结果，失败时打印出错的部分，完整日志在 target/check-logs/（设了 CARGO_TARGET_DIR 就在它下面）。
#
#   scripts/check.sh ui        界面：守则检查、packages/ui 类型检查 + 单元测试、网页端和桌面端前端类型检查（约 3 秒）
#   scripts/check.sh core      内核：守则检查、ssh-core 和 vault 的测试与 clippy、能不能编成 WASM、桌面端还能不能编过（增量约 30 秒）
#   scripts/check.sh desktop   桌面端 Rust（Tauri 命令、会话、保险箱）：测试和 clippy（增量约 30 秒）
#   scripts/check.sh web       网页端链路：重编 WASM 包；test-sshd 在跑的话再跑一遍无界面端到端测试（约 20 秒）
#                              注意它会重写 crates/ssh-wasm/pkg，本文件夹开着的网页版会跟着刷新
#   scripts/check.sh docs      规范体系（CLAUDE.md、docs/handbook）里的路径、链接、锚点是否都对得上
#   scripts/check.sh all       以上全部
# 可以一次给多个：scripts/check.sh ui core
#
# “连真服务器”的测试要先 scripts/test-sshd.sh start；没开的话这些测试会被跳过，这里会提示。
cd "$(dirname "$0")/.."
. scripts/dev-env.sh

[ $# -gt 0 ] || { awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 2; }

logs=${CARGO_TARGET_DIR:-target}/check-logs
mkdir -p "$logs"
failed=

# step 名字 命令…：跑命令，记录日志，打印 ✓ / ✗
step() {
  name=$1
  shift
  file="$logs/$(printf '%s' "$name" | tr ' /' '__').log"
  t0=$(date +%s)
  if "$@" > "$file" 2>&1; then
    echo "✓ $name（$(( $(date +%s) - t0 ))s）"
  else
    echo "✗ $name（$(( $(date +%s) - t0 ))s，日志 $file）"
    errs=$(grep -E -B2 -A12 '^(error|warning: unused)|error\[|FAIL|panicked|✗|× |Error:' "$file" | head -60)
    if [ -n "$errs" ]; then printf '%s\n' "$errs"; else tail -40 "$file"; fi
    failed="$failed $name"
  fi
}

# test-sshd 在跑就把连接信息带给测试，否则提醒一句
real_server() {
  if env_line=$(scripts/test-sshd.sh env 2>/dev/null); then
    eval "$env_line"
    echo "  （连真服务器的测试：用 test-sshd $SSH_E2E_ADDR）"
  else
    unset SSH_E2E_ADDR SSH_E2E_USER SSH_E2E_KEY
    echo "  （连真服务器的测试会被跳过：没开 scripts/test-sshd.sh start）"
  fi
}

clippy() {
  cargo clippy "$@" --all-targets -- -D warnings
}

run_e2e() {
  token=check-$$
  port=$((18000 + $$ % 1000))
  PORT=$port RELAY_TOKEN=$token node services/relay-node/server.mjs > "$logs/relay.log" 2>&1 &
  relay=$!
  scripts/wait-for.sh --port "$port" --timeout 10 --quiet || { kill $relay; wait $relay 2>/dev/null; return 1; }
  RELAY=ws://127.0.0.1:$port RELAY_TOKEN=$token TARGET=$SSH_E2E_ADDR SSH_USER=$SSH_E2E_USER SSH_KEY=$SSH_E2E_KEY \
    node scripts/e2e-web-ssh.mjs
  code=$?
  kill $relay 2>/dev/null
  wait $relay 2>/dev/null
  return $code
}

for scope in "$@"; do
  [ "$scope" = all ] && set -- ui core desktop web docs && break
done

for scope in "$@"; do
  case "$scope" in
    ui)
      step "守则检查" scripts/check-guards.sh
      step "ui 类型检查" npm run typecheck -w @evershell/ui
      step "ui 单元测试" npm test -w @evershell/ui
      step "web 类型检查" npm run typecheck -w @evershell/web
      step "desktop 前端类型检查" npm run typecheck -w @evershell/desktop
      ;;
    core)
      real_server
      step "守则检查" scripts/check-guards.sh
      step "内核测试" cargo test -p ssh-core -p vault
      step "内核 clippy" clippy -p ssh-core -p vault
      step "WASM 编译检查 ssh-wasm" cargo check -p ssh-wasm --target wasm32-unknown-unknown
      step "WASM 编译检查 vault" cargo check -p vault --target wasm32-unknown-unknown
      step "桌面端编译检查" cargo check -p evershell-desktop --tests
      ;;
    desktop)
      real_server
      step "桌面端测试" cargo test -p evershell-desktop
      step "桌面端 clippy" clippy -p evershell-desktop
      ;;
    web)
      step "重编 WASM 包" scripts/build-wasm.sh
      step "web 类型检查" npm run typecheck -w @evershell/web
      real_server
      if [ -n "$SSH_E2E_ADDR" ]; then step "网页端到端测试" run_e2e; fi
      ;;
    docs)
      step "规范体系检查" scripts/check-docs.sh
      ;;
    *)
      echo "不认识的范围：$scope（ui / core / desktop / web / docs / all）"
      exit 2
      ;;
  esac
done

if [ -n "$failed" ]; then
  echo "有失败：$failed"
  exit 1
fi
echo "全部通过"
