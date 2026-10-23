# 质量关卡

> **管什么**：改完怎么验（按改动选一档）、每种验法的具体做法、什么必须有测试、守则的自动检查、哪些要所有者自己试。
> **什么时候更新**：加了新的验法或检查、某种改动反复漏验、验证步骤和实际对不上。
> **上次复核**：2026-10-18

## 验证分级

分级表在总纲 [CLAUDE.md](../../CLAUDE.md#改完怎么验)（每个会话都会读到，只在那里维护一份）。这里讲每种验法具体怎么做。

## A. 网页版 `?mock`：界面改动的主力

假后端（`packages/ui/src/mock`）模拟连接、终端、文件和监控，不用连服务器。桌面端和网页端用的是同一套界面代码，所以界面改动在这里验就够了。用 App 的**内置浏览器**（`mcp__Claude_Browser__*` 这组工具），不用 Chrome 扩展。

1. **打开预览**：先跑 `scripts/web-preview.sh`，它只推荐一个地址：本文件夹已经有在跑的网页版就直接 `navigate` 过去（改动会热更新）；没有的话告诉你 `preview_start` 哪一条。`preview_start` 只能打开到端口为止，打开后再 `navigate` 到带 `/?mock` 的地址。新 worktree 先 `scripts/setup.sh`，没有 WASM 包网页版打不开。共享文件夹里别的会话也在改界面时，热更新会把它没写完的改动一起显示出来，这种情况要在自己的 worktree 里验。
2. **窗口大小**设成桌面版默认的 1200×780：`resize_window {width: 1200, height: 780, colorScheme: "dark"}`。
3. **深色**：先确认应用里的“外观”是“跟随系统”——`javascript_tool` 跑 `localStorage.getItem('evershell.appearance-mode')`，结果是 `null`（从没改过）或者带引号的 `"system"`（存的是 JSON）才对。不对就点右上角菜单（≡）→ 外观 → 跟随系统。然后截图、看细节。
4. **改了深色的颜色变量时，再验一次手动深色**：菜单 → 外观 → 深色，核对一遍，**马上**切回“跟随系统”。深色变量写了两组，跟随系统只用到其中一组（见 [pitfalls.md](pitfalls.md#颜色要一起改的几处)）。这个设置存在浏览器里，同一个地址的其他预览也会跟着变，所以别忘了切回。
5. **浅色**：`resize_window {colorScheme: "light"}`，截图、核对。改了次要文字、主文字的颜色时，浅色界面下再换一个深色的终端背景预设，看选中标签上的字：选中标签的文字颜色跟着终端底色走，不跟界面深浅走。
6. **收尾**：`resize_window {preset: "desktop"}` 只恢复窗口大小，不动深浅色模拟，要另外把 colorScheme 设回所有者 App 的主题（拿不准就设 dark）。
7. **看连上服务器后的样子**：左上角文件夹图标打开连接管理器 →「新建连接」→ 主机随便填（如 `demo.local`）、填个用户名 → 保存 → 选中后连接。第一次连每台假服务器都会先弹主机密钥确认，和真的一样。约定的特殊输入（完整说明在 `packages/ui/src/mock/mock-backend.ts` 开头的注释）：
   - 主机含 `fail`：连接失败；含 `bsd`：监控不支持；密码填 `wrong`：认证失败。
   - 主机含 `rekey`：接受过一次主机密钥后再连，服务器会换一把，看“密钥已经改变”的警告。
   - 主机含 `flaky`：连上 8 秒后像网络断了一样断开，看断线提示。
   - 主机含 `slow`：网络很慢，列目录、查文件信息多等 1.5 秒，传文件约 20KB/s，看“加载中”和进度。和 `nopass` 一起用（如 `nopass-slow.local`）就不用填密码。
   - 密码留空时只有主机含 `nopass` 能直接连上（模拟不要密码的服务器）；其他主机先报认证失败，再弹框要密码。

   连接列表存在浏览器里，下次还在（5173 和 5174 各存各的）。
8. **核对细节**：
   - 放大看：`computer {action: "zoom"}`；
   - 文字：`get_page_text` / `find`；点元素先用 `find` 按文字拿 ref，比按坐标稳；
   - 颜色：读变量 `getComputedStyle(document.querySelector('.app')).getPropertyValue('--muted')`；文字颜色用 `getComputedStyle(元素).color`，背景用 `.backgroundColor`。注意 `.app-root` 是 `display: contents`，在它上面读不到。

**小的视觉改动**（调颜色、间距、字号）不用出设计稿，改前改后各截一张对比图给所有者挑（[process.md](process.md#2-设计稿)）。颜色要保证看得清：正文和背景的对比度至少 4.5:1（网页无障碍标准 WCAG AA 的要求）。

网页版看不到的：原生标题栏和红绿灯、窗口拖动、菜单栏、钥匙串、本机文件对话框。这些走 B。

## B. 原生窗口：只截图，不操作

用在：窗口外观（标题栏、红绿灯、透明、拖动区域）、`tauri*.conf.json`、`capabilities/`、`apps/desktop/src` 里只在桌面端生效的代码。

1. `scripts/mac-preview.sh`：编调试版 .app → 关掉它自己上次开的那个 → 打开 → 等窗口出现 → 截图。最后一行是截图路径，用 Read 看。调试版编好后会搬进 `target/mac-preview/app.noindex/`，聚焦搜索不收录。
2. 放大细节：`scripts/mac-window.sh shot --pid <进程号> --crop x,y,宽,高`，坐标用窗口里的点（和 CSS 像素一样），自动换算 Retina。
   - 看连接管理器窗口：`EVERSHELL_OPEN=manager scripts/mac-preview.sh`，调试版启动 4 秒后会把它亮出来（只有调试版认这个变量），再 `scripts/mac-window.sh shot --pid <进程号> --name 连接管理器`（`--name` 按窗口标题找）。编辑窗口要先连上服务器，开不出来，请所有者截图。
   - 看点主窗口关闭按钮后的“确定关闭窗口吗”：`EVERSHELL_OPEN=close scripts/mac-preview.sh`，调试版启动 4 秒后会像点了关闭按钮一样，再截主窗口。
3. 看完 `scripts/mac-preview.sh --stop`。它只关自己开的调试版并删掉它，所有者在用的窗口不受影响。所有者要求电脑上只留 `build/` 这一份应用（2026-10-23）。
4. 截图报错或截出来全黑：所有者的屏幕锁着（[pitfalls.md](pitfalls.md#屏幕锁着时截不了原生窗口2026-10-18)），等他回来或请他看。

**为什么不能点、不能操作**：

- 不申请“控制电脑”。所有者不会点授权，以前两次都白等到超时。后台往 Tauri 窗口发按键还会丢键，模拟拖动也带不动窗口。
- 不改系统设置，包括系统深浅色。所以原生窗口只能看到系统当前的颜色（所有者平时用深色）。另一种颜色：界面部分在网页版看，标题栏这类原生部分请所有者切换后截图。
- 调试版和所有者的正式版共用数据，只看不动（[pitfalls.md](pitfalls.md#调试版和正式版共用所有者的真实数据)）。

## C. Rust 测试和本机测试服务器

- `scripts/test-sshd.sh start`：127.0.0.1:2222，密钥登录，带 SFTP。本文件夹已经在跑就直接复用。`scripts/check.sh` 发现它在跑会自动带上，结果里会注明“用 test-sshd”还是“会被跳过”。
- **在 worktree 里**，主文件夹的 test-sshd 对你是“没在运行”，2222 又被它占着，要换端口：`PORT=2232 scripts/test-sshd.sh start`。
- **没开的话，连真服务器的测试会打印“跳过”然后算通过**，“全部通过”不等于连服务器测过。
- 只跑一个测试：`eval "$(scripts/test-sshd.sh env)" && cargo test -p ssh-core --test real_server sftp_roundtrip`（按名字子串匹配，全名是 `sftp_roundtrip_in_tmpdir`）。
- `--noisy`：SFTP 启动前打印一行字，复现“登录脚本有输出”的服务器。
- **开工前就在跑的 test-sshd 不是你的，用完别 stop**；自己开的用完 `scripts/test-sshd.sh stop`，不停也行。
- 测试服务器是 macOS 自带的 sshd，测不了 Linux 专属的东西（见 E）。

## D. 网页链路

`scripts/check.sh web`：重编 WASM 包、类型检查；test-sshd 开着时临时起一个 Node 中转，跑 `scripts/e2e-web-ssh.mjs`（主机密钥确认、终端、50 次按键顺序、2MB 输出、`yes` 后 Ctrl-C 多快停下、监控（含改进程 / 网络详情后马上重采）、系统信息、SFTP 上传下载）。

- 新 worktree 先 `npm install --prefix services/relay-node`，不然中转起不来，端到端测试报“超时（10s）”（[pitfalls.md](pitfalls.md#网页端到端测试报超时10s2026-10-18)）。

- 它会重写 `crates/ssh-wasm/pkg`，本文件夹开着的网页版会跟着刷新。
- Workers 中转的本地调试见 [m0-report.md](../m0-report.md) 的“怎么在本机复现”。
- 在浏览器里用真后端：网页版不带 `?mock`，菜单里“中转设置…”填中转地址和令牌。

## E. 要所有者自己试的

这些自动化验不了，写进回复请他试：

- 原生窗口里的交互：拖动窗口、菜单、快捷键、钥匙串弹框。
- 连他自己的 Linux 服务器：监控数据（读 `/proc`）、密码登录、二次验证、他服务器上的登录脚本。
- 细微的视觉问题：请他截图，不要自己操作电脑去看。

## 什么必须有测试

| 改动 | 测试 | 放哪 |
|---|---|---|
| 导入导出的解析 | 单元测试 + 编造的样例文件（不用任何人的真实配置） | `packages/ui/src/core/importers/__tests__`、`__fixtures__` |
| 加密、保险箱 | 单元测试，含打不开、钥匙不对、版本更高等异常情况 | `crates/vault`、`apps/desktop/src-tauri/src/secrets.rs` |
| 数据格式升级 | 每个旧版本留一份样例，测迁移（规则见 [data.md](data.md#格式版本和迁移)） | 和格式代码放一起 |
| SSH 协议行为 | 连 test-sshd 的测试（真的 OpenSSH） | `crates/ssh-core/tests/real_server.rs`、`apps/desktop/src-tauri/tests` |
| 异常服务器（不说话、超时、发怪数据） | 进程内的假服务器，想让它怎么坏就怎么坏 | `crates/ssh-core/tests/shell.rs` 的 `start_server` |
| 网页链路 | `scripts/e2e-web-ssh.mjs` | |
| 修 bug | 能写就先写一个会失败的测试 | 跟着被测代码 |

界面目前没有自动化测试，靠网页版 `?mock` 看。终端显示的手测清单在 [compatibility.md](compatibility.md#终端显示)。

## 守则的自动检查

`scripts/check-guards.sh`（`check.sh ui` 和 `core` 会跑）把能机械判断的规矩变成检查：`packages/ui` 不准 import Tauri、不准直接读写浏览器存储、组件里不准写死 ⌘；内核里不准直接起 tokio 或系统线程、不准直接用 `std::time::Instant` 或 `tokio::time`；依赖里不准出现 aws-lc。

AI 最常犯的错是知道规矩、写的时候忘了，所以**新定的规矩能用 grep 判断的，都加进这个脚本**，照脚本里的样子写一条，违反时提示怎么改（调研附录 A 第 3.3 节，参照 Clash Verge Rev 的做法）。

## 看设计稿

`docs/design/*.dc.html` 是设计工具的源文件。内置浏览器打开在线版要登录 claude.ai，不能替所有者登录，所以在本地看：

1. 用主会话的 Artifact 工具（子 agent 没有它）：`Artifact {action: "read", url: "<在线版地址>", path: "artifact-type/dc-runtime.js"}` 取设计稿类型的运行时文件，存成 `support.js`，和要看的 `.dc.html` 一起放进 scratchpad 的同一个目录。在线版地址在 [docs/design/README.md](../design/README.md)。
2. `.claude/launch.json` 临时加一条 `python3 -m http.server <端口> --bind 127.0.0.1 --directory <那个目录>`，`preview_start` 打开。
3. 深浅色用 `resize_window` 的 `colorScheme` 切。用完把 launch.json 里那条删掉。

## 还没建的

- **CI**（M1 收尾时建，建之前问所有者，因为要在公开的 GitHub 仓库上开功能）：一个跑在 macOS 上的 workflow 调 `scripts/check.sh all`，加 cargo-deny（漏洞 + 协议）和 Dependabot；Actions 按提交 SHA 固定，默认只读权限（调研附录 B 第 13 节）。
- **性能预算**（终端回压做完后定）：比如 `yes` 跑 10 秒后 Ctrl-C 1 秒内停、`cat` 大文件内存不无限涨。基准用 vtebench 手测，有回归再进 CI（调研附录 C 第 4 节）。
