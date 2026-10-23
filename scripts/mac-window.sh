#!/bin/sh
# 给正在运行的 EverShell 窗口截图，不需要“控制电脑”权限，也不会抢焦点。
#
#   scripts/mac-window.sh list                     屏幕上所有 EverShell 窗口：窗口号 进程号 位置大小 应用名 窗口标题
#   scripts/mac-window.sh id [--pid PID]           主窗口的窗口号（有好几个时用 --pid 指定）
#   scripts/mac-window.sh shot [--pid PID] [--name 窗口名] [-o 输出.png] [--crop x,y,宽,高] [--max 像素]
#
# 默认截面积最大的窗口（主窗口）；--name 截标题里带这几个字的窗口，如 --name 连接管理器。
# shot 默认存到 target/screens/evershell-时间.png，最后一行打印文件路径，用 Read 看图。
# --crop 用窗口里的坐标（点，和 CSS 像素一样），自动换算 Retina 倍数，用来放大看细节。
# --max 把长边缩到这个像素数（默认 1600，0 表示不缩）。
# 截到的是窗口当前的样子：深浅色跟着系统走。不要为了截另一种颜色去改系统外观。
set -e
cd "$(dirname "$0")/.."

tool=target/dev-tools/window-tool
src=scripts/mac/window-tool.swift
if [ ! -x "$tool" ] || [ "$src" -nt "$tool" ]; then
  mkdir -p target/dev-tools
  swiftc -O -o "$tool" "$src" 2>&1 | grep -v '^$' >&2 || true
  [ -x "$tool" ] || { echo "编译 $src 失败" >&2; exit 1; }
fi

cmd=${1:-shot}
[ $# -gt 0 ] && shift
pid= name= out= crop= max=1600
while [ $# -gt 0 ]; do
  case "$1" in
    --pid) pid=$2; shift ;;
    --name) name=$2; shift ;;
    -o) out=$2; shift ;;
    --crop) crop=$2; shift ;;
    --max) max=$2; shift ;;
    *) echo "不认识的参数：$1" >&2; exit 2 ;;
  esac
  shift
done

# 取面积最大的那个窗口（给了 --name 就只在标题带它的窗口里挑）：窗口号<TAB>宽
main_window() {
  "$tool" list $pid | awk -F'\t' -v name="$name" 'name == "" || index($5, name) { split($3, b, ","); a = b[3] * b[4]; if (a > best) { best = a; line = $1 "\t" b[3] } } END { if (line) print line }'
}

case "$cmd" in
  list)
    "$tool" list $pid
    ;;
  id)
    w=$(main_window)
    [ -n "$w" ] || { echo "屏幕上没有 EverShell 窗口${pid:+（进程 $pid）}" >&2; exit 1; }
    printf '%s\n' "$w" | cut -f1
    ;;
  shot)
    w=$(main_window)
    [ -n "$w" ] || { echo "屏幕上没有 EverShell 窗口${pid:+（进程 $pid）}" >&2; exit 1; }
    wid=$(printf '%s\n' "$w" | cut -f1)
    width=$(printf '%s\n' "$w" | cut -f2)
    if [ -z "$out" ]; then
      mkdir -p target/screens
      out=target/screens/evershell-$(date +%H%M%S).png
    fi
    screencapture -x -o -l "$wid" "$out"
    if [ -n "$crop" ]; then
      # shellcheck disable=SC2046
      "$tool" crop "$out" "$out" $(printf '%s' "$crop" | tr ',' ' ') "$width"
    fi
    if [ "$max" != 0 ]; then
      long=$(sips -g pixelWidth -g pixelHeight "$out" | awk '/pixel/ { if ($2 > m) m = $2 } END { print m }')
      # 只缩小不放大
      [ "$long" -le "$max" ] || sips -Z "$max" "$out" --out "$out" >/dev/null
    fi
    echo "$out"
    ;;
  *)
    awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
    exit 2
    ;;
esac
