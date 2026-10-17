# EverShell

FinalShell 风格的 SSH 客户端：终端、文件管理和服务器监控放在同一个窗口里，同步数据存在你自己的服务器或 Cloudflare 账号上。

FinalShell 的 Final 是“最后”，Ever 是“永远”：一个不会停更、不会跑路的 shell。

> **状态：早期开发中，还不能日常使用。** 技术验证（M0）已完成，结论见 [docs/m0-report.md](docs/m0-report.md)。

## 为什么做

FinalShell 很久没更新，云同步依赖它的官方服务，一旦停服，同步的数据就没了。EverShell 保留 FinalShell 用惯的布局和操作逻辑，同步服务由你自己部署，数据随时能导出、迁移。

## 计划功能

- **SSH 终端**：多标签、分屏、配色主题，支持密码、私钥和二次验证
- **SFTP 文件管理**：在终端下方，拖拽上传下载、传输队列、在线编辑，目录可以跟随终端
- **服务器监控**：CPU、内存、网速、磁盘、进程，服务器上不用装任何 agent
- **快捷命令和历史命令**
- **导入现有连接**：FinalShell、`~/.ssh/config`，以后支持 Xshell、Termius 等
- **自建同步**：一个 Docker 镜像，或部署到自己的 Cloudflare 账号；端到端加密，服务器只存密文
- **平台**：macOS → 网页 → Windows，之后是 iOS 和 Android

完整需求见 [docs/requirements.md](docs/requirements.md)，界面设计稿见 [docs/design](docs/design)。

## 技术栈

- 桌面端：Tauri 2 + React + TypeScript，终端用 xterm.js
- SSH 内核：Rust（russh），桌面端原生运行，网页端编译成 WASM
- 网页端中转：Node（自建）或 Cloudflare Workers，只转发字节，密码和私钥不经过中转

| 目录 | 内容 |
|---|---|
| `crates/ssh-core` | SSH 内核 |
| `crates/ssh-wasm` | 把内核包装给浏览器用 |
| `packages/ui` | 桌面端和网页端共用的界面 |
| `apps/desktop` | Tauri 桌面应用 |
| `apps/web` | 网页应用 |
| `services/relay-node` | 自建中转 |
| `services/relay-worker` | Cloudflare Workers 中转 |
| `vendor/russh` | 打了补丁的 russh，见 [vendor/README.md](vendor/README.md) |

## 本地开发

需要 Rust（stable）和 Node.js 22 以上。

```bash
npm install
npm run tauri -w @evershell/desktop -- dev   # 桌面版
```

网页版需要先构建 WASM 内核并启动中转，步骤见 [docs/m0-report.md](docs/m0-report.md) 的“怎么在本机复现”一节。

## 协议

EverShell 以 [GNU 通用公共许可证第 3 版或更高版本](LICENSE)（GPL-3.0-or-later）发布：任何人都可以使用、修改和分发，但分发修改后的版本时，也必须以同样的协议公开源代码。`vendor/russh` 除外，见下一节。

## 说明

- 本项目与 FinalShell 及其开发者没有任何关系。文中提到 FinalShell 只是为了说明布局参考和连接导入。
- `vendor/russh` 是 [russh](https://github.com/Eugeny/russh) 0.64.1 的修改版，按 Apache-2.0 协议分发，协议全文在 [vendor/russh/LICENSE](vendor/russh/LICENSE)。
