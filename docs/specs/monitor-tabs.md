# 系统信息、进程、网络标签页

> 2026-10-23。所有者选了设计稿方案 A（Chrome 式标签组），施工中。

## 问题

状态栏的「系统信息」只弹一个小框，内容比 FinalShell 少。FinalShell 点「系统信息」、进程框、网速图，会各开一个标签页：系统信息（发行版、内核、CPU 型号、CPU 占用细分、每块网卡的流量）、全部进程（带用户、命令行、程序位置）、网络（每个监听端口是哪个程序开的、连了几个 IP、上传下载）。

## 方案

设计稿：https://claude.ai/artifact/Nc4tRntjx3Nb4DhHfNbf1N

### 界面

- 状态栏的「系统信息」按钮、进程表的表身、网速图各打开一个标签页；已经开着就切过去。原来的系统信息弹窗去掉，它的内容（登录账号、服务器指纹、运行时间、负载、磁盘）并进系统信息页。
- 标签页属于打开它的那个会话（同一台服务器开两个会话就是两组）。会话有信息页时，会话标签和它的信息页组成 Chrome 式标签组：前面一个带颜色的名字块（服务器名），组里的标签叫「终端」「系统信息」「进程」「网络」，下面一条同色的线，选中的标签描一圈同色的边。点名字块收起 / 展开整组；收起时选中的标签在组里，就切到组外最近的标签，没有就开新标签页。从状态栏再打开这组的页会自动展开。
- 组的颜色在成组时挑一个别的组没在用的。最后一个信息页关掉，组就散了，会话标签变回原样。关掉会话标签时，它的信息页一起关。
- 标签宽度随文字（所有标签都改，所有者 2026-10-23 定），最长 240px，再长就省略。
- 选中信息页时，左边状态栏照常显示这个会话的服务器状态，底部状态条也一样。
- 进程页、网络页的表头能点着排序，再点一次反过来，选择会记住。进程页默认按 CPU 从高到低，网络页默认按上传从高到低。

### 接口

`SshSession`（`packages/ui/src/types.ts`）加两个方法，快照加几个字段：

- `setMonitorDetail({ procs, sockets })`：让正在跑的采样顺带多取全部进程 / 网络连接，改了马上采一次（和上次一样就不多采）。前端在会话开着进程页 / 网络页时打开，关掉就停。没在采样时后端只记下，下次开始采样时带上：桌面端前后两次 invoke 的到达顺序没有保证，它可能比开始采样先到。
- `systemInfo()`：一次性取发行版、内核、架构、主机名、CPU 型号。打开系统信息页时取，重连后重取。
- `MonitorSnapshot` 新增：`cpuDetail`（CPU 时间按用途分）、`ifaces`（全部网卡含 lo 的累计量和速率）、`disks` 多了 `used`、`device`、`fsType`；`allProcs`、`sockets` 只在打开对应开关时有，否则为 null。
- 桌面端命令 `ssh_monitor_detail`、`ssh_system_info`；WASM 的 `setMonitorDetail`、`systemInfo`。

### 在服务器上执行什么

沿用现在的做法：每次采样一条 `env LC_ALL=C sh -c "…"`，内容里不能有 `$`、反引号、反斜杠、双引号、`!`（见 `monitor.rs` 开头的注释和测试）。打开开关时在同一条命令末尾追加几段：

| 段 | 命令 | 解析 |
|---|---|---|
| `PSARGS`（procs） | `ps -eww -o pid= -o user:32= -o args= 2>/dev/null \|\| ps -o pid,user,args 2>/dev/null` | 每行：pid、用户、其余是命令行。第一项不是数字的行（BusyBox 的表头）跳过。每列单独一个 `-o`：按 POSIX，`=` 后面到参数末尾都算表头，`-o pid=,user=` 会把后几列当成 pid 列的表头 |
| `EXE`（procs） | `ls -l /proc/[0-9]*/exe 2>/dev/null` | 找 `/proc/<pid>/exe -> ` 后面的路径；读不了链接的进程，ls 把错误写进 stderr，那一行没有 ` -> `，跳过 |
| `LISTEN`（sockets） | `ss -Htulnp 2>/dev/null \|\| ss -tulnp 2>/dev/null \|\| echo NOSS` | 见下 |
| `CONNS`（sockets） | `ss -Htunpi state established 2>/dev/null \|\| ss -tunpi state established 2>/dev/null` | 见下 |

系统信息另跑一条：`/etc/os-release`（取不到读 `/usr/lib/os-release`）的 `PRETTY_NAME`，`uname -s`、`uname -r`、`uname -m`，`hostname`（不用 `hostname -f`，它要查 DNS，DNS 坏了会卡住；精简系统没有这个命令时退回 `uname -n`），`/proc/cpuinfo`。

`/proc/cpuinfo` 按型号分组：每个 `processor` 是一个逻辑 CPU，空行后不带 `processor` 的段（ARM 末尾的 `Hardware`、`Model`）是全机共用的。型号依次试 `model name`、`Processor`（老 ARM）、`cpu model`（MIPS）、`cpu`（PowerPC）、`uarch`（RISC-V）；64 位 ARM 一般都没有，按 `CPU implementer` + `CPU part` 查常见核心的表（照 lscpu，如 0x41/0xd0c 是 Neoverse-N1），查不到用 `Hardware`，再没有就是空字符串。颗数是不同 `physical id` 的个数，每颗核心取 `cpu cores`，频率取 `cpu MHz` 的平均，缓存原样取 `cache size`，bogomips 取 `bogomips` / `BogoMIPS`。

### 解析规则

- **CPU 细分**：`/proc/stat` 第一行前 8 项（user nice system idle iowait irq softirq steal）的差值除以总差值。
- **网卡**：`/proc/net/dev` 全部网卡含 lo，给累计字节和速率；原来的 `net` 字段照旧不含 lo（状态栏的“全部”是不含 lo 的合计）。
- **磁盘**：`df -kPT` 的设备、类型、已用三列也带上；没有类型列时类型为空字符串。
- **全部进程**：CPU 占用沿用现在每个进程的差值算法（已经对全部进程算了）；用户、命令行按 pid 从 `PSARGS` 补，位置从 `EXE` 补，对不上的留空字符串。命令行是服务器给的文本：控制字符换成空格，单条最长 1000 个字符。ps 把没有命令行的内核线程显示成 `[进程名]`，读不到程序位置、命令行又是这个样子的，命令行留空；读得到位置的照原样显示（有的木马把自己伪装成 `[kworker]`）。
- **ss 的行**：按空白切开，开头的 Netid（tcp/udp）和 State（LISTEN/UNCONN/ESTAB…）跳过，接着两个数字（Recv-Q、Send-Q），再是本地地址、对方地址，剩下的拼起来是 `users:(("名字",pid=N,fd=M),…)`，取第一个进程；没有这一段（不是 root 看别人的进程）时 pid 为 null、名字为空。带 `state established` 时 ss 不输出 State 列，所以 State 要按“是不是已知的状态词”判断，不能按位置。不满足这个格式的行（老版本 ss 的表头）跳过。
- **地址**：最后一个冒号后面是端口；去掉方括号和 `%网卡` 后缀；`::ffff:1.2.3.4` 当作 `1.2.3.4`。`*`、`0.0.0.0`、`::` 是“所有地址”。`listenIp` 照 ss 给的原样，`*` 不改写：新版 ss 的 `*` 是同时收 IPv4、IPv6 的套接字，老版 ss（CentOS 7）的 `*` 是 IPv4 的所有地址，改成哪个都可能错。
- **连接的流量**：`-i` 让每条 TCP 连接下一行（以空白开头）带 `bytes_acked:`（没有就用 `bytes_sent:`）和 `bytes_received:` 累计值。按“协议 + 本地地址 + 对方地址”记下，和上一次采样相减、除以服务器 uptime 的差得到速率。上一次采样也取了连接、但这条是新出现的，整条的累计量都算进这段时间；上一次没取连接（刚打开网络页）时速率记 0。UDP 没有字节数，只算连接数。
- **归到哪一行**：TCP 连接的本地端口等于某个监听端口、且监听地址是“所有地址”或和连接的本地地址相同，就归到那个监听行。几行都能收时按贴切程度挑：地址相同 > 同一地址族的 `0.0.0.0` / `::` > `*` > IPv6 的 `::`（没开 v6only 时也收 IPv4）；还一样（几个进程用 SO_REUSEPORT 监听同一端口）就挑进程号和连接相同的。已连接的 UDP 套接字照同样的规则归到 UDP 监听行（比如 QUIC 服务）。不按进程号匹配：Ubuntu 24.04 的 22 端口是 systemd 在监听，连进来的连接属于 sshd。剩下的连接按进程汇总成一行“主动连出去”，`listenIp`、`port` 为 null。同一个进程、同一地址和端口 TCP、UDP 都在监听的，合成一行。
- **数量上限**：监听行、连接各超过 20000 条只解析前 20000 条，进程超过 10000 个只给前 10000 个，防止异常输出把内存撑爆。
- **行的顺序**：监听行在前，按端口、地址排；主动连出去的在后，按进程名排。界面按用户选的列重排。

### 放弃的方案

- 进程页、网络页单独起一个采样循环：多一个 SSH 通道、多一次 sh，CPU 占用还得自己再算一遍。现在的循环已经对全部进程算了 CPU，顺带多读几段最省。
- 读 `/proc/net/tcp` 加扫 `/proc/<pid>/fd` 找进程：没有每条连接的流量，上传下载只能空着。
- 一直取全部进程和连接：大服务器每两秒几十 KB 到几 MB，关着标签页的时候白费。
- 按进程号把连接归到监听行：systemd 套接字激活（Ubuntu 24.04 的 ssh）下连接全算成“主动连出去”，和 FinalShell 对不上。

## 对其他平台的影响

- 网页端：WASM 版同样提供两个方法，走同一份 Rust 代码。
- Windows / 手机：只是前端标签和 Rust 采集，没有平台相关的东西。
- 服务器不是 Linux 时：快照照旧是 `supported=false`，信息页显示“暂不支持该系统的监控”；`systemInfo` 尽量给 uname 能拿到的。

## 安全

- 命令行里可能有密码（比如 `mysql -p密码`），和在服务器上跑 `ps` 看到的一样，只显示，不存盘、不进日志。
- 服务器给的一切当不可信输入：解析不 panic，长度和条数有上限，控制字符换掉。

## 怎么测

- Rust 单元测试：每段输出（含 BusyBox 的 ps 表头、看不到进程的 ss 行、`state established` 没有 State 列、IPv6 和 `%lo` 地址、`::ffff:` 地址、两次采样算速率、新连接、连接归属）各一条；采样命令里没有禁用字符；新加的几段在本机 sh 上真跑一遍能解析。
- 桌面端：test-sshd 上打开进程页、网络页能拿到数据（`scripts/check.sh desktop`）。
- 界面：网页版 `?mock` 的假后端也提供这些数据，深色、浅色各看一遍。
