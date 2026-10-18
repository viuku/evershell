# 怎么验证

按改动范围选一档（[CLAUDE.md](../../CLAUDE.md) 里那张表），只走需要的那档，别每次把所有验法都过一遍。验完在回复里说清楚验了什么、没验什么、哪些要所有者自己试。

两条禁令，原因写在这里，免得再犯：

- **不申请“控制电脑”**（computer-use 的授权、全屏控制）。所有者不会点，以前两次都白等到超时（290 秒）。原生窗口用脚本截图，交互放到网页版里测，或者请所有者试。
- **不改系统设置**，包括切换系统深浅色。要看另一种颜色，用网页版的深浅色模拟。

## A. 网页版 `?mock`：界面改动的主力

假后端（`packages/ui/src/mock`）模拟连接、终端、文件和监控，不用连服务器，桌面端和网页端共用同一套界面代码，所以界面改动在这里验就够了。

1. 新 worktree 先 `scripts/setup.sh`：网页版即使用 `?mock` 也要 WASM 包，否则 vite 报找不到 `@evershell/ssh-wasm`。
2. `preview_start {name: "web"}`；报端口被别的会话占用就用 `"web-alt"`（5174）。打开 `http://localhost:5173/?mock`（或 5174）。
3. 窗口大小设成桌面版默认的 1200×780：`resize_window {width: 1200, height: 780, colorScheme: "dark"}`，截一张；再 `colorScheme: "light"` 截一张。用完 `preset: "desktop"` 复原。
4. 右上角菜单（≡）里的“外观”要保持“跟随系统”，否则深浅色模拟不起作用（见 [pitfalls.md](pitfalls.md#应用里的外观设置会盖过系统)）。
5. 要看连上服务器后的样子：左上角文件夹图标打开连接管理器 →「新建连接」→ 主机随便填（如 `demo.local`）、填个用户名 → 保存 → 选中后连接。约定的特殊输入：主机含 `fail` 连接失败，含 `bsd` 监控不支持，密码填 `wrong` 认证失败。连接列表存在浏览器里，下次打开还在（5173 和 5174 各存各的）。
6. 看细节：`computer {action: "zoom"}` 放大一块；`get_page_text` / `find` 核对文字；颜色核对用 `javascript_tool` 跑 `getComputedStyle(元素).backgroundColor`。
7. 界面上的元素用 `find` 按文字找 ref 再点，比按坐标点稳。

网页版看不到的：原生标题栏和红绿灯、窗口拖动、菜单栏、钥匙串、本机文件对话框。这些走 B。

## B. 原生窗口：只截图，不操作

用在：窗口外观（标题栏、红绿灯、透明、拖动区域）、`tauri*.conf.json`、`capabilities/`、`apps/desktop/src` 里只在桌面端生效的代码。

1. `scripts/mac-preview.sh`：编调试版 .app（改动小时十几秒）→ 关掉它上次开的那个 → 打开 → 等窗口出现 → 截图。最后一行是截图路径，用 Read 看。
2. 放大细节：`scripts/mac-window.sh shot --pid <进程号> --crop x,y,宽,高`，坐标用窗口里的点（和 CSS 像素一样），会自动换算 Retina。
3. 看完 `scripts/mac-preview.sh --stop`。

限制：

- 只能看到系统当前的深浅色（所有者平时用深色）。另一种颜色界面部分在网页版看；标题栏这类原生部分请所有者切换后截图。
- 不能点、不能拖。要交互验证的（拖动窗口、菜单、快捷键、连接真实服务器）写进回复，请所有者试。
- 调试版和所有者的正式版共用数据，只看不动（见 [pitfalls.md](pitfalls.md#调试版和正式版共用所有者的真实数据)）。

## C. Rust 测试和本机测试服务器

- `scripts/test-sshd.sh start`：127.0.0.1:2222，密钥登录，带 SFTP。开着时 `scripts/check.sh core|desktop|web` 会自动用它，并在结果里注明。
- 没开的话，连真服务器的测试会打印“跳过”然后算通过。“全部通过”不等于连服务器测过。
- 只跑一个测试：`eval "$(scripts/test-sshd.sh env)" && cargo test -p ssh-core --test real_server sftp_roundtrip`。
- `--noisy`：SFTP 启动前打印一行字，用来复现登录脚本有输出的服务器。
- 测试服务器是 macOS 自带的 sshd，Linux 监控（读 `/proc`）、密码登录、二次验证测不了，请所有者用自己的服务器试。
- 用完 `scripts/test-sshd.sh stop`（不停也行，文件都在 `target/test-sshd/`）。

改内核时 `check.sh core` 已经包含 [CLAUDE.md](../../CLAUDE.md) 守则 2 要求的 WASM 编译检查（ssh-wasm 和 vault 两个都查）。

## D. 网页链路

`scripts/check.sh web`：重编 WASM 包、类型检查；test-sshd 开着时临时起一个 Node 中转，跑 `scripts/e2e-web-ssh.mjs`（终端、50 次按键顺序、2MB 输出、监控、SFTP 上传下载）。Workers 中转的本地调试见 [m0-report.md](../m0-report.md) 的“怎么在本机复现”。

要在浏览器里用真后端：网页版不带 `?mock`，菜单里“中转设置…”填中转地址和令牌。

## E. 交给所有者用

所有者要的是签名编译好的 `build/EverShell.app`，不打 dmg。改完他要用的功能后：

- `scripts/mac-reopen.sh`：签名编译（release，几分钟）→ 放进主文件夹的 `build/EverShell.app`（在 worktree 里跑也放那里，所有者只认这一个位置）→ 退出他正在用的旧版 → 打开新版。不先退出的话，系统只会把旧窗口叫到前面，打开的还是旧版。别的会话开的调试版不受影响。
- 它会断开所有者正在用的连接，跑之前在回复里说一声。
- 回复里写清楚：这次改了什么、来自哪个分支、请他试哪几步。

## F. 设计稿本地预览

`docs/design/*.dc.html` 是设计工具的源文件，内置浏览器打开在线版要登录 claude.ai（不能替所有者登录）。本地看的办法：

1. 用 Artifact 的 read 取设计稿类型的运行时文件 `artifact-type/dc-runtime.js`，存成 `support.js`，和要看的 `.dc.html` 一起放进 scratchpad 的同一个目录。
2. `.claude/launch.json` 临时加一条：`python3 -m http.server <端口> --bind 127.0.0.1 --directory <那个目录>`，`preview_start` 打开。
3. 深浅色用 `resize_window` 的 `colorScheme` 切。用完把 launch.json 里那条删掉。

在线版地址在 [docs/design/README.md](../design/README.md)。
