# 兼容性

> **管什么**：要兼容哪些 SSH 服务器和算法、监控在哪些系统上能用、终端显示要过哪些手测。
> **什么时候更新**：加了算法或监控的支持、实测了新环境、用户报了兼容问题。
> **上次复核**：2026-10-18

现在只有已知事实和清单。**实测矩阵在 M1 收尾时跑**（要用 Docker 起各版本的服务器，本机 Docker 现在没开），跑完把下面的“现状”一列填上。依据见调研 [附录 C 第 2 节](../research/2026-10-appendix-c-ssh-client-concerns.md)。

## SSH 算法

**现状**：russh 0.64 的默认算法，已经包含后量子密钥交换和防 Terrapin 的 strict kex。根 `Cargo.toml` 里 russh 只开了 `ring`、`rsa`、`flate2` 特性，没开 `des`（3des-cbc）和 `dsa`。

**OpenSSH 一路在收紧**（逐版本表见附录 C 2.1）：8.8 默认禁用 `ssh-rsa`（SHA-1 签名）；9.0 默认后量子混合密钥交换；10.0 删除 DSA、服务端默认关掉有限域 DH。新服务器一般没问题，难连的是老服务器和网络设备，它们只有旧算法。

**策略（待定，做到“旧设备连不上”的问题时定）**：默认用 russh 的默认算法；旧算法按主机单独打开，打开了在状态栏标黄提示；要不要开 russh 的 `des`、`dsa` 特性要明确决定，它们会让 WASM 包变大、攻击面变大。OpenSSH 自己的做法是按主机“追加”旧算法，对方支持更强的时仍然选强的（附录 C 2.2）。

## 认证方式

| 方式 | 支持 | 说明 |
|---|---|---|
| 密码 | 是 | |
| 私钥（Ed25519、RSA，可带口令） | 是 | |
| 不需要密码（SSH 的 none 认证） | 是（2026-10-18） | 没存密码时先试它；空密码只靠它，不发空密码，免得服务器的防暴力破解记一次失败（[architecture.md](architecture.md#运行时约定)） |
| 键盘交互（keyboard-interactive，二次验证常用） | **还不支持** | 需求文档 3.1 要求做，开服务器二次验证的用户现在连不上 |

## 主机密钥记录

格式和 OpenSSH 的 known_hosts 一样，能直接导入：支持哈希过的主机名、通配符、`!` 排除、`[主机]:端口`、`@revoked`（吊销）。**不支持 `@cert-authority`**（证书机构），这种行会跳过（[security.md](security.md#已知缺口2026-10-18)）。

## 服务器矩阵

| 服务器 | 代表系统 | 现状 |
|---|---|---|
| OpenSSH 最新版 | macOS 自带（test-sshd） | 通过（`scripts/check.sh` 每次都测） |
| OpenSSH 10.0 | 无 DSA、服务端无有限域 DH | 未测 |
| OpenSSH 9.x | Ubuntu 22.04 / 24.04 | 未测 |
| 所有者的服务器 | 系统和版本未记录 | 2026-10-18 连上过；SFTP 报过错（见下面“监控采集”的登录脚本一行） |
| OpenSSH 8.x | Ubuntu 20.04、CentOS 8 | 未测 |
| OpenSSH 7.4 | CentOS 7 | 未测 |
| Dropbear | 路由器、嵌入式 | 未测 |
| 只有旧算法的设备 | 老交换机（group14-sha1、aes-cbc、ssh-rsa） | 未测，可以用 OpenSSH 配置旧算法模拟 |

## 监控采集

监控靠一条 shell 命令读 `/proc`（`crates/ssh-core/src/monitor.rs`），不同环境差别很大。进程列表不用 `ps`（它的 CPU 是进程启动以来的平均值，几乎不动），改成读每个进程的 `/proc/<pid>/stat`，用 awk 截出要的几项，CPU 用前后两次采样的差值算（2026-10-23）：

| 环境 | 要注意的 | 现状 |
|---|---|---|
| 所有者的服务器 | 发行版未记录，下次连上后看 `/etc/os-release` | 连上过，监控显示是否正常没有确认 |
| Debian / Ubuntu | 最常见的环境 | 未单独测 |
| CentOS 7 | 老内核没有 MemAvailable | 代码里已兼容，未实测 |
| Alpine / BusyBox | 进程列表靠 awk；BusyBox 的 awk 应该支持用到的写法；`getconf` 可能没有，取不到页大小时按 4K 算 | 未实测 |
| 各种 awk | 用到 `getline` 读进变量、`match`、`split`、`substr`，不碰 `$0` 和字符串常量 | 2026-10-23 在 macOS 自带 awk 上，经 sh / bash / zsh / tcsh / csh 跑过；gawk、mawk、BusyBox 未实测 |
| Docker 容器里 | `/proc` 显示的是宿主机的内存，用户会误以为内存很多；应读 cgroup 的限制 | 未处理 |
| 非英文语言环境 | 命令输出会变 | 命令里已经强制 `LC_ALL=C` |
| 登录脚本会打印文字 | 污染命令输出和 SFTP 数据 | SFTP 有已知问题（[pitfalls.md](pitfalls.md#sftp-报-packet-length-limit-exceeded2026-10-18)） |
| macOS / BSD 服务器 | 没有 `/proc` | 应该显示“不支持”而不是报错；test-sshd 上是 `supported=false` |

建议的改法（做的时候再定）：容器里读 cgroup v2 的 `memory.max` / `memory.current`（附录 C 2.6）。

## 终端显示

**现状**：xterm.js 6，只装了自适应大小的插件；TERM 固定 `xterm-256color`；滚动缓冲 5000 行。

**建议加的**（附录 C 2.5、2.6）：Unicode 11 插件（中文和 emoji 宽度才对）、WebGL 渲染器（失败时退回默认渲染）。

**手测清单**（改了终端相关的代码、升级 xterm.js 时过一遍；网页版 `?mock` 的假终端测不了这些，要连 test-sshd 或真服务器）：

- vim：打开、编辑、退出后屏幕恢复
- tmux：分屏、鼠标点选、真彩色
- htop：刷新正常、颜色对
- 中文和 emoji：宽度对齐、不重叠
- 中文输入法：候选框位置、回车上屏
- 粘贴多行文字：括号粘贴生效，不会一行一行直接执行
- `less` 里滚动鼠标
- 改变窗口大小：内容重新排版，`stty size` 跟着变
- 大量输出（`yes`、`cat` 大文件）：Ctrl-C 能及时停（自动测试 `real_openssh_yes_then_ctrl_c` 管着，手测看界面有没有卡）
- 断网（关 Wi-Fi 或拔网线）：约 1 分钟内标签显示断线和原因，能一键重连

## 客户端系统

- **macOS**：所有者用的是 macOS 27。最低支持哪个版本还没定，第一次给别人用之前定（[release.md](release.md)）。macOS 27 上 Tauri 的标题栏问题见 [pitfalls.md](pitfalls.md#macos-27-上-tauri-窗口的标题栏不跟深色2026-10-18)。
- 网页版、Windows、手机：到各自的分册再写（见 [CLAUDE.md](../../CLAUDE.md) 的分册索引）。
