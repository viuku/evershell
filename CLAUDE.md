# EverShell 开发约定

给在这个仓库里干活的 AI 看。这一页每次都会读到，放的是每个会话都要知道的；细节在 `docs/dev/` 的四份说明书里，用到再翻。

## 先看这几条

- **不要申请“控制电脑”**（computer-use 的授权、全屏控制）。所有者不会点，以前两次都白等到超时。原生窗口用 `scripts/mac-window.sh` 截图，不需要权限；点击、拖动这类交互请所有者自己试。
- **不改系统设置**，包括系统的深浅色外观。要看另一种颜色，用网页版的深浅色模拟。
- **不直接在 main 上改。** 开工先开分支；几个会话同时干活时各用一个 worktree。提交、推送都等所有者发话。
- **开工先 `git status`。** 有不是你留下的未提交改动，说明有别的会话在同一个文件夹里：别回退、别格式化别人的文件，提交时只加自己的，别关别人开的窗口和服务。详见 [environment.md](docs/dev/environment.md#几个会话同时干活)。
- **同一时刻只开一个 `tauri dev`。** 它固定占 1420 端口，一看到 Rust 代码改动就重编重启，会把所有者正在用的连接弄断。自己看原生窗口用 `scripts/mac-preview.sh`。

## 环境

- `cargo` 由会话启动钩子自动加进 PATH（`.claude/settings.json`）。还是报 `command not found` 时：`. scripts/dev-env.sh && cargo …`。
- 新 worktree、新克隆先跑 `scripts/setup.sh`（装依赖、编网页端 WASM 包，没有它网页版 `?mock` 也打不开）。
- 等东西就绪用 `scripts/wait-for.sh`，别手写 sleep / grep 循环。
- 端口：网页版 5173（被别的会话占着就用 launch.json 里的 `web-alt`，5174）、tauri dev 1420、测试用 sshd 2222。
- shell 是 zsh：通配符没匹配到会报错，`--include='*.tsx'` 这类要加引号。

## 改完怎么验

按改动选一档，只走需要的那档。具体步骤见 [verify.md](docs/dev/verify.md)。

| 改了什么 | 怎么验 |
|---|---|
| `packages/ui` 的组件、样式 | `scripts/check.sh ui`，再在网页版 `?mock` 里深色、浅色各截一张 |
| `packages/ui/src/core` 的逻辑、导入导出 | `scripts/check.sh ui`（有单元测试）；影响到界面再走 `?mock` |
| 内核：`crates/ssh-core`、`crates/vault` | `scripts/test-sshd.sh start`，再 `scripts/check.sh core`（含 WASM 编译检查） |
| 桌面端 Rust：`apps/desktop/src-tauri/src` | `scripts/test-sshd.sh start`，再 `scripts/check.sh desktop` |
| 窗口外观、标题栏、`tauri*.conf.json`、`capabilities/` | `scripts/mac-preview.sh` 编调试版截图；交互请所有者试 |
| 网页端：`apps/web`、`crates/ssh-wasm`、`services/relay-*` | `scripts/test-sshd.sh start`，再 `scripts/check.sh web` |
| 只改了说明书 | `scripts/check.sh docs` |
| 所有者要用新版 | `scripts/mac-reopen.sh`：签名编译 `build/EverShell.app`、退出旧版、打开新版（会断开他正在用的连接，先说一声） |

## 说明书

| 文件 | 什么时候翻 |
|---|---|
| [docs/dev/environment.md](docs/dev/environment.md) | 工具链、全部脚本、端口、几个会话同时干活、Claude 环境里的怪癖 |
| [docs/dev/verify.md](docs/dev/verify.md) | 每档验证的具体做法：网页预览、原生截图、测试服务器、交给所有者、设计稿预览 |
| [docs/dev/code-map.md](docs/dev/code-map.md) | 分层地图；一个功能怎么从界面一路找到 Rust；改某样东西去哪找 |
| [docs/dev/pitfalls.md](docs/dev/pitfalls.md) | 第三方库和平台的坑（症状、原因、现在怎么处理），还有没解决的已知问题。碰到怪现象先搜这里 |

其他文档：需求和已定的产品决定 [docs/requirements.md](docs/requirements.md)；技术验证结论 [docs/m0-report.md](docs/m0-report.md)；russh 补丁 [vendor/README.md](vendor/README.md)；界面设计稿 [docs/design](docs/design)；给人看的介绍 [README.md](README.md)。

**说明书要跟着代码一起改，不然很快就没用了：**

- 花了好几步才找到的东西、查清楚的第三方坑，当次就补进对应的文件（坑写上日期）。
- 增删、改名脚本、目录、端口、验证办法时，在同一次改动里更新说明书，然后跑 `scripts/check.sh docs`（会找出写着但已经不存在的路径）。
- 发现说明书写错了，直接改正，不要绕过去。坑不存在了就删掉那条。
- 写“怎么查”，不写很快会过时的东西（文件清单、行号、数量、版本号）。
- 所有者的个人习惯（怎么跟他说话、他的偏好）放在 Claude 的记忆里，不写进仓库；仓库里只放干活的规矩和项目知识。

## 平台路线

现在只做 Mac 版，目标是 M1“Mac 能日常用”。网页、Windows、iOS / Android 以后做，顺序见 [docs/requirements.md](docs/requirements.md) 的第 2 节和第 8 节。

写 Mac 版时不能把其他平台堵死。下面几条是具体做法。

## 跨平台守则

1. **平台差异只走接口。** 界面和业务逻辑放 `packages/ui`，SSH、文件传输、钥匙串、保存文件都通过 `packages/ui/src/types.ts` 里的 `SshBackend` / `SecretStore` 注入。桌面端实现在 `apps/desktop/src/tauri-backend.ts`，网页端在 `apps/web/src/wasm-backend.ts`，预览用的假后端在 `packages/ui/src/mock`。`packages/ui` 里不要 import `@tauri-apps/*`。加新的平台能力时先在接口上加方法，三个实现都补上，暂时做不了的返回明确的“不支持”。
2. **协议和数据逻辑写进 Rust 内核，内核要能编成 WASM。** SSH、SFTP、监控采集、加密、同步放 `crates/ssh-core`（或新的内核 crate），Tauri 命令只做薄包装。只能在本机跑的东西（本地文件、系统钥匙串、子进程）放 `apps/desktop/src-tauri`，或用 `cfg` 隔开。改完内核跑 `scripts/check.sh core`，它包含 `cargo check -p ssh-wasm --target wasm32-unknown-unknown`。新的内核 crate 也要加进 `scripts/check.sh` 的 core 检查。
3. **Mac 专属的东西单独放。** 窗口外观、菜单、打包格式写进 `tauri.macos.conf.json` 或 `#[cfg(target_os = "macos")]`，不改各平台共用的配置。界面里不写死 ⌘，快捷键和按键文字走 `packages/ui/src/core/platform.ts`。
4. **逻辑放 `core/`，组件只管显示。** 手机版会换一套布局，`packages/ui/src/core` 里的状态和逻辑要能直接拿去用。重要操作要有能点的入口，不能只靠鼠标悬停或右键，手机上没有这两样。
5. **本地数据只经过 `core/storage.ts`。** 组件里不直接读写 localStorage，以后换存储、接同步只改一处。
6. **路径分清远程和本机。** 远程路径用 `core/paths.ts`（POSIX 规则）。本机路径交给后端处理（Rust 用 `PathBuf`，或用 Tauri 的路径 API），前端不要自己拼 `/`，Windows 的分隔符是 `\`。

## 界面文字

- 中文界面里的引号用直角引号「」。
- 以后做繁体中文时用台湾用语：設定、軟體、視窗、檔案、螢幕。
