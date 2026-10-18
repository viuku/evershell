# 环境速查

> **管什么**：工具链、全部脚本、端口、Claude 环境里的怪癖。
> **什么时候更新**：增删、改名脚本或端口，换了工具版本，又踩到一个环境上的坑。
> **上次复核**：2026-10-18

## 工具链

需要 Rust（装在 `~/.cargo/bin`，带 `wasm32-unknown-unknown` 目标和 `llvm-tools` 组件）、和 `Cargo.lock` 同版本的 wasm-bindgen-cli、Node.js 22 以上、Xcode 命令行工具。

**新 worktree、新克隆第一次开工先跑 `scripts/setup.sh`**：它逐项检查工具链，缺什么告诉你怎么装，再补装 node_modules、编网页端的 WASM 包（没有它网页版连 `?mock` 也打不开）。已经装好的会跳过，重复跑没关系。新 worktree 第一次编 Rust 要几分钟，因为编译目录不共用。

### cargo: command not found

Claude App 起的 shell 读 `~/.zshrc` 不读 `~/.zprofile`，而 rustup 把 PATH 写在 `~/.zprofile`。处理：

- `.claude/settings.json` 里配了会话启动钩子（`scripts/claude-session-start.sh`），会话一开始就把 `scripts/dev-env.sh` 加进这个会话的环境，之后每条命令都找得到 cargo，cargo 输出也不带颜色码。所有者同意长期保留（2026-10-18）。
- 钩子管不到的地方：**子 agent**、钩子文件还没提交时的 worktree。这时命令前加 `. scripts/dev-env.sh &&`。
- `scripts/` 下的脚本自己会加载它，不受影响。
- 不要改所有者的 `~/.zshrc`、`~/.zprofile`。

## 脚本

每个脚本开头的注释写着完整用法，不带参数或参数不对时会打印出来。`ls scripts/` 看最新的。

| 脚本 | 干什么 |
|---|---|
| `scripts/setup.sh` | 新文件夹初始化：查工具链、装依赖、编 WASM 包 |
| `scripts/check.sh ui\|core\|desktop\|web\|docs\|all` | 按改动范围跑检查，选哪档见 [quality.md](quality.md#验证分级) |
| `scripts/check-guards.sh` | 守则的自动检查（check.sh 会调用） |
| `scripts/check-docs.sh` | 规范体系里写的路径、链接、锚点是否对得上（check.sh docs 会调用） |
| `scripts/test-sshd.sh start\|stop\|env\|status [--noisy]` | 本机临时 sshd，给连真服务器的测试用 |
| `scripts/web-preview.sh` | 网页版预览该用哪个地址：复用本文件夹在跑的，或者告诉你开哪条 |
| `scripts/wait-for.sh` | 等端口、日志里某句话、EverShell 窗口出现，代替手写的 sleep 循环 |
| `scripts/mac-preview.sh` | 编调试版 .app、打开、截图，给 AI 自己看原生窗口 |
| `scripts/mac-window.sh list\|id\|shot` | 给正在运行的 EverShell 窗口截图，可以裁剪放大 |
| `scripts/mac-reopen.sh` | 签名编译，放进主文件夹的 `build/EverShell.app`，退出旧版，打开新版给所有者用 |
| `scripts/build-mac.sh` | 只签名编译 `build/EverShell.app`（mac-reopen 会调用） |
| `scripts/build-wasm.sh` | 编网页端 WASM 包到 `crates/ssh-wasm/pkg` |
| `scripts/e2e-web-ssh.mjs` | 网页链路的无界面端到端测试（check.sh web 会调用） |
| `scripts/macos-dev-run` | cargo 的 runner：运行桌面端前先签名，见 [pitfalls.md](pitfalls.md#重新编译后钥匙串每次都弹框2026-10-18) |
| `scripts/llvm-ar` | 编 WASM 时给 ring 用的 ar |
| `scripts/dev-env.sh`、`scripts/claude-session-start.sh` | 环境变量；会话启动钩子 |

脚本的产物和日志都在 `target/` 下（`check-logs/`、`test-sshd/`、`mac-preview/`、`screens/`、`dev-tools/`），不进 git。设了 `CARGO_TARGET_DIR` 时检查日志跟着去那里。

## 端口

| 端口 | 谁在用 | 冲突时 |
|---|---|---|
| 5173 | 网页版开发服务器（`.claude/launch.json` 的 `web`），只听 IPv6 的 `::1` | 先跑 `scripts/web-preview.sh`：本文件夹已经在跑的直接复用，别的文件夹占着就用 5174 |
| 5174 | 网页版备用（`web-alt`） | 两个都被别的文件夹占着：launch.json 临时加一条 5175，用完删掉 |
| 1420 | `tauri dev` 的前端，写死不换 | 全机同一时刻只能有一个 `tauri dev`；自己看原生窗口用 `scripts/mac-preview.sh`，不用它 |
| 2222 / 2223 | test-sshd 普通版 / `--noisy` 版 | `PORT=xxxx scripts/test-sshd.sh start` |
| 8787 | Node 中转默认端口（`PORT` 可改） | `check.sh web` 自己用随机的 18xxx |
| 8788 | Workers 中转本地调试（wrangler dev） | |

查谁占着、是不是本文件夹开的：`lsof -nP -iTCP:5173 -sTCP:LISTEN` 拿进程号，再 `lsof -a -p <进程号> -d cwd` 看它在哪个文件夹。

## Claude 环境里的怪癖

- **shell 是 zsh。** 通配符没匹配到会直接报错：`rm -f dir/foo*`、`grep --include=*.tsx` 都会 `no matches found`。通配符加引号（`--include='*.tsx'`），或者改用 `find`。`echo ====` 也会报错（`=` 开头会被当成找命令），分隔线用 `echo '----'`。
- **没有 GNU `timeout`。** 要限时等待用 `scripts/wait-for.sh --timeout`。
- **前台长时间 `sleep` 会被拦。** 等东西就绪用 `scripts/wait-for.sh`；一直跑的进程和长编译用 Bash 的 `run_in_background`。Bash 默认 2 分钟超时。
- **输出里的颜色码会让 grep 匹配不上。** `dev-env.sh` 已经设了 `CARGO_TERM_COLOR=never`，`wait-for.sh` 先去掉颜色码再匹配。以前有两次等 `tauri dev` 启动的循环因为这个白等满 5 分钟。
- **不要用终端面板（run_in_terminal）跑开发服务器。** 所有者的 shell 启动脚本慢，新标签 60 秒都进不到提示符。用 `preview_start` 或 Bash 后台。
- 浏览器预览的小毛病（只能打开到端口、复原窗口大小不复原深浅色）写在 [quality.md](quality.md#a-网页版-mock界面改动的主力) 的步骤里。
