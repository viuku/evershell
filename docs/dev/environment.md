# 环境和工具

## 工具链

| 工具 | 要求 | 备注 |
|---|---|---|
| Rust | stable，装在 `~/.cargo/bin` | 目标 `wasm32-unknown-unknown`，组件 `llvm-tools` |
| wasm-bindgen-cli | 版本必须等于 `Cargo.lock` 里的 wasm-bindgen | 升级 wasm-bindgen 后要 `cargo install wasm-bindgen-cli --version <新版本>` |
| Node.js | 22 以上 | npm workspaces：`apps/*`、`packages/*`、`crates/ssh-wasm/pkg` |
| Xcode 命令行工具 | swiftc、codesign、screencapture | 截图脚本第一次用时编译一个小工具 |

`scripts/setup.sh` 会逐项检查，缺什么告诉你怎么装，再补装 node_modules 和网页端的 WASM 包。新 worktree、新克隆第一次开工先跑它。

### cargo: command not found

Claude App 起的 shell 读 `~/.zshrc`，不读 `~/.zprofile`，而 rustup 把 PATH 写在 `~/.zprofile`。处理办法：

- `.claude/settings.json` 里配了 SessionStart 钩子（`scripts/claude-session-start.sh`），会话一开始就把 `scripts/dev-env.sh` 加进这个会话的环境，之后每条命令都能找到 cargo，cargo 输出也不带颜色码。
- 钩子没生效（文件还没提交、worktree 里没有）时：`. scripts/dev-env.sh && cargo …`。
- `scripts/` 下的脚本自己会 source 它，不受影响。
- 不要去改所有者的 `~/.zshrc`、`~/.zprofile`。

## 脚本

每个脚本开头的注释写着完整用法，`ls scripts/` 看最新的。

| 脚本 | 干什么 |
|---|---|
| `scripts/setup.sh` | 新文件夹初始化：查工具链、装依赖、编 WASM 包 |
| `scripts/check.sh ui\|core\|desktop\|web\|docs\|all` | 按改动范围跑检查，见 [verify.md](verify.md) |
| `scripts/test-sshd.sh start\|stop\|env\|status [--noisy]` | 本机临时 sshd，给连真服务器的测试用 |
| `scripts/wait-for.sh` | 等端口、日志里的某句话或 EverShell 窗口出现，代替手写的 sleep 循环 |
| `scripts/mac-preview.sh` | 编调试版 .app、打开、截图，给 AI 自己看原生窗口 |
| `scripts/mac-window.sh list\|id\|shot` | 给正在运行的 EverShell 窗口截图，可以裁剪放大 |
| `scripts/mac-reopen.sh` | 签名编译，放进主文件夹的 `build/EverShell.app`，退出旧版，打开新版给所有者用 |
| `scripts/build-mac.sh` | 只签名编译 `build/EverShell.app`（mac-reopen 会调用它） |
| `scripts/build-wasm.sh` | 编网页端 WASM 包到 `crates/ssh-wasm/pkg` |
| `scripts/e2e-web-ssh.mjs` | 网页链路无界面端到端测试（`check.sh web` 会调用） |
| `scripts/macos-dev-run` | cargo 的 runner：运行桌面端前先签名，见 [pitfalls.md](pitfalls.md#重新编译后钥匙串每次都弹框2026-10-18) |
| `scripts/llvm-ar` | 编 WASM 时给 ring 用的 ar |
| `scripts/check-docs.sh` | 检查说明书里写的路径还在不在 |
| `scripts/dev-env.sh`、`scripts/claude-session-start.sh` | 环境变量；会话启动钩子 |

脚本的产物和日志都放在 `target/` 下（`target/check-logs/`、`target/test-sshd/`、`target/mac-preview/`、`target/screens/`），不进 git。

## 端口

| 端口 | 谁在用 | 冲突时 |
|---|---|---|
| 5173 | 网页版 vite（`.claude/launch.json` 的 `web`） | 被别的会话占着时 preview_start 直接报错，不会自动换；改用 `web-alt` |
| 5174 | 网页版备用（`web-alt`） | |
| 1420 | `tauri dev` 的前端，写死 strictPort | 全机同一时刻只能有一个 `tauri dev`；占着就用 `scripts/mac-preview.sh` |
| 2222 / 2223 | test-sshd 普通版 / `--noisy` 版 | `PORT=xxxx scripts/test-sshd.sh start` |
| 8787 | Node 中转默认端口（`PORT` 可改） | `check.sh web` 自己用随机的 18xxx |
| 8788 | Workers 中转本地调试（wrangler dev） | |

查谁占着：`lsof -nP -iTCP:5173 -sTCP:LISTEN`。

## 几个会话同时干活

同一个文件夹同一时刻只能在一条分支上，别人没提交的改动会混进你的提交，编译目录、端口、开着的窗口也会互相踩。所以：

- **并行干活各用一个 worktree。** worktree 只带已经提交的文件，没提交的脚本和说明书在里面是没有的。
- **新 worktree 先跑 `scripts/setup.sh`**（npm install、编 WASM 包）。`target/` 不共用，第一次编 Rust 要几分钟，放后台跑。
- **还是挤在同一个文件夹里时：**
  - 开工先 `git status`，记下哪些改动不是你的。提交时只 `git add` 自己的文件，不要回退、格式化别人的文件。
  - 别关别人开的窗口和服务。`ps -o lstart,command -p <进程号>` 看启动时间和路径；`mac-preview.sh --stop` 只关它自己开的那个调试版。
  - 编译目录共用会互相等锁（`Blocking waiting for file lock`）。只是跑检查、不需要给别人用产物时，可以 `CARGO_TARGET_DIR=<你的 scratchpad>/target scripts/check.sh …` 错开，第一次要全量编（约 1~2 分钟）。
  - 不要再开一个 `tauri dev`。

## Claude 环境里的怪癖

- **shell 是 zsh。** 通配符没匹配到会直接报错：`rm -f dir/foo*`、`grep --include=*.tsx` 都会 `no matches found`。通配符加引号（`--include='*.tsx'`），或者改用 `find`。`echo ====` 也会报错（`=` 开头会被当成找命令），分隔线用 `echo '----'`。
- **没有 GNU `timeout`。** 要限时等待用 `scripts/wait-for.sh --timeout`。
- **前台长时间 `sleep` 会被拦。** 等东西就绪用 `scripts/wait-for.sh`；要一直跑的进程（开发服务器、长编译）用 Bash 的 `run_in_background`。
- **输出里的颜色码会让 grep 匹配不上。** `dev-env.sh` 已经设了 `CARGO_TERM_COLOR=never`，`wait-for.sh` 会先去掉颜色码再匹配。以前有两次等 tauri dev 启动的循环因为这个白等满 5 分钟。
- **不要用终端面板（run_in_terminal）跑开发服务器。** 所有者的 shell 启动脚本慢，新标签 60 秒都进不到提示符。用 preview_start 或 Bash 后台。
- **不要申请控制电脑、不要改系统设置**（包括深浅色外观）。原因和替代办法见 [verify.md](verify.md)。
