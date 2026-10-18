#!/bin/sh
# 把 CLAUDE.md 的守则和 docs/handbook/pitfalls.md 里能机械判断的规矩变成检查，违反就失败。
# scripts/check.sh ui / core 会自动跑它；单独跑：scripts/check-guards.sh
#
# 加新规矩：在下面照样子加一条 rule，写清楚对应哪条守则或哪个坑，违反时提示怎么改。
# 确实要破例时，把那一行的路径加进该规则的排除里，并在对应的分册写明原因。
cd "$(dirname "$0")/.."

failed=0
# rule 说明 命令：命令有输出就算违反
rule() {
  desc=$1
  shift
  hits=$("$@" 2>/dev/null)
  if [ -n "$hits" ]; then
    echo "✗ $desc"
    printf '%s\n' "$hits" | head -10 | sed 's/^/    /'
    failed=1
  fi
}

# 守则 1：packages/ui 不能依赖 Tauri，平台能力走 SshBackend 接口
rule "packages/ui 里出现了 @tauri-apps（守则 1：平台能力走 types.ts 的接口）" \
  grep -rn --include='*.ts' --include='*.tsx' "@tauri-apps/" packages/ui/src

# 守则 5：本地数据只经过 core/storage.ts
rule "packages/ui 里直接读写了浏览器存储（守则 5：改用 core/storage.ts）" \
  sh -c "grep -rn --include='*.ts' --include='*.tsx' -E '(localStorage|sessionStorage|indexedDB)\.' packages/ui/src | grep -v 'packages/ui/src/core/storage.ts'"

# 守则 3：界面里不写死 ⌘，快捷键文字走 core/platform.ts
rule "组件里写死了 ⌘（守则 3：用 core/platform.ts 的 shortcutLabel / modEnterLabel）" \
  grep -rn --include='*.tsx' --include='*.ts' "⌘" packages/ui/src/components

# 坑：内核起后台任务要用 crate::spawn，否则 WASM 跑不起来
rule "内核里直接起了 tokio / 系统线程（用 crate::spawn，见 pitfalls.md）" \
  sh -c "grep -rn -E 'tokio::spawn|thread::spawn' crates/ssh-core/src crates/vault/src crates/ssh-wasm/src | grep -v 'crates/ssh-core/src/lib.rs:.*tokio::spawn(fut)'"

# 坑：计时也要走内核自己的 crate::now / crate::sleep，std::time::Instant 和 tokio::time 在浏览器里会 panic
rule "内核里直接用了 std::time::Instant 或 tokio::time（用 crate::now / crate::sleep，见 architecture.md 运行时约定）" \
  sh -c "grep -rn -E 'std::time::Instant|tokio::time' crates/ssh-core/src crates/vault/src crates/ssh-wasm/src | grep -v -E 'crates/ssh-core/src/lib.rs:[0-9]+:(pub\(crate\) use std::time::Instant;| +tokio::time::sleep\(d\)\.await)\$'"

# 坑：aws-lc-rs 编不出 WASM，加密后端只用 ring
rule "依赖里出现了 aws-lc（只能用 ring，见 pitfalls.md；用 cargo tree -i 找是谁拉进来的）" \
  grep -n -E '^name = "aws-lc' Cargo.lock

if [ $failed = 0 ]; then
  echo "守则检查全部通过"
else
  exit 1
fi
