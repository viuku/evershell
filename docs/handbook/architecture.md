# 架构与分层

> **管什么**：代码分几层、各层的边界（跨平台守则）、运行时的约定、加依赖的门槛、怎么在代码里找东西。
> **什么时候更新**：加了新的层或目录、定了新的运行时约定、加了新的守则；守则能机械判断的，同时加进 `scripts/check-guards.sh`。
> **上次复核**：2026-10-18

代码结构还在快速变，这里只写不太会变的分层和“怎么查”，不列文件清单。

## 分层

```
packages/ui  ── 界面和业务逻辑（React + TS），桌面端、网页端共用，以后手机版也用
   │  只通过 packages/ui/src/types.ts 的 SshBackend / SecretStore 接口要平台能力
   ├─ apps/desktop/src/tauri-backend.ts ──invoke──▶ apps/desktop/src-tauri（Tauri 命令，薄包装）──▶ crates/ssh-core
   ├─ apps/web/src/wasm-backend.ts ──▶ crates/ssh-wasm（WASM 包装）──▶ crates/ssh-core ──WebSocket──▶ services/relay-*
   └─ packages/ui/src/mock ── 假后端，网页版 ?mock 预览用
```

| 目录 | 内容 | 语言 |
|---|---|---|
| `packages/ui/src/components` | 组件，按界面区域分子目录（`ls` 看） | TSX |
| `packages/ui/src/core` | 状态和逻辑，手机版要直接复用，不放界面代码 | TS |
| `packages/ui/src/styles` | 样式，一个区域一个文件；颜色变量在 `base.css` | CSS |
| `packages/ui/src/mock` | 假后端：假终端、假文件系统、假监控 | TS |
| `apps/desktop/src` | 桌面端入口和 Tauri 后端实现 | TS |
| `apps/desktop/src-tauri` | Tauri 外壳：命令、会话管理、保险箱存取、窗口配置 | Rust |
| `apps/web/src` | 网页端入口、WASM 后端、中转设置 | TS |
| `crates/ssh-core` | SSH 内核：连接、认证、终端、监控采集、SFTP | Rust |
| `crates/vault` | 保险箱的加密 | Rust |
| `crates/ssh-wasm` | 把内核包装成浏览器能调的类 | Rust |
| `services/relay-node`、`services/relay-worker` | 网页端的中转，只搬字节 | JS / TS |
| `vendor/russh` | 打了补丁的 russh（见 [pitfalls.md](pitfalls.md#russh-的定时器在浏览器里-panicm0vendor-补丁)） | Rust |

## 跨平台守则

现在只做 Mac 版，但写 Mac 版时不能把网页、Windows、手机堵死。第 1、3、5 条和两条内核规矩已经写成自动检查（`scripts/check-guards.sh`，`scripts/check.sh ui` / `core` 会跑），违反会直接报错。

1. **平台差异只走接口。** 界面和业务逻辑放 `packages/ui`，SSH、文件传输、钥匙串、保存文件都通过 `packages/ui/src/types.ts` 里的 `SshBackend` / `SecretStore` 注入。桌面端实现在 `apps/desktop/src/tauri-backend.ts`，网页端在 `apps/web/src/wasm-backend.ts`，预览用的假后端在 `packages/ui/src/mock`。`packages/ui` 里不要 import `@tauri-apps/*`。加新的平台能力时先在接口上加方法，三个实现都补上，暂时做不了的返回明确的“不支持”。
2. **协议和数据逻辑写进 Rust 内核，内核要能编成 WASM。** SSH、SFTP、监控采集、加密、同步放 `crates/ssh-core`（或新的内核 crate），Tauri 命令只做薄包装。只能在本机跑的东西（本地文件、系统钥匙串、子进程）放 `apps/desktop/src-tauri`，或用 `cfg` 隔开。改完内核跑 `scripts/check.sh core`，它包含 WASM 编译检查。新的内核 crate 要加进 `scripts/check.sh` 的 core 一档。
3. **Mac 专属的东西单独放。** 窗口外观、菜单、打包格式写进 `apps/desktop/src-tauri/tauri.macos.conf.json` 或 `#[cfg(target_os = "macos")]`，不改各平台共用的配置。界面里不写死 ⌘，快捷键和按键文字走 `packages/ui/src/core/platform.ts`。
4. **逻辑放 `core/`，组件只管显示。** 手机版会换一套布局，`packages/ui/src/core` 里的状态和逻辑要能直接拿去用。重要操作要有能点的入口，不能只靠鼠标悬停或右键，手机上没有这两样。
5. **本地数据只经过 `core/storage.ts`。** 组件里不直接读写 localStorage，以后换存储、接同步只改一处。（`apps/web/src/relay-bar.tsx` 的中转设置是网页端自己的东西，直接用了 localStorage，不在检查范围内。）
6. **路径分清远程和本机。** 远程路径用 `packages/ui/src/core/paths.ts`（POSIX 规则）。本机路径交给后端处理（Rust 用 `PathBuf`，或用 Tauri 的路径 API），前端不要自己拼 `/`，Windows 的分隔符是 `\`。

## 运行时约定

踩过坑才定下来的，改相关代码前先看：

- **会用到 tokio 的 Tauri 命令必须是 `async fn`**，同步命令跑在主线程上，没有 tokio 运行时，一 spawn 整个应用闪退（[pitfalls.md](pitfalls.md#同步的-tauri-命令没有-tokio-运行时一-spawn-就整个应用闪退2026-10-18)）。
- **内核里起后台任务、计时用 `crate::spawn`、`crate::now`、`crate::sleep`**，它们按平台转给 tokio 或浏览器；直接用 tokio、`std::time::Instant` 到浏览器里会出错（已自动检查，原因见 [pitfalls.md](pitfalls.md#内核里起后台任务计时都要走内核自己的函数)）。
- **IPC 怎么传数据**：二进制（按键、上传、保存文件）作为请求体直接传，会话号、文件名放请求头；远端输出、监控、传输进度用 `Channel` 推回前端；JS 驼峰参数名对应 Rust 下划线（[pitfalls.md](pitfalls.md#invoke-的参数名和数据怎么传)）。
- **按键顺序靠两层队列**：前端把 invoke 串成一条链，Rust 每个会话一个写入队列。不要为了简化拿掉。
- **机密的流向**：现在三个平台都是前端通过 `SecretStore` 取出密码，放进连接参数交给后端。以后要收紧（前端只传连接编号，后端自己取），是 [security.md](security.md) 里的待办，改之前要三个后端一起改。
- 断线检测、自动重连、终端回压、SFTP 安全上传 2026-10-18 起在一个独立任务里做，做完在这里补约定。要改这几块之前，先用 `git worktree list` 和 App 的关联会话提示看还有没有会话在做，有就先发消息商量（[ai-collaboration.md](ai-collaboration.md#会话之间交接)）。

## 加依赖的门槛

加任何新依赖（crate 或 npm 包）前过一遍，新的“种类”（新框架、新语言、新的外部服务）先问所有者：

1. **内核 crate 的依赖要能编成 WASM**，不能把 aws-lc-rs 拉进来（已自动检查）。`cargo tree -p ssh-wasm --target wasm32-unknown-unknown -i <包名>` 看它是怎么进来的。
2. **协议要和 GPL-3.0-or-later 兼容**，允许和禁止的清单见 [licensing.md](licensing.md#依赖的协议)。
3. **维护得怎么样**：最近一年有没有发版、有没有没修的安全公告。
4. **体积**：网页版的 WASM 包和 JS 包会变大，大依赖先问一句值不值。
5. 能用已有依赖或标准库做的，不加新依赖。

## 在代码里找东西

### 一个功能从界面到 Rust

以“开始监控”为例，换成别的功能照做：

1. **接口**：`packages/ui/src/types.ts` 里找方法（`watchMonitor`）。
2. **三个实现**：`grep -n "watchMonitor" apps/desktop/src/tauri-backend.ts apps/web/src/wasm-backend.ts packages/ui/src/mock/mock-backend.ts`
3. **桌面端命令名**：tauri-backend.ts 里调的是 `call('ssh_monitor_start', …)` 或 `invoke('…')`。
4. **Rust 命令**：`grep -rn "fn ssh_monitor_start" apps/desktop/src-tauri/src`，在 `commands.rs`；新命令还要登记到 `lib.rs` 的 `generate_handler!`。
5. **会话层和内核**：命令调 `session.rs` 的 `SessionManager`，再进 `crates/ssh-core`（监控在 `monitor.rs`，SFTP 在 `sftp.rs`，其余在 `lib.rs`）。
6. **网页端那条线**：wasm-backend.ts 调 `crates/ssh-wasm/src/lib.rs` 导出的方法，再进同一个 ssh-core。

反过来从 Rust 找界面：命令名在前端是同一个字符串，`grep -rn --exclude-dir={node_modules,dist,target} "ssh_monitor_start" apps packages`。搜索时一定排除这三个目录，不然会扫进打包产物，输出几十 KB。

### 改某样东西去哪找

| 想改 | 先看 | 怎么搜 |
|---|---|---|
| 某块界面 | 界面上的中文文字是最好的线索 | `grep -rn "快速连接" packages/ui/src/components` |
| 颜色 | `packages/ui/src/styles/base.css` 的变量，含义见下表；**改一个颜色常常要改好几处**（[pitfalls.md](pitfalls.md#颜色要一起改的几处)） | `grep -rn "var(--muted)" packages/ui/src/styles` 看谁在用 |
| 终端配色、背景预设 | `packages/ui/src/core/terminal-appearance.ts` | |
| 某个区域的样式 | `packages/ui/src/styles/` 下同名文件（sidebar、terminal、panels、newtab、manager） | 组件里的 `className` 搜到 CSS |
| 快捷键、按键文字、拖动区域 | `packages/ui/src/core/platform.ts` | |
| 本地保存的设置和数据 | `packages/ui/src/core/storage.ts` 的 `PersistentStore`；全部清单见 [data.md](data.md) | `grep -rn "new PersistentStore" packages/ui/src` |
| 连接列表、最近连接、快捷命令、历史 | `packages/ui/src/core/*-store.ts` | `ls packages/ui/src/core` |
| 会话、标签、监控数据怎么流动 | `packages/ui/src/core/session-manager.ts` | |
| 连接参数（超时、心跳、算法） | 内核 `crates/ssh-core/src/lib.rs` 的 `Connection::connect`（russh 的 `client::Config`）和桌面端的 TCP 连接；网页端在 `crates/ssh-wasm` 里开 WebSocket。2026-10-18 时连接超时、心跳都没设，界面“高级”里的心跳间隔只保存、不生效 | `grep -rnE "Config|timeout|keepalive" crates/ssh-core/src` |
| 导入导出 | `packages/ui/src/core/importers/<来源>.ts`，样例在 `__fixtures__`，测试在 `__tests__` | 新来源照现有的抄一份，补样例和测试 |
| 窗口大小、标题栏、红绿灯 | `apps/desktop/src-tauri/tauri.macos.conf.json`（Mac 专属）、`tauri.conf.json`（共用） | |
| 窗口权限（拖动等） | `apps/desktop/src-tauri/capabilities/default.json` | |
| 密码和私钥存哪 | `apps/desktop/src-tauri/src/secrets.rs` + `crates/vault`，规则见需求文档 3.5 | |
| 打包、签名 | `scripts/build-mac.sh`、`tauri.macos.conf.json` 的 `signingIdentity` | |

### 颜色变量

在 `packages/ui/src/styles/base.css`，浅色一组、深色两组（见上面的坑）。界面还在改，变量会增减，**以 base.css 为准**，用 `grep -n "^ *--" packages/ui/src/styles/base.css` 看全部。主要的几个：

| 变量 | 用途 |
|---|---|
| `--text` / `--muted` | 主文字 / 次要文字（说明、占位符、表头） |
| `--strip` | 标签栏底色（改它要同步 `terminal-appearance.ts` 的 `STRIP_COLORS`） |
| `--bar`、`--side`、`--content`、`--sheet` | 背景层级：表头和工具栏、侧栏、主内容区、弹出的面板 |
| `--line` / `--line2` | 分隔线：明显的 / 浅的 |
| `--accent` | 强调色（选中、主按钮） |
| `--ok`、`--warn`、`--danger` | 状态色：正常、警告、危险 |

改了设计稿里有的颜色值，在 [docs/design/README.md](../design/README.md) 的“正式界面和设计稿的差异”里记一条。

## 约定

- 弹窗、确认框用 `packages/ui/src/components/common/Dialogs.tsx`，菜单用 `Menu.tsx`，分段控件用 `Segmented.tsx`，图标在 `Icons.tsx`。新做之前先看这里有没有。
- 注释和界面文字用中文；注释只写“为什么”，不复述代码在做什么。
- 生成的文件不手改：`crates/ssh-wasm/pkg/` 下除了 `package.json` 都是 `scripts/build-wasm.sh` 生成的。
