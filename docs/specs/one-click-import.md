# 一键导入（自动找别的软件的配置）

> 2026-10-23。所有者选了设计稿方案 A，已做；Windows 的位置还没实测。

> 快捷命令的一键导入另有一张位置表，见 [command-import.md](command-import.md)。

## 问题

导入连接要用户自己在访达里找到别的 SSH 软件存配置的位置。FinalShell 的在隐藏的 `~/Library/FinalShell/conn`，要按 ⇧⌘G 输路径，一般人找不到。

## 方案

打开导入窗口时，桌面端去各软件默认存配置的位置读文件，前端照常用 `core/importers` 的解析器解析，来源页在找到连接的软件后面标「找到 N 个连接」，并默认选中第一个。选中找到的来源时，底部主按钮变成「一键导入」：跳过“选文件”，直接到预览；「手动选择…」走原来的选文件流程。预览上方多一行「读取自 <位置>」，「上一步」回到来源页。

设计稿：https://claude.ai/artifact/HKWatSVKEr8E5KKwaHWkSh （A 一打开就标出来；没选的 B 是在选文件那一步加按钮）。

### 接口

- `SshBackend.findLocalConfigs?()`（`packages/ui/src/types.ts`），可选：网页端读不了本机文件，不提供，界面就不显示「找到」和「一键导入」。
- 桌面端命令 `import_find_local`（`apps/desktop/src-tauri/src/local_import.rs`）。**前端只能调用、不能传路径**：读哪些位置由 Rust 里的表决定，网页里的代码借这个命令也只能读到这几个配置位置。
- 返回每个本平台查过的来源：给用户看的位置（家目录写成 `~`）、读到的文件、读不了时的原因。文件的相对路径带所在文件夹名，和浏览器选文件夹时的 `webkitRelativePath` 一样，解析器不用改。
- 前端 `core/importers/local.ts` 把它变成每个来源的状态：找到（附解析结果）、有配置但没有可导入的连接、没找到、读不了。

### 位置表

| 来源 | macOS | Windows（还没在 Windows 上跑过） |
|---|---|---|
| FinalShell | `~/Library/FinalShell/conn` | `%LOCALAPPDATA%\finalshell\conn` |
| SecureCRT | `~/Library/Application Support/VanDyke/SecureCRT/Config/Sessions` | `%APPDATA%\VanDyke\Config\Sessions` |
| PuTTY | `~/.putty/sessions`，没有再看 `~/.config/putty/sessions` | 存在注册表里，不查 |
| MobaXterm | 没有 Mac 版 | `%APPDATA%\MobaXterm\MobaXterm.ini` |
| OpenSSH | `~/.ssh/config` | `%USERPROFILE%\.ssh\config` |

Linux 只查 PuTTY 和 OpenSSH。Xshell 的会话目录带版本号（`文档\NetSarang Computer\<版本>\Xshell\Sessions`），做 Windows 版时再加；EverShell 导出文件的位置不固定，不查。依据和各来源的手动导入说明一样，见 `core/importers/sources.ts`。

### 读文件的限制

和手动选文件一致，防止位置不对时读进一大堆东西：

- 跳过隐藏文件和符号链接（只有表里的位置本身可以是链接），按来源过滤扩展名（FinalShell 只读 `.json`，SecureCRT 只读 `.ini`）。
- 单个文件超过 2 MB 跳过；文件夹最多往下 8 层；一个来源超过 2000 个文件或 16 MB 就报“读不了”，一个都不给。
- 读到的文件只在内存里交给前端解析，不落盘、不进日志。

### 放弃的方案

- 前端传路径、后端照读：界面里显示的很多内容来自服务器，万一哪里被注入了脚本，它就能借这个命令读本机任意文件。[security.md](../handbook/security.md#红线) 第 6 条也不许加“读任意文件”这类通用命令。
- 点「一键导入」时才读：来源页就标不出“找到 N 个连接”。配置文件很小（所有者的 FinalShell 是 30 个文件、120 KB），打开时读一遍感觉不到。
- 点了直接导入、不经过预览：所有者没要求，预览还能去掉不要的、处理重名。

## 对其他平台的影响

- 网页端：不提供 `findLocalConfigs`，导入流程和以前一样。
- Windows：位置表已按平台分开，FinalShell、SecureCRT、MobaXterm、OpenSSH 的位置已写好，到 M6 在 Windows 上实测。
- 手机：没有别的 SSH 软件的配置可读，不提供。

## 测试

- Rust 单元测试（`local_import.rs`）：位置表、相对路径带文件夹名、子文件夹递归、隐藏文件 / 符号链接 / 扩展名 / 大文件跳过、超出上限报错、位置不存在。
- 前端单元测试（`core/importers/__tests__/local.test.ts`）：四种状态、不认识的来源忽略、默认选中第一个找到的。
- 网页版 `?mock`：假后端提供 FinalShell 和 `~/.ssh/config` 的样例、SecureCRT 没找到，深浅色各看一遍。
- 真机：所有者在正式版里打开导入，看 FinalShell 是否标出、一键导入后预览是否和手动选 conn 文件夹一样。
