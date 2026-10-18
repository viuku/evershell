#!/bin/sh
# Claude Code 的 SessionStart 钩子（配置在 .claude/settings.json）。
# 把 scripts/dev-env.sh 里的环境写进 $CLAUDE_ENV_FILE，之后这个会话里每条命令都带着它，
# 不用再手动 export PATH。不输出任何东西，免得占上下文。
[ -n "$CLAUDE_ENV_FILE" ] || exit 0
root=$(cd "$(dirname "$0")/.." && pwd)
printf '. "%s/scripts/dev-env.sh"\n' "$root" >> "$CLAUDE_ENV_FILE"
