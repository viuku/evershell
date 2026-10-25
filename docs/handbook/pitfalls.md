# 已知坑

> **管什么**：第三方库、平台里已经查清楚的问题，以及还没解决的已知问题。
> **什么时候更新**：新查清一个坑就加一条，写上日期；坑不存在了（上游修了、代码删了）就删掉那条。
> **上次复核**：2026-10-18

碰到奇怪现象先在这里搜症状（报错原文、关键词），别再去翻依赖源码。每条的格式：**症状** → **原因** → **现在的处理**（在哪）→ 什么时候能去掉。环境和 shell 的小毛病在 [environment.md](environment.md#claude-环境里的怪癖)，安全方面的已知缺口在 [security.md](security.md#已知缺口2026-10-18)，这里只放跟代码有关的。

## 还没解决的

### SFTP 报 packet length limit exceeded（2026-10-18）

- **症状**：连上所有者的服务器那一秒，桌面端日志出现 `WARN russh_sftp::client Bad message: packet length limit exceeded`，文件面板可能用不了。本机 test-sshd 上不出现。
- **推测的原因（没确认）**：服务器的登录脚本（`~/.bashrc` 之类）在非交互会话里往标准输出打印了文字，混进 SFTP 数据流，russh-sftp 把开头几个字节当成包长，长度超限。russh 的 `into_stream` 只读标准输出不读标准错误，所以是标准输出上的文字。
- **复现**：`scripts/test-sshd.sh start --noisy`（SFTP 启动前先打印一行字），然后 `eval "$(scripts/test-sshd.sh env --noisy)" && cargo test -p ssh-core --test real_server sftp_roundtrip`（按名字子串匹配，全名 `sftp_roundtrip_in_tmpdir`）。
- **打算的处理**：在 `crates/ssh-core/src/sftp.rs` 打开 SFTP 时识别这种情况，给出中文提示“服务器登录时输出了文字，干扰了文件传输”，并告诉用户怎么改登录脚本。

### 全屏时收起侧栏，标签栏左边空一段（2026-10-18）

标签栏在侧栏收起时给红绿灯让出 78px（见下面“标题栏”一条），但全屏时红绿灯是藏起来的，这段空白没必要。要监听全屏状态再决定让不让。

## Rust 内核和 WASM

### 加密后端只能用 ring，不能用 aws-lc-rs（M0）

- **症状**：编 wasm32 时 aws-lc-rs 编不过；或者 russh 报 `requires enabling either the ring or aws-lc-rs feature`。
- **处理**：根目录 `Cargo.toml` 的 `[workspace.dependencies]` 里 russh 关掉默认特性、只开 `ring`，桌面端也用 ring，两边一致。
- **加新依赖时**（rustls、reqwest、各种加密库）先确认它不会把 aws-lc-rs 拉进来：`cargo tree -p ssh-wasm --target wasm32-unknown-unknown -i aws-lc-rs`，报“找不到这个包”才是对的。

### ring 编 WASM 要用 llvm-ar（M0）

- **症状**：编 wasm32 时 ring 的 C 代码链接缺符号。
- **原因**：macOS 自带的 `ar` 不认 WASM 目标文件。
- **处理**：`.cargo/config.toml` 的 `AR_wasm32_unknown_unknown` 指向 `scripts/llvm-ar`，它调 rustup 的 llvm-tools（`rustup component add llvm-tools`）。这个包装脚本是 sh 写的，以后 Windows 开发机要另配。

### 随机数：getrandom 两个大版本都要打开浏览器后端（M0）

ring 用 getrandom 0.2，russh 和 vault 用 0.3。wasm32 下 0.3 要开 `wasm_js` 特性，0.2 要开 `js` 特性（`crates/ssh-core/Cargo.toml` 里用 `getrandom_02` 这个别名引入）。新 crate 在 wasm32 下要用随机数，照抄这两行。

### russh 的定时器在浏览器里 panic（M0，vendor 补丁）

- **原因**：russh 直接调 `tokio::time`，它依赖 `std::time::Instant`，wasm32 上没有实现。
- **处理**：`vendor/russh` 是打了补丁的 russh 0.64.1，根 `Cargo.toml` 的 `[patch.crates-io]` 指过去。同一个补丁还修了 CHANNEL_CLOSE（客户端先关的通道收不到退出事件）。改动和升级步骤见 [vendor/README.md](../../vendor/README.md)。
- **注意**：升级 russh 必须重新打补丁；上游修好后删掉 vendor 和 `[patch.crates-io]`。

### 内核里起后台任务、计时，都要走内核自己的函数

`crates/ssh-core/src/lib.rs` 里有三个按平台区分的函数：`spawn`（原生转给 `tokio::spawn`，WASM 转给 `spawn_local`）、`now`（原生 `std::time::Instant`，WASM 用 web-time）、`sleep`（原生 tokio，WASM 用浏览器定时器）。直接写 `tokio::spawn`、`std::thread`、`std::time::Instant`、`tokio::time`，原生平台照样能编能跑，到浏览器里才编不过或 panic，只有 `scripts/check.sh web` 才发现得了。`scripts/check-guards.sh` 会拦这几种写法。

### 终端输出暂停时，整条 SSH 连接都会跟着慢（2026-10-18）

- **症状**：终端在刷大量输出（`yes`、`cat` 大文件）时，同一条连接上的文件面板、监控也变慢，等终端画完才恢复。
- **原因**：russh 收到数据就给服务器补窗口，不管程序读没读；程序不读时，它的会话循环卡在往通道缓冲里塞数据那一步，整条连接的所有通道一起停。所以回压（`crates/ssh-core/src/flow.rs`）是靠堵住整个会话循环、再由 TCP 把服务器挡住实现的，不是按通道流控。
- **影响多大**：Ctrl-C 之后还要画完已经在路上的数据，上限约 2MB 窗口 + russh 每个通道 100 条消息 + 我们的 256KB 水位线。实测本机 OpenSSH 上 `yes` 10 秒、界面按 10MB/s 画，Ctrl-C 后 0.24 秒停下；网页版真 xterm.js 0.36 秒；不限速时要等 100 多秒（测试 `crates/ssh-core/tests/shell.rs` 的 `real_openssh_yes_then_ctrl_c`，设 `EVERSHELL_NO_FLOW=1` 可以看不限速的样子）。
- **真要按通道流控**：得改 vendor 里的 russh，让它在程序读走数据之后才补窗口。

### OpenSSH 文档说心跳 3 次约 45 秒判死，实际是 60 秒（2026-10-18）

`ServerAliveInterval 15` + `ServerAliveCountMax 3`，ssh_config 手册写“约 45 秒”，但 OpenSSH 源码是第 4 次到点、计数超过 3 才断开，约 60 秒。russh 的 `keepalive_max` 意思一样。EverShell 用同样的数，断线提示写“约 1 分钟”，文案按实际设置算出来，改参数不用改文案。

### russh 自带的 known_hosts 不能用（2026-10-18）

`russh::keys::known_hosts` 直接读写 `~/.ssh/known_hosts` 文件，wasm32 下整个模块都没编进去，也不认 `@revoked`、通配和 `!`。所以主机密钥校验自己写在 `crates/ssh-core/src/known_hosts.rs`，记录由界面存（桌面端保险箱、网页端浏览器），连接时整段传进来。哈希主机名的算法用 macOS 自带 `ssh-keygen -H` 生成的行做了单元测试。

### 浏览器的 WebSocket 不能跨线程（M0）

russh 要求字节流能跨线程（`Send`），浏览器的 WebSocket 不行。`crates/ssh-wasm` 中间放了一个内存管道，两头各一个任务搬数据。别想着把 WebSocket 直接塞给 russh。

## 桌面端（Tauri）

### 新开的窗口先白一下（2026-10-23）

- **症状**：深色模式下打开连接管理器、编辑器这类独立窗口，窗口先是白的，过一会儿才变成界面。
- **原因**：网页还没画出来时，WKWebView 自己铺一层白底。wry 只有在建窗口时设了 `background_color` 才关掉这层白底（私有属性 `drawsBackground`），露出窗口的底色。
- **处理**：`apps/desktop/src-tauri/src/windows.rs` 建窗口时把界面当前的底色（前端读 `--content` 传过来）设成 `background_color`。没用“先藏起来、画好再显示”：窗口藏着时 WebKit 可能暂停绘制和定时器，反而更慢。

### 网页里选的云盘文件读不出来，选了没反应（2026-10-25）

- **症状**：所有者在编辑连接里点私钥的「选择…」，选了 OneDrive 里的私钥，界面上什么都没变。私钥文件没有隐藏。
- **原因（按 WebKit 的已知问题推断，没在所有者的文件上确认）**：`<input type="file">` 选中的文件由 WKWebView 的网页进程去读。OneDrive、iCloud 里“仅在线”的文件本机只有占位，网页进程读不出内容（WebKit bug 191069、226090 是同一类问题），`file.text()` 失败。原来的代码没接住这个失败，所以看起来没反应。
- **现在的处理**：桌面端选私钥改走 Rust：`apps/desktop/src-tauri/src/local_file.rs` 自己弹系统的选文件框（NSOpenPanel），再由应用进程读文件，系统会先把文件下载下来；前端接口是 `SshBackend.pickPrivateKeyFile`。网页端照旧用网页的选文件框，读失败时提示先把文件下载到本机。
- **还没处理的**：上传文件、导入别的软件的配置、终端背景图还走网页的选文件框，云盘里“仅在线”的文件一样会读不出来，要改时照这个办法。

### 同步的 Tauri 命令没有 tokio 运行时，一 spawn 就整个应用闪退（2026-10-18）

- **症状**：连上服务器后应用直接消失。日志：`there is no reactor running, must be called from the context of a Tokio 1.x runtime`，接着 `fatal runtime error: failed to initiate panic`。
- **原因**：不带 `async` 的 `#[tauri::command]` 跑在主线程上，那里没有 tokio 运行时。当时 `ssh_monitor_start` 是同步命令，一路调到内核的 `spawn` 就崩了。
- **规矩**：命令只要会直接或间接用到 tokio（spawn、网络、计时），就写成 `async fn`。现在只有不碰 tokio 的几个（写入、调整窗口、关闭、停监控）是同步的，改它们时留意。这条没法用 grep 判断，靠测试：`apps/desktop/src-tauri/tests/session.rs` 连 test-sshd 跑的就是真实的命令路径。

### 开了 CSP 以后 xterm.js 的样式会被拦（2026-10-18）

- **症状**：终端没颜色、光标不见。
- **原因**：xterm.js 的 DOM 渲染器在运行时往页面里插 `<style>`，CSP 的 `style-src` 不放行 `'unsafe-inline'` 就全被拦。而 Tauri 打包时会自动往 `style-src` 加 nonce，浏览器看到 nonce 就忽略 `'unsafe-inline'`。
- **处理**：`apps/desktop/src-tauri/tauri.conf.json` 的 `style-src` 带 `'unsafe-inline'`，同时 `dangerousDisableAssetCspModification: ["style-src"]` 不让 Tauri 给它加 nonce。`script-src` 照常由 Tauri 加 nonce，禁远程脚本和 eval。
- **桌面端没有 WASM**，所以 `script-src` 没加 `'wasm-unsafe-eval'`；以后桌面端要加载 WASM 时要加上。
- **只在打包出来的应用里生效**：`tauri dev` 直接加载 vite 的页面，Tauri 不给它加 CSP。改 CSP 后的验法：`npm run build -w @evershell/web`，用带同样 CSP 头的静态服务器托管 `apps/web/dist`，打开 `?mock` 连一个假会话，看控制台有没有 CSP 报错、终端有没有颜色。

### invoke 的参数名和数据怎么传

- JS 传驼峰，Rust 收下划线，Tauri 自动转：`isDir` ↔ `is_dir`。写错了不报编译错，运行时报缺参数。
- 二进制数据（按键、上传、保存文件）作为请求体直接传，会话号、文件名等放请求头（`x-session`、`x-name`）；Rust 端收 `tauri::ipc::Request`。远端输出、监控数据、传输进度用 `Channel` 推回前端。
- 每次 invoke 是一个独立请求，到达顺序没保证。按键顺序靠两层队列：`apps/desktop/src/tauri-backend.ts` 的 `enqueue` 串成一条链，Rust 端每个会话一个写入队列。别为了“简化”拿掉。

### 重新编译后，钥匙串每次都弹框（2026-10-18）

- **原因**：没签名的程序每编一次，钥匙串就当成新程序，“始终允许”只管到下一次编译。
- **处理**：`scripts/macos-dev-run` 设成 cargo 的 runner（`.cargo/config.toml`），运行桌面端前先用本机的 Developer ID / Apple Development 证书签名（环境变量 `EVERSHELL_SIGN_IDENTITY` 可以指定）。`cargo test` 的测试程序也会经过它，但只有 `evershell-desktop` 会被签名。
- **它没有执行权限时**，所有 `cargo run` / `cargo test` 都报 `could not execute process … macos-dev-run … Permission denied (os error 13)`，`chmod +x scripts/macos-dev-run`。
- 换签名证书后，每条已保存的连接还会再问一次，请所有者点“始终允许”。保险箱（`crates/vault`）做完后钥匙串里只剩一条，最多问一次。

### macOS 27 上 Tauri 窗口的标题栏不跟深色（2026-10-18）

- **症状**：系统是深色模式，窗口顶部却是一条白色标题栏。
- **已经查清，别再去翻 tao / wry 源码**：同一台机器上普通 AppKit 窗口的标题栏是深色的，Tauri 窗口就算在代码里强制设成深色也还是浅色。Clash Verge Rev（也是 Tauri）同样中招。是 Tauri 在 macOS 27 上的毛病。
- **处理**：不用系统标题栏。`apps/desktop/src-tauri/tauri.macos.conf.json` 里 `titleBarStyle: Overlay`、`hiddenTitle`、`trafficLightPosition`，界面一直画到顶；可拖动的空白处用 `packages/ui/src/core/platform.ts` 的 `dragRegion` 标记（只对元素本身生效：铺满在上面的内层容器也要标，不然按下去点到的是内层，拖不动。2026-10-23 编辑窗口的文件标签栏就漏了这层），`capabilities/default.json` 加了 `core:window:allow-start-dragging`；侧栏收起时标签栏给红绿灯让出 78px（`apps/desktop/src/main.tsx` 只在 Mac 上传这个值）。
- 调红绿灯位置只改 `trafficLightPosition`，改完用 `scripts/mac-preview.sh` 截图、`scripts/mac-window.sh shot --crop` 放大看对齐。

### 调试版和正式版共用所有者的真实数据

应用标识都是 `dev.evershell.desktop`（发布后不能再改，钥匙串和数据目录都挂在它下面），所以 `tauri dev`、调试版 .app、`build/EverShell.app` 读写的是同一份连接列表（WebView 的本地存储）、同一个保险箱（应用数据目录下的 `vault.json`）和同一批钥匙串条目（全部清单见 [data.md](data.md#本机存了什么)）。

同类项目（GitButler、Yaak）给开发构建单独一个应用标识来避免这个问题（调研附录 A 3.3）。要做的话会改应用配置，并且开发版要重新存一遍测试用的连接，做之前问所有者。

- 自己开的调试版只看不动：不连接、不保存、不删除连接。
- 保险箱的异常情况（钥匙对不上、文件损坏）用 `apps/desktop/src-tauri/src/secrets.rs` 里的单元测试测，它们用临时目录和假钥匙串。别在真实数据上试，打不开的保险箱会被改名备份、换成新的，所有者要重新输密码。

### `tauri dev` 会自动重编重启

它监视 `apps/desktop/src-tauri` 和内核 crate，任何会话改了这些文件，开着的应用就会重编、重启，所有者已连的会话全断。前端的 vite 固定占 1420 端口。所以一个文件夹同时只开一个，给所有者试用不要用 `tauri dev`，用 `scripts/mac-reopen.sh`。

### 自动化工具操作不了原生窗口

往 Tauri 窗口后台发按键会丢键，模拟拖动也带不动窗口；“控制电脑”的授权所有者不会点。原生窗口只截图，交互放到网页版 `?mock` 里测，或者请所有者试（[quality.md](quality.md#b-原生窗口只截图不操作)）。

## 网页端和中转

### Workers 收到的二进制消息是 Blob（M0）

新兼容日期下 WebSocket 默认 `binaryType` 是 blob，`new Uint8Array(blob)` 得到空数组，数据全丢。中转里显式设 `binaryType = 'arraybuffer'`。

### wrangler dev 每次断开打印 “Network connection lost”（M0）

确认过不是我们代码里的异常，是本地开发代理打的日志，不用管。部署到真实 Cloudflare 后再看一次。

## 界面

### 颜色要一起改的几处

- `packages/ui/src/styles/base.css` 里深色变量出现两次：`.ap-dark`（应用里手动选深色）和 `@media (prefers-color-scheme: dark)` 里的 `.ap-auto`（跟随系统）。改深色要两处一起改；浅色只有 `.ap-light, .ap-auto` 一处。
- **选中标签的文字颜色写死在 `packages/ui/src/App.tsx`**：`--tab-on-fg`、`--tab-on-dim` 直接写了 `--text`、`--muted` 的颜色值，`app.css` 用它们画选中标签。只改 base.css，选中标签上的字不会变。而且它们是**按终端底色的深浅**取值，不是按界面深浅，所以“只改深色”也会改到“浅色界面 + 深色终端预设”时选中标签上的字。
- **标签栏底色 `--strip`** 要和 `packages/ui/src/core/terminal-appearance.ts` 的 `STRIP_COLORS` 同步（base.css 开头的注释写了原因）。
- 终端本身的颜色不在 base.css，在 `terminal-appearance.ts`（预设、配色；浅色终端底色 `#EEF0F3` 和选中标签同色）。
- 改之前先全局搜一遍颜色值，看有没有别的地方也写死了：`grep -rniI --exclude-dir={node_modules,dist,target} "a3a3aa" packages apps`（换成你要改的值）。
- 验证深色时两组都要看，做法见 [quality.md](quality.md#a-网页版-mock界面改动的主力) 第 4、5 步。

### xterm 搜索：当前这处靠“选中”标，选中色会盖掉高亮（2026-10-23）

- 搜索插件 `@xterm/addon-search` 把找到的地方用装饰（decoration）标黄，`registerDecoration` 在 xterm 6 里算试验接口，终端要开 `allowProposedApi: true`，否则一搜就抛错。
- 当前这一处是插件把它“选中”来标的。EverShell 用的是 xterm 默认的 DOM 渲染，画选中的格子时直接用不透明的选中色，盖掉装饰的橙色，当前这处看起来就是普通的选中蓝。所以 `core/session-manager.ts` 在搜索框开着时把 `selectionBackground` / `selectionInactiveBackground` 换成橙色，关掉再换回来（`themeFor`）。
- 高亮色只认 `#RRGGBB`，文字颜色不变，深色终端要用暗一些的黄和橙，字才看得清。

### 编辑器里光标所在行的底色会盖住选中的字（2026-10-23）

- **症状**：编辑器里拖着选中一段字，光标所在的那一行看不出哪几个字被选中了，整行一个颜色。
- **原因**：CodeMirror 的选中色画在文字底下的一层，光标所在行的底色（`.cm-activeLine`）画在它上面。底色是实心的，就把选中色盖住了。
- **处理**：`packages/ui/src/styles/editor.css` 的 `--ed-line` 用半透明颜色。以后改编辑器配色时，盖在选中层上面的底色（当前行、查找结果这类）都要半透明。

### 系统的 title 悬停提示在 Mac 桌面端靠不住（2026-10-23）

- **症状**：所有者反馈连接管理器顶上的图标按钮，鼠标停上去没有说明，按钮上明明写了 `title`。
- **原因**：一是 Mac 桌面端的网页视图（WKWebView）里，`title` 提示是系统画的，要停一两秒才出，窗口不在最前面时不出；没有逐一核实是哪种情况。二是灰掉的按钮（`disabled`）在 WebKit 里收不到鼠标事件，`title` 提示也就不出（[WebKit bug 237097](https://bugs.webkit.org/show_bug.cgi?id=237097)，Chrome 和 Firefox 会派发）。
- **现在的处理**：界面自己画提示。`packages/ui/src/components/common/Tooltip.tsx` 的 `TooltipLayer` 挂在 `App.tsx` 根上，鼠标停在带 `data-tip` 的元素上半秒就在下方显示。`app.css` 给 `[data-tip]:disabled` 设了不接收鼠标，鼠标落到外层，提示层再按坐标找回灰掉的按钮。
- 还在用 `title` 的地方（命令栏、文件区等）还没换，所有者提出来再换。

### 应用里的“外观”设置会盖过系统

界面深浅色存在本地存储的 `evershell.appearance-mode`（跟随系统 / 浅色 / 深色，存的是 JSON 字符串）。用浏览器的深浅色模拟验证时要保证它是“跟随系统”，否则模拟不起作用；验证时手动改过就改回去。怎么查、怎么改见 [quality.md](quality.md#a-网页版-mock界面改动的主力) 第 3 步。

## 测试

### 连真服务器的测试没配环境会“通过”

`crates/ssh-core/tests/real_server.rs` 和 `apps/desktop/src-tauri/tests/session.rs` 没有 `SSH_E2E_*` 环境变量时打印“跳过”然后算通过。先开 test-sshd，见 [quality.md](quality.md#c-rust-测试和本机测试服务器)。

### 网页端到端测试报“超时（10s）”（2026-10-18）

`scripts/check.sh web` 的端到端测试要先起 `services/relay-node`。它不在 npm workspaces 里，依赖没装时中转起不来（`target/check-logs/relay.log` 里是 `Cannot find package 'ws'`），10 秒后报超时。2026-10-23 起 `scripts/setup.sh` 会装它的依赖；之前建的 worktree 再跑一次 `scripts/setup.sh` 就好。

### 屏幕锁着时截不了原生窗口（2026-10-18）

`scripts/mac-window.sh shot` 报 `could not create image from window`，`screencapture` 截全屏是黑的：所有者的屏幕锁着或者在休眠。这时只能用 `scripts/mac-window.sh list` 确认进程和窗口在，样子等所有者回来再截，或者请他看。

### 本机测试服务器是 macOS

Linux 专属的东西（监控读 `/proc`）、密码登录、二次验证在 test-sshd 上测不了，要所有者用自己的服务器试。
