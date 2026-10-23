#!/bin/sh
# 让所有者用上新版：签名编译 → 放进主文件夹的 build/EverShell.app → 退出他正在用的旧版 → 打开新版。
#
#   scripts/mac-reopen.sh              编译（scripts/build-mac.sh）后重开
#   scripts/mac-reopen.sh --no-build   只重开 build/EverShell.app
#
# 在 worktree 里跑也会搬进主文件夹（git worktree list 第一行）的 build/，所有者只认那一个位置。
# 必须先退出旧的：同一个应用标识已经在运行时，系统只会把旧窗口叫到前面，打开的还是旧版。
# 退出用的是普通的结束进程，不发“退出”指令给应用（那样会弹“允许控制”的授权框）。
# 别的会话开着的调试版（target/debug/bundle 里的）不动。
set -e
cd "$(dirname "$0")/.."
. scripts/dev-env.sh

main=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
app="$main/build/EverShell.app"
log=target/mac-reopen.log
mkdir -p target

case "$1" in
  --no-build) ;;
  "")
    t0=$(date +%s)
    if ! scripts/build-mac.sh > "$log" 2>&1; then
      echo "编译失败（日志 $log）：" >&2
      errs=$(grep -E -A5 '^(error|Error)|error\[' "$log" | head -40 || true)
      if [ -n "$errs" ]; then printf '%s\n' "$errs" >&2; else tail -30 "$log" >&2; fi
      exit 1
    fi
    echo "编译完成（$(( $(date +%s) - t0 ))s）"
    ;;
  *) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 2 ;;
esac

# 先退出所有者在用的：主文件夹 build/ 里的，以及以前直接从 target/release 打开过的
pattern="^($main/build|[^ ]*/target/release/bundle/macos)/EverShell\.app/Contents/MacOS/evershell-desktop"
old=$(pgrep -f "$pattern" || true)
if [ -n "$old" ]; then
  for p in $old; do echo "退出旧版：$(ps -o command= -p "$p" | sed 's|/Contents/MacOS/.*||')"; done
  kill $old 2>/dev/null || true
  i=0
  while [ $i -lt 20 ]; do
    alive=
    for p in $old; do kill -0 "$p" 2>/dev/null && alive=1; done
    [ -n "$alive" ] || break
    sleep 0.5
    i=$((i + 1))
  done
  [ -z "$alive" ] || kill -9 $old 2>/dev/null || true
fi

# 在 worktree 里编的搬过去，worktree 里不留副本；--no-build 时直接重开主文件夹那份
if [ "$PWD" != "$main" ] && [ -d build/EverShell.app ]; then
  mkdir -p "$main/build"
  rm -rf "$app"
  mv build/EverShell.app "$app"
  rmdir build 2>/dev/null || true
fi
[ -d "$app" ] || { echo "没有 $app，先去掉 --no-build 编一次" >&2; exit 1; }

# -n：别的会话可能开着同一应用标识的调试版，不加的话系统会把那个叫到前面
open -n "$app"
i=0
pid=
while [ -z "$pid" ] && [ $i -lt 20 ]; do
  sleep 0.5
  pid=$(pgrep -f "^$app/Contents/MacOS/evershell-desktop" | head -1 || true)
  i=$((i + 1))
done
[ -n "$pid" ] || { echo "打开后没找到进程，看看是不是闪退了" >&2; exit 1; }
scripts/wait-for.sh --window --pid "$pid" --exit-pid "$pid" --timeout 30 --quiet > /dev/null
built=$(stat -f '%Sm' -t '%m-%d %H:%M' "$app/Contents/MacOS/evershell-desktop")
echo "已打开新版 $app（进程 $pid，编译于 $built，分支 $(git branch --show-current)）"
