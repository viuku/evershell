#!/bin/sh
# 等某件事就绪再返回，代替手写的 for/sleep/grep 循环。每 0.5 秒查一次，超时返回 1。
#
#   scripts/wait-for.sh --port 1420                      端口能连上
#   scripts/wait-for.sh --log app.log --match 'Running'  日志里出现这段（扩展正则，先去掉颜色码再匹配）
#   scripts/wait-for.sh --window [--pid 1234]            EverShell 的窗口出现在屏幕上（可限定进程）
#
# 其他选项：
#   --timeout 秒      默认 300
#   --fail 正则       日志里一出现就立刻失败（比如 'error(\[E[0-9]+\])?:'），要配合 --log
#   --exit-pid PID    这个进程一退出就立刻失败（编译失败、程序崩溃时不用干等到超时）
#   --quiet           成功时不打印
# 成功时打印用时；--window 成功时最后一行是窗口号。
set -e
cd "$(dirname "$0")/.."

timeout=300 port= log= match= fail= window= pid= exitpid= quiet=
while [ $# -gt 0 ]; do
  case "$1" in
    --timeout) timeout=$2; shift ;;
    --port) port=$2; shift ;;
    --log) log=$2; shift ;;
    --match) match=$2; shift ;;
    --fail) fail=$2; shift ;;
    --window) window=1 ;;
    --pid) pid=$2; shift ;;
    --exit-pid) exitpid=$2; shift ;;
    --quiet) quiet=1 ;;
    *) echo "不认识的参数：$1" >&2; exit 2 ;;
  esac
  shift
done
if [ -z "$port$match$window" ]; then
  echo "要给 --port、--log + --match 或 --window 之一" >&2
  exit 2
fi

# 去掉 ANSI 颜色码再 grep，cargo / vite 的彩色输出也能匹配
strip() { sed 's/\x1b\[[0-9;]*[A-Za-z]//g' "$1" 2>/dev/null; }

start=$(date +%s)
while :; do
  elapsed=$(( $(date +%s) - start ))
  if [ -n "$fail" ] && [ -n "$log" ] && strip "$log" | grep -E -q -- "$fail"; then
    echo "失败（${elapsed}s）：日志里出现了 /$fail/：" >&2
    strip "$log" | grep -E -- "$fail" | head -5 >&2
    exit 1
  fi
  ok=1
  if [ -n "$port" ] && ! nc -z 127.0.0.1 "$port" 2>/dev/null; then ok=; fi
  if [ -n "$match" ] && ! strip "$log" | grep -E -q -- "$match"; then ok=; fi
  if [ -n "$window" ]; then
    wid=$(scripts/mac-window.sh id ${pid:+--pid "$pid"} 2>/dev/null) || wid=
    [ -n "$wid" ] || ok=
  fi
  if [ -n "$ok" ]; then
    [ -n "$quiet" ] || echo "就绪（${elapsed}s）"
    [ -z "$window" ] || echo "$wid"
    exit 0
  fi
  if [ -n "$exitpid" ] && ! kill -0 "$exitpid" 2>/dev/null; then
    echo "失败（${elapsed}s）：进程 $exitpid 已经退出" >&2
    [ -z "$log" ] || strip "$log" | tail -15 >&2
    exit 1
  fi
  if [ "$elapsed" -ge "$timeout" ]; then
    echo "超时（${timeout}s）" >&2
    [ -z "$log" ] || strip "$log" | tail -15 >&2
    exit 1
  fi
  sleep 0.5
done
