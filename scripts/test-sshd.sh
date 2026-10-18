#!/bin/sh
# 本机临时 sshd，给“连真服务器”的测试用（crates/ssh-core/tests/real_server.rs、
# apps/desktop/src-tauri/tests/session.rs、scripts/e2e-web-ssh.mjs）。
# 只监听 127.0.0.1，只开密钥登录，用当前用户身份运行，文件都在 target/test-sshd/。
#
#   scripts/test-sshd.sh start           起服务（已在跑就直接复用），打印要 export 的环境变量
#   scripts/test-sshd.sh start --noisy   SFTP 子系统启动前先打印一行字，模拟登录脚本有输出的服务器
#   scripts/test-sshd.sh env             只打印环境变量（eval "$(scripts/test-sshd.sh env)"）
#   scripts/test-sshd.sh status | stop
# env / status / stop 后面也加 --noisy，就是操作 noisy 那一个。
#
# 端口默认 2222（--noisy 默认 2223），用 PORT=xxxx 改。scripts/check.sh 发现它在跑会自动带上。
set -e
cd "$(dirname "$0")/.."
. scripts/dev-env.sh

cmd=${1:-start}
noisy=
[ "$2" = "--noisy" ] && noisy=1
if [ -n "$noisy" ]; then name=noisy; port=${PORT:-2223}; else name=plain; port=${PORT:-2222}; fi
dir="$PWD/target/test-sshd"
conf="$dir/sshd_$name.conf"
pidfile="$dir/sshd_$name.pid"

running() {
  [ -f "$pidfile" ] && kill -0 "$(cat "$pidfile")" 2>/dev/null
}

print_env() {
  echo "export SSH_E2E_ADDR=127.0.0.1:$(cat "$dir/port_$name") SSH_E2E_USER=$(id -un) SSH_E2E_KEY=$dir/client_key"
}

case "$cmd" in
  start)
    mkdir -p "$dir"
    if running; then
      echo "# 已在运行（pid $(cat "$pidfile")）" >&2
      print_env
      exit 0
    fi
    if nc -z 127.0.0.1 "$port" 2>/dev/null; then
      echo "端口 $port 已被别的程序占用（可能是另一个会话的 test-sshd）。换一个：PORT=$((port + 10)) $0 $*" >&2
      exit 1
    fi
    [ -f "$dir/host_key" ] || ssh-keygen -q -t ed25519 -N '' -C evershell-test-host -f "$dir/host_key"
    [ -f "$dir/client_key" ] || ssh-keygen -q -t ed25519 -N '' -C evershell-test-client -f "$dir/client_key"
    cp "$dir/client_key.pub" "$dir/authorized_keys"
    chmod 600 "$dir/authorized_keys"
    sftp=/usr/libexec/sftp-server
    if [ -n "$noisy" ]; then
      printf '%s\n' '#!/bin/sh' 'echo "Welcome to my server"' "exec $sftp" > "$dir/noisy-sftp.sh"
      chmod +x "$dir/noisy-sftp.sh"
      sftp="$dir/noisy-sftp.sh"
    fi
    cat > "$conf" <<EOF
Port $port
ListenAddress 127.0.0.1
HostKey $dir/host_key
AuthorizedKeysFile $dir/authorized_keys
PidFile $pidfile
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes no
Subsystem sftp $sftp
EOF
    echo "$port" > "$dir/port_$name"
    /usr/sbin/sshd -t -f "$conf"
    # -D 不进后台、-e 日志写 stderr；外面用 nohup 放到后台，日志在 sshd_$name.log
    nohup /usr/sbin/sshd -D -e -f "$conf" > "$dir/sshd_$name.log" 2>&1 &
    scripts/wait-for.sh --port "$port" --timeout 10 --quiet || {
      echo "sshd 没起来，日志：" >&2
      cat "$dir/sshd_$name.log" >&2
      exit 1
    }
    echo "# 已启动 127.0.0.1:$port（日志 target/test-sshd/sshd_$name.log）" >&2
    print_env
    ;;
  env)
    running || { echo "test-sshd（$name）没在运行，先 $0 start" >&2; exit 1; }
    print_env
    ;;
  status)
    if running; then echo "运行中：127.0.0.1:$(cat "$dir/port_$name")，pid $(cat "$pidfile")"; else echo "没在运行"; exit 1; fi
    ;;
  stop)
    if running; then kill "$(cat "$pidfile")" && echo "已停止"; else echo "本来就没在运行"; fi
    rm -f "$pidfile"
    ;;
  *)
    awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
    exit 2
    ;;
esac
