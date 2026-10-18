# 东西在哪

代码结构还在快速变，这里只写不太会变的分层和“怎么查”。具体文件用下面的命令现查，别指望这里有完整清单。

## 分层

```
packages/ui  ── 界面和业务逻辑（React + TS），桌面端和网页端共用
   │  只通过 packages/ui/src/types.ts 里的 SshBackend / SecretStore 接口要平台能力
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
| `crates/vault` | 保险箱的加密（能编成 WASM） | Rust |
| `crates/ssh-wasm` | 把内核包装成浏览器能调的类 | Rust |
| `services/relay-node`、`services/relay-worker` | 网页端中转，只搬字节 | JS / TS |
| `vendor/russh` | 打了补丁的 russh | Rust |

## 顺藤摸瓜：一个功能从界面到 Rust

以“开始监控”为例，换成别的功能照做：

1. **接口**：`packages/ui/src/types.ts` 里找方法（`watchMonitor`）。
2. **三个实现**：`grep -n "watchMonitor" apps/desktop/src/tauri-backend.ts apps/web/src/wasm-backend.ts packages/ui/src/mock/mock-backend.ts`。
3. **桌面端命令名**：tauri-backend.ts 里调的是 `call('ssh_monitor_start', …)` 或 `invoke('…')`。
4. **Rust 命令**：`grep -rn "fn ssh_monitor_start" apps/desktop/src-tauri/src`，在 `commands.rs`；新命令还要登记到 `lib.rs` 的 `generate_handler!`。
5. **会话层和内核**：命令调 `session.rs` 的 `SessionManager`，再进 `crates/ssh-core`（监控在 `monitor.rs`，SFTP 在 `sftp.rs`，其余在 `lib.rs`）。
6. **网页端那条线**：wasm-backend.ts 调 `crates/ssh-wasm/src/lib.rs` 导出的方法，再进同一个 ssh-core。

反过来从 Rust 找界面：命令名（下划线）在前端是同一个字符串，`grep -rn "ssh_monitor_start" apps packages`。

**加一个平台能力**时四处都要动：`types.ts` 加方法 → 三个实现（桌面、网页、mock）→ 桌面端的 Tauri 命令。暂时做不了的平台返回明确的“不支持”（见 [CLAUDE.md](../../CLAUDE.md) 守则 1）。

## 改某样东西去哪找

| 想改 | 先看 | 怎么搜 |
|---|---|---|
| 某块界面的样子 | 界面上的中文文字是最好的线索 | `grep -rn "快速连接" packages/ui/src/components` |
| 颜色 | `packages/ui/src/styles/base.css` 的变量（深色写了两遍，见 [pitfalls.md](pitfalls.md#颜色变量写了两遍)） | `grep -rn "var(--muted)" packages/ui/src/styles` 看谁在用 |
| 终端配色、背景预设 | `packages/ui/src/core/terminal-appearance.ts` | |
| 某个区域的样式 | `packages/ui/src/styles/` 下同名文件（sidebar、terminal、panels、newtab、manager） | 组件里的 `className` 搜到 CSS |
| 快捷键、按键文字、拖动区域 | `packages/ui/src/core/platform.ts` | 不要在组件里写死 ⌘ |
| 本地保存的设置和数据 | `packages/ui/src/core/storage.ts` 的 `PersistentStore`，键名都以 `evershell.` 开头 | `grep -rn "new PersistentStore" packages/ui/src` |
| 连接列表、最近连接、快捷命令、历史 | `packages/ui/src/core/*-store.ts` | `ls packages/ui/src/core` |
| 会话、标签、监控数据怎么流动 | `packages/ui/src/core/session-manager.ts` | |
| 导入导出（FinalShell、Xshell、PuTTY…） | `packages/ui/src/core/importers/<来源>.ts`，样例在 `__fixtures__`，测试在 `__tests__` | 新来源照现有的抄一份，补样例和测试 |
| 远程路径拼接 | `packages/ui/src/core/paths.ts` | 不要自己拼 `/` |
| 窗口大小、标题栏、红绿灯 | `apps/desktop/src-tauri/tauri.macos.conf.json`（Mac 专属）、`tauri.conf.json`（各平台共用） | |
| 窗口权限（拖动等） | `apps/desktop/src-tauri/capabilities/default.json` | |
| 密码和私钥存哪 | `apps/desktop/src-tauri/src/secrets.rs` + `crates/vault`，规则见 [requirements.md](../requirements.md) 3.5 | |
| 打包、签名 | `scripts/build-mac.sh`、`tauri.macos.conf.json` 的 `signingIdentity` | |

## 约定

- 组件只管显示，逻辑放 `core/`；组件里不直接读写 localStorage（[CLAUDE.md](../../CLAUDE.md) 守则 4、5）。
- 弹窗、确认框用 `components/common/Dialogs.tsx`，菜单用 `Menu.tsx`，分段控件用 `Segmented.tsx`，图标在 `Icons.tsx`。新做之前先看这里有没有。
- 界面风格以 [docs/design](../design) 的定稿设计稿为准，正式界面和设计稿的有意差异写在它的 README 里。
- 注释和界面文字用中文。
