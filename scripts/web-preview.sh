#!/bin/sh
# 网页版预览该用哪个地址。先看本文件夹有没有已经在跑的网页版开发服务器，有就直接复用（改动会热更新过去），
# 没有再告诉你用 launch.json 里的哪一条去 preview_start。不会自己启动服务器（开发服务器只能用 preview_start 开）。
#
#   scripts/web-preview.sh
#
# 注意：共享文件夹里别的会话也在改界面时，热更新会把它没写完的改动一起显示出来，这时要在自己的 worktree 里验。
cd "$(dirname "$0")/.."
here="$PWD/apps/web"

ports=
for pid in $(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk '$1 == "node" { print $2 }' | sort -u); do
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
  [ "$cwd" = "$here" ] || continue
  ports="$ports $(lsof -nP -a -p "$pid" -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR > 1 { n = split($9, a, ":"); print a[n] }')"
done
ports=$(printf '%s\n' $ports | sort -n -u | grep . || true)
if [ -n "$ports" ]; then
  first=$(printf '%s\n' "$ports" | head -1)
  echo "用这个：http://localhost:$first/?mock（本文件夹已经在跑的网页版，navigate 过去即可，不用再 preview_start）"
  others=$(printf '%s\n' "$ports" | sed 1d | tr '\n' ' ')
  [ -z "$others" ] || echo "本文件夹还有：$others（连接列表各存各的，固定用上面那个）"
  exit 0
fi

busy() { nc -z 127.0.0.1 "$1" 2>/dev/null || nc -z ::1 "$1" 2>/dev/null; }
if ! busy 5173; then
  echo "本文件夹没有在跑的网页版。preview_start {name: \"web\"}，再 navigate 到 http://localhost:5173/?mock"
elif ! busy 5174; then
  echo "5173 被别的文件夹占着。preview_start {name: \"web-alt\"}，再 navigate 到 http://localhost:5174/?mock"
else
  port=5175
  while busy $port && [ $port -lt 5199 ]; do port=$((port + 1)); done
  echo "5173、5174 都被别的文件夹占着，$port 空着。在 .claude/launch.json 临时加一条（照 web-alt 抄，端口改成 $port），preview_start 它，用完删掉。"
fi
