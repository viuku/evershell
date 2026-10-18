# 开发环境变量，用法：. scripts/dev-env.sh（sh / bash / zsh 都能 source）
#
# Claude 桌面 App 起的 shell 不读 ~/.zprofile，~/.cargo/bin 不在 PATH 里，cargo 会报
# command not found。这里补上，顺便关掉 cargo 的颜色码，免得 grep 日志时匹配不上。
# scripts/ 下的脚本自己会 source 它；Claude 会话由 .claude/settings.json 的 SessionStart
# 钩子（scripts/claude-session-start.sh）自动加载，一般不用手动 source。

if [ -d "$HOME/.cargo/bin" ]; then
  case ":$PATH:" in
    *":$HOME/.cargo/bin:"*) ;;
    *) PATH="$HOME/.cargo/bin:$PATH" ;;
  esac
fi
export PATH
export CARGO_TERM_COLOR=never
