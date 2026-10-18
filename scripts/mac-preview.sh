#!/bin/sh
# 给 AI 自己验原生窗口用：编调试版 .app → 关掉本文件夹之前开的调试版 → 打开 → 等窗口出现 → 截图。
#
#   scripts/mac-preview.sh               完整走一遍，最后一行是截图路径（用 Read 看）
#   scripts/mac-preview.sh --no-build    不重新编译，直接重开并截图
#   scripts/mac-preview.sh --stop        关掉调试版
#
# 调试版开着不关，可以接着用 scripts/mac-window.sh shot --pid <进程号> --crop … 放大看细节。
# 注意：调试版和所有者在用的 build/EverShell.app 是同一个应用标识，共用连接列表、保险箱和钥匙串。
# 只截图看样子，不要在调试版里连接、保存或删除连接。要给所有者用新版，用 scripts/mac-reopen.sh。
set -e
cd "$(dirname "$0")/.."
. scripts/dev-env.sh

app="${CARGO_TARGET_DIR:-$PWD/target}/debug/bundle/macos/EverShell.app"
bin="$app/Contents/MacOS/evershell-desktop"
dir=target/mac-preview
mkdir -p "$dir"

stop_old() {
  pids=$(pgrep -f "^$bin" || true)
  [ -n "$pids" ] || return 0
  kill $pids 2>/dev/null || true
  i=0
  while pgrep -f "^$bin" >/dev/null && [ $i -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
  pkill -9 -f "^$bin" 2>/dev/null || true
}

case "$1" in
  --stop) stop_old; echo "调试版已关闭"; exit 0 ;;
  --no-build) build= ;;
  "") build=1 ;;
  *) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 2 ;;
esac

if [ -n "$build" ]; then
  t0=$(date +%s)
  if ! npm run tauri -w @evershell/desktop -- build --debug --bundles app > "$dir/build.log" 2>&1; then
    echo "编译失败（日志 $dir/build.log）：" >&2
    errs=$(grep -E -A5 '^(error|Error)|error\[' "$dir/build.log" | head -40 || true)
    if [ -n "$errs" ]; then printf '%s\n' "$errs" >&2; else tail -30 "$dir/build.log" >&2; fi
    exit 1
  fi
  echo "编译完成（$(( $(date +%s) - t0 ))s）"
fi
[ -x "$bin" ] || { echo "没有 $app，先去掉 --no-build 编一次" >&2; exit 1; }

stop_old
nohup "$bin" > "$dir/run.log" 2>&1 &
pid=$!
scripts/wait-for.sh --window --pid "$pid" --exit-pid "$pid" --log "$dir/run.log" --timeout 60 --quiet > /dev/null
# 窗口出现时网页内容可能还没画完，稍等一下再截
sleep 2
echo "调试版在运行：进程 $pid，日志 $dir/run.log"
scripts/mac-window.sh shot --pid "$pid" -o "$dir/shot.png"
