# 踩过的坑

第三方库、平台和本机环境里已经查清楚的问题。碰到奇怪现象先在这里搜症状（报错原文、关键词），别再去翻依赖源码。

每条的格式：**症状** → **原因** → **现在的处理**（在哪）→ 什么时候能去掉。新查清一个坑就加一条，写上日期；坑不存在了（上游修了、代码删了）就删掉那条。环境和 shell 的小毛病在 [environment.md](environment.md#claude-环境里的怪癖)，这里只放跟代码有关的。

## 还没解决的

### SFTP 报 packet length limit exceeded（2026-10-18）

- **症状**：连上所有者的服务器那一秒，桌面端日志出现 `WARN russh_sftp::client Bad message: packet length limit exceeded`，文件面板可能用不了。本机 test-sshd 上不出现。
- **推测的原因（没确认）**：服务器的登录脚本（`~/.bashrc` 之类）在非交互会话里往标准输出打印了文字，混进 SFTP 数据流，russh-sftp 把开头几个字节当成包长，长度超限。russh 的 `into_stream` 只读标准输出不读标准错误，所以是标准输出上的文字。
- **复现**：`scripts/test-sshd.sh start --noisy`（SFTP 启动前先打印一行字），然后 `eval "$(scripts/test-sshd.sh env --noisy)" && cargo test -p ssh-core --test real_server sftp_roundtrip`。
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

### 内核里起后台任务用 `crate::spawn`，不要直接 `tokio::spawn`

`crates/ssh-core/src/lib.rs` 的 `spawn` 在原生平台转给 `tokio::spawn`（必须在 tokio 运行时里调用），在 wasm32 上转给 `spawn_local`。直接写 `tokio::spawn` 或 `std::thread` 会让 WASM 编不过或跑不起来。

### 浏览器的 WebSocket 不能跨线程（M0）

russh 要求字节流能跨线程（`Send`），浏览器的 WebSocket 不行。`crates/ssh-wasm` 中间放了一个内存管道，两头各一个任务搬数据。别想着把 WebSocket 直接塞给 russh。

## 桌面端（Tauri）

### 同步的 Tauri 命令没有 tokio 运行时，一 spawn 就整个应用闪退（2026-10-18）

- **症状**：连上服务器后应用直接消失。日志：`there is no reactor running, must be called from the context of a Tokio 1.x runtime`，接着 `fatal runtime error: failed to initiate panic`。
- **原因**：不带 `async` 的 `#[tauri::command]` 跑在主线程上，那里没有 tokio 运行时。当时 `ssh_monitor_start` 是同步命令，一路调到内核的 `spawn` 就崩了。
- **规矩**：命令只要会直接或间接用到 tokio（spawn、网络、计时），就写成 `async fn`。现在只有不碰 tokio 的几个（写入、调整窗口、关闭、停监控）是同步的，改它们时留意。

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
- **处理**：不用系统标题栏。`apps/desktop/src-tauri/tauri.macos.conf.json` 里 `titleBarStyle: Overlay`、`hiddenTitle`、`trafficLightPosition`，界面一直画到顶；可拖动的空白处用 `packages/ui/src/core/platform.ts` 的 `dragRegion` 标记，`capabilities/default.json` 加了 `core:window:allow-start-dragging`；侧栏收起时标签栏给红绿灯让出 78px（`apps/desktop/src/main.tsx` 只在 Mac 上传这个值）。
- 调红绿灯位置只改 `trafficLightPosition`，改完用 `scripts/mac-preview.sh` 截图、`mac-window.sh shot --crop` 放大看对齐。

### 调试版和正式版共用所有者的真实数据

应用标识都是 `dev.evershell.desktop`（发布后不能再改，钥匙串和数据目录都挂在它下面），所以 `tauri dev`、调试版 .app、`build/EverShell.app` 读写的是同一份连接列表（WebView 的 localStorage）、同一个保险箱（应用数据目录下的 `vault.json`）和同一批钥匙串条目。

- 自己开的调试版只看不动：不连接、不保存、不删除连接。
- 保险箱的异常情况（钥匙对不上、文件损坏）用 `apps/desktop/src-tauri/src/secrets.rs` 里的单元测试测，它们用临时目录和假钥匙串。别在真实数据上试，打不开的保险箱会被改名备份、换成新的，所有者要重新输密码。

### `tauri dev` 会自动重编重启

它监视 `apps/desktop/src-tauri` 和内核 crate，任何会话改了这些文件，开着的应用就会重编、重启，所有者已连的会话全断。前端的 vite 固定占 1420 端口。所以一个文件夹同时只开一个，给所有者试用不要用 `tauri dev`，用 `scripts/mac-reopen.sh`。

### 自动化工具操作不了原生窗口

往 Tauri 窗口后台发按键会丢键，模拟拖动也带不动窗口；全屏控制要所有者批准，他不会点（两次都等到超时）。原生窗口只截图，交互放到网页版 `?mock` 里测，或者请所有者试。

## 网页端和中转

### Workers 收到的二进制消息是 Blob（M0）

新兼容日期下 WebSocket 默认 `binaryType` 是 blob，`new Uint8Array(blob)` 得到空数组，数据全丢。中转里显式设 `binaryType = 'arraybuffer'`。

### wrangler dev 每次断开打印 “Network connection lost”（M0）

确认过不是我们代码里的异常，是本地开发代理打的日志，不用管。部署到真实 Cloudflare 后再看一次。

## 界面

### 颜色变量写了两遍

`packages/ui/src/styles/base.css` 里深色变量出现两次：`.ap-dark`（应用里手动选深色）和 `@media (prefers-color-scheme: dark)` 里的 `.ap-auto`（跟随系统）。改深色要两处一起改，浅色只有 `.ap-light, .ap-auto` 一处。终端的颜色不在这里，在 `packages/ui/src/core/terminal-appearance.ts`（预设、配色，浅色终端底色 `#EEF0F3` 和选中标签同色）。

### 应用里的“外观”设置会盖过系统

界面深浅色存在 localStorage 的 `evershell.appearance-mode`（跟随系统 / 浅色 / 深色）。用浏览器的深浅色模拟验证时，要保证它是“跟随系统”，否则模拟不起作用；验证时手动改过就改回去。

## 测试

### 连真服务器的测试没配环境会“通过”

`crates/ssh-core/tests/real_server.rs` 和 `apps/desktop/src-tauri/tests/session.rs` 没有 `SSH_E2E_*` 环境变量时打印“跳过”然后算通过。先 `scripts/test-sshd.sh start`，`scripts/check.sh` 会自动带上并提示用没用上。

### 本机测试服务器是 macOS

Linux 专属的东西（监控读 `/proc`）、密码登录、二次验证在 test-sshd 上测不了，要所有者用自己的服务器试。
