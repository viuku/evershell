//! 服务器监控：不装 agent，每次采样只在服务器上执行一条命令，把 /proc 的几段文本一次性取回来，
//! 在本地解析。CPU 使用率和网速要靠相邻两次采样的差值算出来。
//!
//! 开着进程、网络标签页时（[`MonitorDetail`]），同一条命令末尾再追加几段，取全部进程的用户、命令行、
//! 程序位置和监听端口、连接。规格见 docs/specs/monitor-tabs.md。

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, oneshot};

use crate::Connection;

/// 每条命令都用 `env LC_ALL=C sh -c "…"` 包一层，不依赖用户的登录 shell 是不是 POSIX 的。
/// 双引号里不含 `$`、反引号、反斜杠、双引号和 `!`，所以对 bash / zsh / fish / csh 都一样（测试会查）。
const COMMAND_HEAD: &str = "env LC_ALL=C sh -c \"";

/// 采样命令的基础段，各段用 `==NAME==` 分隔。
/// `df -kPT` 能给文件系统类型（GNU、busybox 都支持），不支持时退回 `df -kP`。
///
/// 进程不用 `ps`：它给的 CPU 是进程从启动到现在的平均值，几乎不动；BusyBox 的 `ps` 也不支持要用的字段。
/// 改成读每个进程的 `/proc/<pid>/stat`，用 awk 只挑出 `pid utime stime rss comm` 五项
/// （第 1、14、15、24、2 项），整行五十多项原样传回来每次要多几十 KB。comm 在括号里，
/// 可能含空格和右括号，所以用最后一个右括号定位。awk 不能写 `$0` 和字符串常量，
/// 所以用 getline 读进变量、用正则找括号；只截取不做加法，老版 mawk 会把超过 2^31 的数打成科学计数法。
const BASE: &str = "\
echo ==UPTIME==; cat /proc/uptime; \
echo ==LOADAVG==; cat /proc/loadavg; \
echo ==STAT==; head -n1 /proc/stat; \
echo ==CORES==; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo; \
echo ==MEMINFO==; cat /proc/meminfo; \
echo ==NETDEV==; cat /proc/net/dev; \
echo ==DF==; df -kPT 2>/dev/null || df -kP 2>/dev/null; \
echo ==PAGESIZE==; getconf PAGESIZE 2>/dev/null; \
echo ==PROCS==; cat /proc/[0-9]*/stat 2>/dev/null | awk 'BEGIN{while((getline l)>0){\
if(match(l,/[(]/)==0)continue;o=RSTART;\
if(match(l,/.*[)]/)==0)continue;c=RLENGTH;\
if(split(substr(l,c+2),f)<22)continue;\
print substr(l,1,o-2),f[12],f[13],f[22],substr(l,o+1,c-o-1)}}'";

/// 进程标签页要的：每个进程的用户和命令行，程序位置（`/proc/<pid>/exe` 链接到哪）。
/// procps 的 `ps` 用 `-ww` 不截断命令行、`user:32` 让长用户名不被截断、`=` 去掉表头。
/// 每列单独一个 `-o`：按 POSIX，`=` 后面到参数末尾都算表头，写成 `-o pid=,user=` 的话
/// 后面几列会被当成 pid 列的表头（macOS 的 ps 就不这么认，各家不一致）。
/// BusyBox 的 `ps` 不认 `user:32`，退回它支持的 `-o pid,user,args`（有表头，解析时跳过）。
/// 读不了链接的进程（内核线程、别的用户的进程），`ls` 把错误写进 stderr，那一行没有 ` -> `。
const PROCS_EXTRA: &str = "; \
echo ==PSARGS==; ps -eww -o pid= -o user:32= -o args= 2>/dev/null || ps -o pid,user,args 2>/dev/null; \
echo ==EXE==; ls -l /proc/[0-9]*/exe 2>/dev/null";

/// 网络标签页要的：监听的端口（`-l`）和已建立的连接；`-p` 带出是哪个进程，
/// `-i` 让每条 TCP 连接下一行带累计收发字节。`-H` 去掉表头，老版本 ss 不认，退回带表头的写法
/// （解析时跳过）。没有 ss 时输出 NOSS。
const SOCKETS_EXTRA: &str = "; \
echo ==LISTEN==; ss -Htulnp 2>/dev/null || ss -tulnp 2>/dev/null || echo NOSS; \
echo ==CONNS==; ss -Htunpi state established 2>/dev/null || ss -tunpi state established 2>/dev/null";

/// 系统信息：发行版、内核、架构、主机名、CPU 型号。不用 `hostname -f`，它要查 DNS，DNS 坏了会卡住；
/// 有的精简系统没有 `hostname` 命令，退回 `uname -n`。
const SYSTEM_INFO_COMMAND: &str = "env LC_ALL=C sh -c \"\
echo ==OSRELEASE==; cat /etc/os-release 2>/dev/null || cat /usr/lib/os-release 2>/dev/null; \
echo ==KERNEL==; uname -s 2>/dev/null; \
echo ==RELEASE==; uname -r 2>/dev/null; \
echo ==ARCH==; uname -m 2>/dev/null; \
echo ==HOSTNAME==; hostname 2>/dev/null || uname -n 2>/dev/null; \
echo ==CPUINFO==; cat /proc/cpuinfo 2>/dev/null\"";

/// 拼出一次采样要执行的命令
fn command(detail: MonitorDetail) -> String {
    let mut cmd = String::from(COMMAND_HEAD);
    cmd.push_str(BASE);
    if detail.procs {
        cmd.push_str(PROCS_EXTRA);
    }
    if detail.sockets {
        cmd.push_str(SOCKETS_EXTRA);
    }
    cmd.push('"');
    cmd
}

/// 进程列表给界面多少个。实际传内存前这么多个、CPU 前这么多个的并集，界面按哪列排都能拿到真正的前几名。
pub const TOP_PROCS: usize = 10;
/// 进程标签页最多给多少个进程，防止异常输出把内存撑爆
pub const MAX_PROCS: usize = 10_000;
/// 监听行、连接各最多解析多少条
pub const MAX_CONNS: usize = 20_000;
/// 一条命令行最多留多少个字符
const MAX_CMDLINE: usize = 1000;

/// 采样时顺带多取哪些数据。只在开着对应标签页时打开：数据量大，一直取会加重服务器负担。
/// 和 packages/ui/src/types.ts 的 `MonitorDetail` 对应
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct MonitorDetail {
    /// 全部进程（含用户、命令行、程序位置）
    pub procs: bool,
    /// 监听端口和连接
    pub sockets: bool,
}

/// 一次监控采样。数值都是原始单位（字节、0–100 的百分比），格式化交给界面。
/// 字段与 packages/ui/src/types.ts 里的 `MonitorSnapshot` 一一对应。
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSnapshot {
    /// 服务器不是 Linux、或采集命令失败时为 false，此时其余字段无意义
    pub supported: bool,
    pub uptime_secs: f64,
    pub load: [f64; 3],
    /// 第一次采样没有参照，为 0
    pub cpu_percent: f64,
    /// CPU 时间按用途分；第一次采样为 None
    pub cpu_detail: Option<CpuDetail>,
    pub cpu_cores: u32,
    pub mem_total: u64,
    pub mem_used: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    /// 各网卡（不含 lo）的速率；第一次采样还算不出速率，为空
    pub net: Vec<NetRate>,
    /// 全部网卡（含 lo）的累计收发量和速率
    pub ifaces: Vec<IfaceStat>,
    /// 内存前 [`TOP_PROCS`] 和 CPU 前 [`TOP_PROCS`] 的并集，按内存从高到低
    pub procs: Vec<ProcInfo>,
    /// 真实文件系统的挂载点（不含 tmpfs、overlay 等）
    pub disks: Vec<DiskInfo>,
    /// 打开了 [`MonitorDetail::procs`] 才有：全部进程（最多 [`MAX_PROCS`] 个），顺序不定
    pub all_procs: Option<Vec<ProcDetail>>,
    /// 打开了 [`MonitorDetail::sockets`] 才有
    pub sockets: Option<SocketTable>,
    /// 本机到服务器的往返延迟（毫秒），见 [`Connection::ping`]；测不出时为 None
    pub latency_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetRate {
    pub iface: String,
    pub rx_per_sec: f64,
    pub tx_per_sec: f64,
}

/// CPU 时间按用途分的百分比，加起来是 100
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuDetail {
    pub user: f64,
    pub nice: f64,
    pub system: f64,
    pub idle: f64,
    pub iowait: f64,
    pub irq: f64,
    pub softirq: f64,
    pub steal: f64,
}

/// 一块网卡（含 lo）的累计收发量和速率
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IfaceStat {
    pub iface: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    /// 第一次采样、或这块网卡刚出现时算不出速率，为 None
    pub rx_per_sec: Option<f64>,
    pub tx_per_sec: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcInfo {
    pub pid: u32,
    pub name: String,
    pub mem_bytes: u64,
    /// 两次采样之间的占用，和 top 一样 100 表示占满一个核，多线程的进程可以超过 100；第一次采样为 0
    pub cpu_percent: f64,
}

/// 进程标签页的一行
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcDetail {
    pub pid: u32,
    /// 拿不到时为空字符串
    pub user: String,
    /// /proc/<pid>/stat 里的进程名
    pub name: String,
    /// 完整命令行；内核线程没有，为空字符串。控制字符已换成空格，最长 1000 个字符
    pub cmdline: String,
    /// 程序文件的位置；内核线程、或没有权限看别的用户的进程时为空字符串
    pub exe: String,
    pub mem_bytes: u64,
    pub cpu_percent: f64,
}

/// 网络标签页的一行：一个监听的地址和端口，或者一个进程主动连出去的连接汇总
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SocketRow {
    /// 不是 root 登录时看不到别的用户的进程，为 None
    pub pid: Option<u32>,
    /// 看不到时为空字符串
    pub name: String,
    /// 监听的地址（`*` 是 ss 给的“所有地址”）；主动连出去的那一行为 None
    pub listen_ip: Option<String>,
    /// 主动连出去的那一行为 None
    pub port: Option<u16>,
    /// 有几个不同的对方 IP
    pub ips: u32,
    /// 几条已建立的连接
    pub conns: u32,
    /// 字节/秒；第一次采样为 0
    pub tx_per_sec: f64,
    pub rx_per_sec: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SocketTable {
    /// 服务器上没有 ss 命令时为 false，rows 为空
    pub available: bool,
    pub rows: Vec<SocketRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub mount: String,
    pub size: u64,
    pub used: u64,
    pub avail: u64,
    /// 如 /dev/vda1
    pub device: String,
    /// 如 ext4；`df` 没有类型列时为空字符串
    pub fs_type: String,
}

/// 型号相同的一组 CPU。和 types.ts 的 `CpuGroup` 对应
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuGroup {
    /// /proc/cpuinfo 里没有时为空字符串
    pub model: String,
    /// 物理 CPU 颗数（不同的 physical id 个数）；拿不到时为 None
    pub sockets: Option<u32>,
    /// 每颗几个核心（cpu cores）；拿不到时为 None
    pub cores_per_socket: Option<u32>,
    /// 逻辑 CPU 数（processor 个数）
    pub threads: u32,
    /// 这组 cpu MHz 的平均；拿不到时为 None
    pub mhz: Option<f64>,
    /// 原样取 cache size，如“16384 KB”
    pub cache: Option<String>,
    pub bogomips: Option<f64>,
}

/// 不怎么变的系统信息。拿不到的项为空字符串。和 types.ts 的 `SystemInfo` 对应
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub os: String,
    pub kernel: String,
    pub kernel_release: String,
    pub arch: String,
    pub hostname: String,
    pub cpus: Vec<CpuGroup>,
}

/// 一次采样解析出来的原始数据，含算差值需要的累计计数器。
#[derive(Debug, Clone, PartialEq)]
pub struct Sample {
    pub uptime: f64,
    pub load: [f64; 3],
    /// /proc/stat 第一行的 (总 jiffies, 空闲 jiffies)
    pub cpu: (u64, u64),
    /// /proc/stat 第一行前 8 项：user nice system idle iowait irq softirq steal，缺的记 0
    pub cpu_times: [u64; 8],
    pub cores: u32,
    pub mem_total: u64,
    pub mem_used: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    /// (网卡, 累计收字节, 累计发字节)，含 lo
    pub net: Vec<(String, u64, u64)>,
    /// 全部进程
    pub procs: Vec<ProcSample>,
    pub disks: Vec<DiskInfo>,
    /// 打开了 [`MonitorDetail::procs`] 才有：按 pid 补的用户、命令行、程序位置
    pub proc_extra: Option<HashMap<u32, ProcExtra>>,
    /// 打开了 [`MonitorDetail::sockets`] 才有
    pub sockets: Option<SocketSample>,
}

/// 一次采样里的一个进程
#[derive(Debug, Clone, PartialEq)]
pub struct ProcSample {
    pub pid: u32,
    /// 累计用掉的 CPU 时间（用户态 + 内核态），单位和 /proc/stat 一样是时钟滴答
    pub ticks: u64,
    pub mem_bytes: u64,
    pub name: String,
}

/// `ps` 和 `ls -l /proc/*/exe` 补上的进程信息；对不上的项为空字符串
#[derive(Debug, Clone, Default, PartialEq)]
pub struct ProcExtra {
    pub user: String,
    pub cmdline: String,
    pub exe: String,
}

/// 一次采样里 ss 给的监听行和连接
#[derive(Debug, Clone, PartialEq)]
pub struct SocketSample {
    /// 服务器上没有 ss
    pub available: bool,
    pub listen: Vec<SsEntry>,
    pub conns: Vec<SsEntry>,
}

/// ss 的一行
#[derive(Debug, Clone, PartialEq)]
pub struct SsEntry {
    /// tcp / udp
    pub proto: String,
    /// 本地地址和端口，原样（如 `[::ffff:10.0.0.5]:22`）；和协议、对方地址一起认出同一条连接
    pub local: String,
    pub peer: String,
    pub pid: Option<u32>,
    pub name: String,
    /// TCP 连接的累计发送（对方已确认的）和接收字节；UDP、监听行没有
    pub tx_bytes: Option<u64>,
    pub rx_bytes: Option<u64>,
}

/// 按 `==NAME==` 切开的命令输出
struct Sections<'a>(Vec<(&'a str, Vec<&'a str>)>);

impl<'a> Sections<'a> {
    fn new(output: &'a str) -> Self {
        let mut sections: Vec<(&str, Vec<&str>)> = Vec::new();
        for line in output.lines() {
            let line = line.trim_end_matches('\r');
            if let Some(name) = line
                .strip_prefix("==")
                .and_then(|s| s.strip_suffix("=="))
                .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_uppercase()))
            {
                sections.push((name, Vec::new()));
            } else if let Some((_, lines)) = sections.last_mut() {
                lines.push(line);
            }
        }
        Self(sections)
    }

    fn get(&self, name: &str) -> &[&'a str] {
        self.0
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, l)| l.as_slice())
            .unwrap_or(&[])
    }

    fn has(&self, name: &str) -> bool {
        self.0.iter().any(|(n, _)| *n == name)
    }
}

/// 解析采样命令的输出。缺少核心段（uptime / loadavg / stat / meminfo）时返回 None。
pub fn parse(output: &str) -> Option<Sample> {
    let sections = Sections::new(output);
    let section = |name: &str| sections.get(name);

    let uptime = parse_uptime(section("UPTIME"))?;
    let load = parse_loadavg(section("LOADAVG"))?;
    let (cpu, cpu_times) = parse_stat(section("STAT"))?;
    let (mem_total, mem_used, swap_total, swap_used) = parse_meminfo(section("MEMINFO"))?;
    let cores = parse_cores(section("CORES")).unwrap_or(0);
    // 取不到页大小时按最常见的 4K 算
    let page_size = section("PAGESIZE")
        .iter()
        .find_map(|l| l.trim().parse::<u64>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(4096);
    let procs = parse_procs(section("PROCS"), page_size);
    // 段在不在只看命令里有没有加，段里是空的（命令失败）也照样给，只是各项为空
    let proc_extra = sections
        .has("PSARGS")
        .then(|| parse_proc_extra(&procs, section("PSARGS"), section("EXE")));
    let sockets = sections
        .has("LISTEN")
        .then(|| parse_sockets(section("LISTEN"), section("CONNS")));

    Some(Sample {
        uptime,
        load,
        cpu,
        cpu_times,
        cores,
        mem_total,
        mem_used,
        swap_total,
        swap_used,
        net: parse_netdev(section("NETDEV")),
        procs,
        disks: parse_df(section("DF")),
        proc_extra,
        sockets,
    })
}

/// 把当前采样和上一次采样合成一份快照。`prev` 为 None 时 CPU 为 0、网速为空。
pub fn snapshot(prev: Option<&Sample>, cur: &Sample, latency_ms: Option<f64>) -> MonitorSnapshot {
    let mut cpu_percent = 0.0;
    let mut cpu_detail = None;
    // 时间基准用服务器自己的 uptime 差，不受本地到服务器的网络抖动影响
    let dt = prev.map_or(0.0, |p| cur.uptime - p.uptime);
    if let Some(prev) = prev {
        let (total, idle) = (
            cur.cpu.0.saturating_sub(prev.cpu.0),
            cur.cpu.1.saturating_sub(prev.cpu.1),
        );
        if total > 0 {
            cpu_percent = (100.0 * (1.0 - idle as f64 / total as f64)).clamp(0.0, 100.0);
        }
        cpu_detail = cpu_breakdown(&prev.cpu_times, &cur.cpu_times);
    }
    let ifaces: Vec<IfaceStat> = cur
        .net
        .iter()
        .map(|(iface, rx, tx)| {
            let rate = prev
                .filter(|_| dt > 0.0)
                .and_then(|p| p.net.iter().find(|(n, _, _)| n == iface))
                .map(|(_, prx, ptx)| {
                    (rx.saturating_sub(*prx) as f64 / dt, tx.saturating_sub(*ptx) as f64 / dt)
                });
            IfaceStat {
                iface: iface.clone(),
                rx_bytes: *rx,
                tx_bytes: *tx,
                rx_per_sec: rate.map(|r| r.0),
                tx_per_sec: rate.map(|r| r.1),
            }
        })
        .collect();
    let net = ifaces
        .iter()
        .filter(|i| i.iface != "lo")
        .filter_map(|i| {
            Some(NetRate {
                iface: i.iface.clone(),
                rx_per_sec: i.rx_per_sec?,
                tx_per_sec: i.tx_per_sec?,
            })
        })
        .collect();
    let all = proc_cpu(prev, cur);
    let all_procs = cur.proc_extra.as_ref().map(|extra| proc_details(&all, extra));
    let sockets = cur
        .sockets
        .as_ref()
        .map(|s| socket_table(prev.and_then(|p| p.sockets.as_ref()), s, dt));
    MonitorSnapshot {
        supported: true,
        uptime_secs: cur.uptime,
        load: cur.load,
        cpu_percent,
        cpu_detail,
        cpu_cores: cur.cores,
        mem_total: cur.mem_total,
        mem_used: cur.mem_used,
        swap_total: cur.swap_total,
        swap_used: cur.swap_used,
        net,
        ifaces,
        procs: top_procs(all),
        disks: cur.disks.clone(),
        all_procs,
        sockets,
        latency_ms,
    }
}

fn parse_uptime(lines: &[&str]) -> Option<f64> {
    lines.first()?.split_whitespace().next()?.parse().ok()
}

fn parse_loadavg(lines: &[&str]) -> Option<[f64; 3]> {
    let mut it = lines.first()?.split_whitespace();
    Some([
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
        it.next()?.parse().ok()?,
    ])
}

/// `cpu user nice system idle iowait irq softirq steal ...`：
/// 总量取前 8 项（guest 已含在 user / nice 里），空闲 = idle + iowait。
/// 返回 ((总量, 空闲), 前 8 项)
fn parse_stat(lines: &[&str]) -> Option<((u64, u64), [u64; 8])> {
    let line = lines.iter().find(|l| l.starts_with("cpu "))?;
    let nums: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .take(8)
        .filter_map(|s| s.parse().ok())
        .collect();
    if nums.len() < 4 {
        return None;
    }
    let mut times = [0u64; 8];
    times[..nums.len()].copy_from_slice(&nums);
    let total = nums.iter().fold(0u64, |a, b| a.saturating_add(*b));
    let idle = nums[3].saturating_add(nums.get(4).copied().unwrap_or(0));
    Some(((total, idle), times))
}

/// 两次 /proc/stat 前 8 项的差值占总差值的百分比；总差值为 0 时算不出
fn cpu_breakdown(prev: &[u64; 8], cur: &[u64; 8]) -> Option<CpuDetail> {
    let d: Vec<f64> = cur
        .iter()
        .zip(prev)
        .map(|(c, p)| c.saturating_sub(*p) as f64)
        .collect();
    let total: f64 = d.iter().sum();
    if total <= 0.0 {
        return None;
    }
    let pct = |i: usize| d[i] * 100.0 / total;
    Some(CpuDetail {
        user: pct(0),
        nice: pct(1),
        system: pct(2),
        idle: pct(3),
        iowait: pct(4),
        irq: pct(5),
        softirq: pct(6),
        steal: pct(7),
    })
}

fn parse_cores(lines: &[&str]) -> Option<u32> {
    lines
        .iter()
        .find_map(|l| l.trim().parse::<u32>().ok())
        .filter(|n| *n > 0)
}

/// 返回 (内存总量, 已用内存, 交换分区总量, 已用交换分区)，单位字节
fn parse_meminfo(lines: &[&str]) -> Option<(u64, u64, u64, u64)> {
    let get = |key: &str| -> Option<u64> {
        lines.iter().find_map(|l| {
            let (k, v) = l.split_once(':')?;
            if k.trim() != key {
                return None;
            }
            v.split_whitespace()
                .next()?
                .parse::<u64>()
                .ok()
                .map(|kb| kb.saturating_mul(1024))
        })
    };
    let total = get("MemTotal")?;
    // MemAvailable（3.14+）才是"还能用多少"；老内核退回 free + buffers + cached
    let available = get("MemAvailable").or_else(|| {
        Some(
            get("MemFree")?
                .saturating_add(get("Buffers").unwrap_or(0))
                .saturating_add(get("Cached").unwrap_or(0)),
        )
    })?;
    let swap_total = get("SwapTotal").unwrap_or(0);
    let swap_free = get("SwapFree").unwrap_or(swap_total);
    Some((
        total,
        total.saturating_sub(available),
        swap_total,
        swap_total.saturating_sub(swap_free),
    ))
}

/// /proc/net/dev：`iface: rx_bytes ... (共 8 项) tx_bytes ...`，含 lo
fn parse_netdev(lines: &[&str]) -> Vec<(String, u64, u64)> {
    lines
        .iter()
        .filter_map(|l| {
            let (iface, rest) = l.split_once(':')?;
            let nums: Vec<u64> = rest
                .split_whitespace()
                .filter_map(|s| s.parse().ok())
                .collect();
            Some((iface.trim().to_string(), *nums.first()?, *nums.get(8)?))
        })
        .collect()
}

/// 采样命令里 awk 的输出：`pid utime stime rss comm`，rss 单位是页；comm 可能含空格，取剩余全部
fn parse_procs(lines: &[&str], page_size: u64) -> Vec<ProcSample> {
    lines
        .iter()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let pid: u32 = it.next()?.parse().ok()?;
            let utime: u64 = it.next()?.parse().ok()?;
            let stime: u64 = it.next()?.parse().ok()?;
            let rss: u64 = it.next()?.parse().ok()?;
            let name = it.collect::<Vec<_>>().join(" ");
            if name.is_empty() {
                return None;
            }
            Some(ProcSample {
                pid,
                ticks: utime.saturating_add(stime),
                mem_bytes: rss.saturating_mul(page_size),
                name,
            })
        })
        .collect()
}

/// 用两次采样的 CPU 时间差算每个进程的占用，顺序和 `cur.procs` 一样
fn proc_cpu(prev: Option<&Sample>, cur: &Sample) -> Vec<ProcInfo> {
    let cores = cur.cores.max(1) as f64;
    // 这段时间里一个核走过的滴答数；/proc/stat 第一行是所有核加起来的
    let per_core = prev.map_or(0.0, |p| cur.cpu.0.saturating_sub(p.cpu.0) as f64 / cores);
    let before: HashMap<u32, u64> = prev
        .map(|p| p.procs.iter().map(|q| (q.pid, q.ticks)).collect())
        .unwrap_or_default();
    cur.procs
        .iter()
        .map(|p| {
            // 上次没有的是新进程，这次先记 0；进程号被重用时差值可能离谱，最多算满所有核
            let used = before.get(&p.pid).map_or(0, |t| p.ticks.saturating_sub(*t));
            let cpu_percent = if per_core > 0.0 {
                (used as f64 / per_core * 100.0).min(cores * 100.0)
            } else {
                0.0
            };
            ProcInfo {
                pid: p.pid,
                name: p.name.clone(),
                mem_bytes: p.mem_bytes,
                cpu_percent,
            }
        })
        .collect()
}

/// 挑出内存前 [`TOP_PROCS`] 和 CPU 前 [`TOP_PROCS`]，按内存从高到低排。
fn top_procs(mut all: Vec<ProcInfo>) -> Vec<ProcInfo> {
    all.sort_by_key(|p| std::cmp::Reverse(p.mem_bytes));
    let mut keep = vec![false; all.len()];
    keep.iter_mut().take(TOP_PROCS).for_each(|k| *k = true);
    // 稳定排序：CPU 一样时（大多是 0）内存大的在前
    let mut by_cpu: Vec<usize> = (0..all.len()).collect();
    by_cpu.sort_by(|&a, &b| all[b].cpu_percent.total_cmp(&all[a].cpu_percent));
    by_cpu.iter().take(TOP_PROCS).for_each(|&i| keep[i] = true);
    all.into_iter()
        .zip(keep)
        .filter_map(|(p, k)| k.then_some(p))
        .collect()
}

/// 服务器给的文本：控制字符换成空格，最长 `max` 个字符
fn clean(s: &str, max: usize) -> String {
    s.chars()
        .take(max)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}

/// 按 pid 从 `ps` 和 `ls -l /proc/*/exe` 的输出补用户、命令行、程序位置。
/// 只留 `procs` 前 [`MAX_PROCS`] 个进程的，别的行不占内存。
fn parse_proc_extra(procs: &[ProcSample], psargs: &[&str], exe: &[&str]) -> HashMap<u32, ProcExtra> {
    let wanted: HashSet<u32> = procs.iter().take(MAX_PROCS).map(|p| p.pid).collect();
    let mut map: HashMap<u32, ProcExtra> = HashMap::new();
    for (pid, user, args) in psargs.iter().filter_map(|l| parse_ps_line(l)) {
        if wanted.contains(&pid) {
            let e = map.entry(pid).or_default();
            e.user = clean(user, 64);
            e.cmdline = clean(args, MAX_CMDLINE);
        }
    }
    for (pid, path) in exe.iter().filter_map(|l| parse_exe_line(l)) {
        if wanted.contains(&pid) {
            map.entry(pid).or_default().exe = clean(path, 4096);
        }
    }
    map
}

/// `  1234 root     /usr/sbin/sshd -D`：pid、用户、其余是命令行。第一项不是数字的行（BusyBox 的表头）返回 None
fn parse_ps_line(line: &str) -> Option<(u32, &str, &str)> {
    let mut rest = line;
    let pid: u32 = next_token(&mut rest)?.parse().ok()?;
    let user = next_token(&mut rest)?;
    Some((pid, user, rest.trim()))
}

/// `lrwxrwxrwx 1 root root 0 Oct 23 10:00 /proc/1/exe -> /usr/lib/systemd/systemd`
fn parse_exe_line(line: &str) -> Option<(u32, &str)> {
    const ARROW: &str = "/exe -> ";
    let i = line.find(ARROW)?;
    let pid = line[..i].rsplit("/proc/").next()?.parse().ok()?;
    let path = &line[i + ARROW.len()..];
    (!path.is_empty()).then_some((pid, path))
}

/// ps 给内核线程（没有命令行的进程）显示成 `[进程名]`
fn is_kernel_thread_args(args: &str, name: &str) -> bool {
    args.strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .is_some_and(|inner| !name.is_empty() && inner.starts_with(name))
}

fn proc_details(all: &[ProcInfo], extra: &HashMap<u32, ProcExtra>) -> Vec<ProcDetail> {
    all.iter()
        .take(MAX_PROCS)
        .map(|p| {
            let e = extra.get(&p.pid);
            let user = e.map_or("", |e| e.user.as_str());
            let exe = e.map_or("", |e| e.exe.as_str());
            let mut cmdline = e.map_or("", |e| e.cmdline.as_str());
            // 读得到程序位置的不是内核线程，哪怕命令行长得像（有的木马就这么伪装）
            if exe.is_empty() && is_kernel_thread_args(cmdline, &p.name) {
                cmdline = "";
            }
            ProcDetail {
                pid: p.pid,
                user: user.to_string(),
                name: clean(&p.name, 64),
                cmdline: cmdline.to_string(),
                exe: exe.to_string(),
                mem_bytes: p.mem_bytes,
                cpu_percent: p.cpu_percent,
            }
        })
        .collect()
}

/// 取下一个空白分隔的词，`rest` 移到它后面
fn next_token<'a>(rest: &mut &'a str) -> Option<&'a str> {
    let s = rest.trim_start();
    if s.is_empty() {
        return None;
    }
    let end = s.find(char::is_whitespace).unwrap_or(s.len());
    let (token, after) = s.split_at(end);
    *rest = after;
    Some(token)
}

const SS_NETIDS: &[&str] = &["tcp", "udp", "raw", "sctp", "mptcp", "dccp"];
const SS_STATES: &[&str] = &[
    "LISTEN",
    "UNCONN",
    "ESTAB",
    "SYN-SENT",
    "SYN-RECV",
    "FIN-WAIT-1",
    "FIN-WAIT-2",
    "TIME-WAIT",
    "CLOSE-WAIT",
    "LAST-ACK",
    "CLOSING",
    "CLOSED",
    "UNKNOWN",
];

/// ss 的一行：`[Netid] [State] Recv-Q Send-Q 本地 对方 [users:((…))]`。
/// 只选了一种状态（`state established`）时 ss 不输出 State 列，所以 State 按是不是已知的状态词判断。
/// 不满足这个格式的行（老版本 ss 的表头）返回 None
fn parse_ss_line(line: &str) -> Option<SsEntry> {
    let mut rest = line;
    let mut token = next_token(&mut rest)?;
    let mut netid = None;
    if SS_NETIDS.contains(&token) {
        netid = Some(token);
        token = next_token(&mut rest)?;
    }
    let mut state = None;
    if SS_STATES.contains(&token) {
        state = Some(token);
        token = next_token(&mut rest)?;
    }
    token.parse::<u64>().ok()?;
    next_token(&mut rest)?.parse::<u64>().ok()?;
    let local = next_token(&mut rest)?;
    let peer = next_token(&mut rest)?;
    if !local.contains(':') || !peer.contains(':') {
        return None;
    }
    let (pid, name) = parse_ss_users(rest);
    let proto = match (netid, state) {
        (Some(n), _) => n,
        (None, Some("UNCONN")) => "udp",
        _ => "tcp",
    };
    Some(SsEntry {
        proto: proto.to_string(),
        local: clean(local, 128),
        peer: clean(peer, 128),
        pid,
        name,
        tx_bytes: None,
        rx_bytes: None,
    })
}

/// `users:(("sshd",pid=1234,fd=3),("systemd",pid=1,fd=88))` 取第一个进程；
/// 很老的 ss 写成 `users:(("sshd",1234,3))`。没有这一段（不是 root 看别人的进程）时为 (None, "")
fn parse_ss_users(rest: &str) -> (Option<u32>, String) {
    const START: &str = "users:((\"";
    let Some(i) = rest.find(START) else {
        return (None, String::new());
    };
    let after = &rest[i + START.len()..];
    let Some(j) = after.find("\",") else {
        return (None, String::new());
    };
    let tail = &after[j + 2..];
    let tail = tail.strip_prefix("pid=").unwrap_or(tail);
    let digits = &tail[..tail.find(|c: char| !c.is_ascii_digit()).unwrap_or(tail.len())];
    (digits.parse().ok(), clean(&after[..j], 64))
}

/// `-i` 给每条 TCP 连接的第二行：`cubic wscale:7,7 … bytes_sent:52341 bytes_acked:52300 bytes_received:8812 …`
fn apply_tcp_info(entry: &mut SsEntry, line: &str) {
    let (mut acked, mut sent, mut received) = (None, None, None);
    for token in line.split_whitespace() {
        if let Some(v) = token.strip_prefix("bytes_acked:") {
            acked = v.parse().ok();
        } else if let Some(v) = token.strip_prefix("bytes_sent:") {
            sent = v.parse().ok();
        } else if let Some(v) = token.strip_prefix("bytes_received:") {
            received = v.parse().ok();
        }
    }
    entry.tx_bytes = acked.or(sent).or(entry.tx_bytes);
    entry.rx_bytes = received.or(entry.rx_bytes);
}

fn parse_sockets(listen: &[&str], conns: &[&str]) -> SocketSample {
    let available = !listen.iter().any(|l| l.trim() == "NOSS");
    let listen = listen
        .iter()
        .filter_map(|l| parse_ss_line(l))
        .take(MAX_CONNS)
        .collect();
    let mut entries: Vec<SsEntry> = Vec::new();
    // 上一行是不是刚解析出来的连接；`-i` 的第二行只归给紧挨着的那条
    let mut after_conn = false;
    for line in conns {
        if line.starts_with(char::is_whitespace) {
            if let (true, Some(last)) = (after_conn, entries.last_mut()) {
                apply_tcp_info(last, line);
            }
            after_conn = false;
            continue;
        }
        if entries.len() >= MAX_CONNS {
            break;
        }
        match parse_ss_line(line) {
            Some(e) => {
                entries.push(e);
                after_conn = true;
            }
            None => after_conn = false,
        }
    }
    SocketSample {
        available,
        listen,
        conns: entries,
    }
}

/// `[::ffff:10.0.0.5]:22` → ("10.0.0.5", Some(22))；`127.0.0.53%lo:53` → ("127.0.0.53", Some(53))；
/// `[fe80::1]%eth0:546` → ("fe80::1", Some(546))；`0.0.0.0:*` → ("0.0.0.0", None)；老 ss 的 `:::22` → ("::", Some(22))
fn split_addr(s: &str) -> (String, Option<u16>) {
    let (host, port) = s.rsplit_once(':').unwrap_or((s, ""));
    let host = host.split('%').next().unwrap_or(host);
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let host = match host.get(..7) {
        Some(p) if p.eq_ignore_ascii_case("::ffff:") && host[7..].contains('.') => &host[7..],
        _ => host,
    };
    (host.to_string(), port.parse().ok())
}

/// 监听地址能不能收这个本地地址上的连接，数字越小越贴切：
/// 地址相同 > 同一地址族的“所有地址” > ss 的 `*` > IPv6 的 `::`（没开 v6only 时也收 IPv4）
fn listener_score(listen_ip: &str, local_ip: &str) -> Option<u8> {
    let v6 = local_ip.contains(':');
    match listen_ip {
        _ if listen_ip == local_ip => Some(0),
        "0.0.0.0" if !v6 => Some(1),
        "::" if v6 => Some(1),
        "*" => Some(2),
        "::" => Some(3),
        "0.0.0.0" => Some(4),
        _ => None,
    }
}

/// 上一次每条连接的累计（发送, 接收）字节，按（协议, 本地地址, 对方地址）认
type ConnBytes<'a> = HashMap<(&'a str, &'a str, &'a str), (Option<u64>, Option<u64>)>;

struct Listener {
    pid: Option<u32>,
    name: String,
    ip: String,
    port: u16,
    tcp: bool,
    udp: bool,
}

#[derive(Default)]
struct ConnTotals {
    peers: HashSet<String>,
    conns: u32,
    tx: f64,
    rx: f64,
}

impl ConnTotals {
    fn row(&self, pid: Option<u32>, name: &str, listen: Option<(&str, u16)>) -> SocketRow {
        SocketRow {
            pid,
            name: name.to_string(),
            listen_ip: listen.map(|(ip, _)| ip.to_string()),
            port: listen.map(|(_, port)| port),
            ips: self.peers.len() as u32,
            conns: self.conns,
            tx_per_sec: self.tx,
            rx_per_sec: self.rx,
        }
    }
}

/// 把连接归到监听行，算每行的对方 IP 数、连接数和速率。
/// 本地端口等于某个监听端口、监听地址是“所有地址”或和本地地址相同，就归到那一行；不按进程号归
/// （systemd 套接字激活时监听的是 systemd，连进来的连接属于 sshd）。剩下的按进程汇总成“主动连出去”的一行。
/// `prev` 为 None（上一次没取连接）时速率记 0；上一次有、这条是新出现的，整条的累计量都算进这段时间。
fn socket_table(prev: Option<&SocketSample>, cur: &SocketSample, dt: f64) -> SocketTable {
    if !cur.available {
        return SocketTable {
            available: false,
            rows: Vec::new(),
        };
    }

    // 同一个进程、同一地址和端口，TCP、UDP 合成一行
    let mut listeners: Vec<Listener> = Vec::new();
    let mut index: HashMap<(Option<u32>, String, String, u16), usize> = HashMap::new();
    for e in &cur.listen {
        let (ip, Some(port)) = split_addr(&e.local) else { continue };
        let key = (e.pid, e.name.clone(), ip.clone(), port);
        let i = *index.entry(key).or_insert_with(|| {
            listeners.push(Listener { pid: e.pid, name: e.name.clone(), ip, port, tcp: false, udp: false });
            listeners.len() - 1
        });
        listeners[i].tcp |= e.proto == "tcp";
        listeners[i].udp |= e.proto == "udp";
    }
    let mut by_port: HashMap<u16, Vec<usize>> = HashMap::new();
    for (i, l) in listeners.iter().enumerate() {
        by_port.entry(l.port).or_default().push(i);
    }

    let before: Option<ConnBytes> = prev.map(|p| {
        p.conns
            .iter()
            .map(|c| ((c.proto.as_str(), c.local.as_str(), c.peer.as_str()), (c.tx_bytes, c.rx_bytes)))
            .collect()
    });
    let rate = |c: &SsEntry| -> (f64, f64) {
        let Some(before) = before.as_ref().filter(|_| dt > 0.0) else {
            return (0.0, 0.0);
        };
        let (old_tx, old_rx) = before
            .get(&(c.proto.as_str(), c.local.as_str(), c.peer.as_str()))
            .copied()
            .unwrap_or_default();
        let per_sec = |now: Option<u64>, old: Option<u64>| {
            now.map_or(0.0, |n| n.saturating_sub(old.unwrap_or(0)) as f64 / dt)
        };
        (per_sec(c.tx_bytes, old_tx), per_sec(c.rx_bytes, old_rx))
    };

    let mut listen_totals: Vec<ConnTotals> = listeners.iter().map(|_| ConnTotals::default()).collect();
    let mut outgoing: BTreeMap<(String, Option<u32>), ConnTotals> = BTreeMap::new();
    for c in &cur.conns {
        let (local_ip, local_port) = split_addr(&c.local);
        let (peer_ip, _) = split_addr(&c.peer);
        // 同样贴切时（比如几个进程用 SO_REUSEPORT 监听同一个端口）先挑进程号相同的
        let target = local_port
            .and_then(|p| by_port.get(&p))
            .and_then(|candidates| {
                candidates
                    .iter()
                    .filter(|&&i| (c.proto == "tcp" && listeners[i].tcp) || (c.proto == "udp" && listeners[i].udp))
                    .filter_map(|&i| {
                        let score = listener_score(&listeners[i].ip, &local_ip)?;
                        Some((score, c.pid.is_none() || listeners[i].pid != c.pid, i))
                    })
                    .min()
            })
            .map(|(_, _, i)| i);
        let totals = match target {
            Some(i) => &mut listen_totals[i],
            None => outgoing.entry((c.name.clone(), c.pid)).or_default(),
        };
        let (tx, rx) = rate(c);
        totals.peers.insert(peer_ip);
        totals.conns += 1;
        totals.tx += tx;
        totals.rx += rx;
    }

    let mut order: Vec<usize> = (0..listeners.len()).collect();
    order.sort_by(|&a, &b| {
        let (la, lb) = (&listeners[a], &listeners[b]);
        (la.port, &la.ip, &la.name, la.pid).cmp(&(lb.port, &lb.ip, &lb.name, lb.pid))
    });
    let mut rows: Vec<SocketRow> = order
        .into_iter()
        .map(|i| {
            let l = &listeners[i];
            listen_totals[i].row(l.pid, &l.name, Some((l.ip.as_str(), l.port)))
        })
        .collect();
    rows.extend(outgoing.iter().map(|((name, pid), t)| t.row(*pid, name, None)));
    SocketTable {
        available: true,
        rows,
    }
}

/// 不是真实磁盘的文件系统类型（`df -T` 的 Type 列）
const PSEUDO_FS_TYPES: &[&str] = &[
    "tmpfs",
    "devtmpfs",
    "overlay",
    "squashfs",
    "proc",
    "sysfs",
    "devpts",
    "cgroup",
    "cgroup2",
    "mqueue",
    "debugfs",
    "tracefs",
    "securityfs",
    "pstore",
    "efivarfs",
    "fusectl",
    "configfs",
    "hugetlbfs",
    "binfmt_misc",
    "autofs",
    "rpc_pipefs",
    "nsfs",
    "bpf",
    "ramfs",
    "rootfs",
    "fuse.portal",
    "fuse.gvfsd-fuse",
    "fuse.lxcfs",
    "fuse.snapfuse",
];

/// 没有 Type 列时按 Filesystem 列判断
const PSEUDO_FS_NAMES: &[&str] = &[
    "tmpfs", "devtmpfs", "udev", "overlay", "squashfs", "none", "shm", "cgroup", "cgroup2", "proc",
    "sysfs", "devpts", "efivarfs", "fusectl", "configfs", "debugfs", "tracefs", "securityfs",
    "pstore", "mqueue", "hugetlbfs", "binfmt_misc", "systemd-1", "lxcfs", "portal", "gvfsd-fuse",
];

/// `df -kP[T]`：有 Type 列是 7 列，否则 6 列；挂载点可能含空格，取剩余全部。
/// 只保留真实文件系统，同一个设备（bind mount）只留第一个。
fn parse_df(lines: &[&str]) -> Vec<DiskInfo> {
    let Some(header) = lines.first() else {
        return Vec::new();
    };
    let has_type = header.split_whitespace().nth(1) == Some("Type");
    let mut seen = Vec::new();
    let mut disks = Vec::new();
    for line in &lines[1..] {
        let cols: Vec<&str> = line.split_whitespace().collect();
        let (fs, fs_type, rest) = if has_type {
            if cols.len() < 7 {
                continue;
            }
            (cols[0], Some(cols[1]), &cols[2..])
        } else {
            if cols.len() < 6 {
                continue;
            }
            (cols[0], None, &cols[1..])
        };
        let pseudo = match fs_type {
            Some(t) => PSEUDO_FS_TYPES.contains(&t) || (t.starts_with("fuse.") && t != "fuse.sshfs"),
            None => PSEUDO_FS_NAMES.contains(&fs),
        };
        // snap 包都是 /dev/loop 上的 squashfs
        if pseudo || fs.starts_with("/dev/loop") || seen.contains(&fs) {
            continue;
        }
        let (Ok(size), Ok(used), Ok(avail)) = (
            rest[0].parse::<u64>(),
            rest[1].parse::<u64>(),
            rest[2].parse::<u64>(),
        ) else {
            continue;
        };
        let mount = rest[4..].join(" ");
        if mount.is_empty() {
            continue;
        }
        seen.push(fs);
        disks.push(DiskInfo {
            mount,
            size: size.saturating_mul(1024),
            used: used.saturating_mul(1024),
            avail: avail.saturating_mul(1024),
            device: fs.to_string(),
            fs_type: fs_type.unwrap_or("").to_string(),
        });
    }
    disks
}

/// 取一次系统信息（发行版、内核、CPU 型号这些不怎么变的）。服务器不是 Linux 时尽量给 uname 能拿到的
pub async fn system_info(conn: &Connection) -> crate::Result<SystemInfo> {
    let out = conn.exec(SYSTEM_INFO_COMMAND).await?;
    Ok(parse_system_info(&out.stdout_lossy()))
}

/// 解析系统信息命令的输出；拿不到的项为空字符串
pub fn parse_system_info(output: &str) -> SystemInfo {
    let sections = Sections::new(output);
    let first_line = |name: &str| {
        sections
            .get(name)
            .iter()
            .map(|l| l.trim())
            .find(|l| !l.is_empty())
            .map(|l| clean(l, 256))
            .unwrap_or_default()
    };
    SystemInfo {
        os: parse_os_release(sections.get("OSRELEASE")),
        kernel: first_line("KERNEL"),
        kernel_release: first_line("RELEASE"),
        arch: first_line("ARCH"),
        hostname: first_line("HOSTNAME"),
        cpus: parse_cpuinfo(sections.get("CPUINFO")),
    }
}

/// os-release 的 `PRETTY_NAME`，没有时拼 `NAME VERSION`
fn parse_os_release(lines: &[&str]) -> String {
    let get = |key: &str| {
        lines
            .iter()
            .find_map(|l| {
                let (k, v) = l.split_once('=')?;
                (k.trim() == key).then(|| unquote(v.trim()))
            })
            .filter(|v| !v.is_empty())
    };
    let os = get("PRETTY_NAME")
        .or_else(|| {
            let name = get("NAME")?;
            Some(match get("VERSION") {
                Some(v) => format!("{name} {v}"),
                None => name,
            })
        })
        .unwrap_or_default();
    clean(&os, 256)
}

/// os-release 的值是 shell 写法：可能带单引号或双引号，双引号里用反斜杠转义
fn unquote(v: &str) -> String {
    let quoted = v.len() >= 2
        && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\'')));
    let inner = if quoted { &v[1..v.len() - 1] } else { v };
    let mut out = String::new();
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => out.extend(chars.next()),
            c => out.push(c),
        }
    }
    out
}

/// /proc/cpuinfo 里一个逻辑 CPU 的各项
type CpuBlock<'a> = Vec<(&'a str, &'a str)>;

fn cpuinfo_get<'a>(kvs: &[(&'a str, &'a str)], key: &str) -> Option<&'a str> {
    kvs.iter().find(|(k, v)| *k == key && !v.is_empty()).map(|(_, v)| *v)
}

/// 按型号把逻辑 CPU 分组（big.LITTLE 的 ARM 会分成两组）。
/// 每个 `processor : N` 开始一个逻辑 CPU；空行后面不带 processor 的段（ARM 末尾的 Hardware、Model）是全机共用的
fn parse_cpuinfo(lines: &[&str]) -> Vec<CpuGroup> {
    const MAX_CPUS: usize = 8192;
    let mut blocks: Vec<CpuBlock> = Vec::new();
    let mut global: CpuBlock = Vec::new();
    let mut para: CpuBlock = Vec::new();
    let is_processor = |(k, v): &(&str, &str)| *k == "processor" && v.parse::<u32>().is_ok();
    for line in lines.iter().chain(std::iter::once(&"")) {
        let kv = line.split_once(':').map(|(k, v)| (k.trim(), v.trim()));
        let new_cpu = kv.as_ref().is_some_and(is_processor) && para.iter().any(is_processor);
        if line.trim().is_empty() || new_cpu {
            let done = std::mem::take(&mut para);
            if done.iter().any(is_processor) {
                if blocks.len() < MAX_CPUS {
                    blocks.push(done);
                }
            } else {
                global.extend(done);
            }
        }
        if let Some(kv) = kv {
            para.push(kv);
        }
    }

    let mut groups: Vec<(String, Vec<&CpuBlock>)> = Vec::new();
    for b in &blocks {
        let model = cpu_model(b, &global);
        match groups.iter_mut().find(|(m, _)| *m == model) {
            Some((_, members)) => members.push(b),
            None => groups.push((model, vec![b])),
        }
    }
    groups
        .into_iter()
        .map(|(model, members)| {
            let values = |key: &'static str| members.iter().filter_map(move |b| cpuinfo_get(b, key));
            let physical: HashSet<&str> = values("physical id").collect();
            let mhz: Vec<f64> = values("cpu MHz")
                .filter_map(|v| v.parse::<f64>().ok())
                .filter(|f| f.is_finite())
                .collect();
            let bogomips = values("bogomips")
                .chain(values("BogoMIPS"))
                .chain(cpuinfo_get(&global, "BogoMIPS"))
                .chain(cpuinfo_get(&global, "bogomips"))
                .filter_map(|v| v.parse::<f64>().ok())
                .find(|f| f.is_finite());
            CpuGroup {
                model,
                sockets: (!physical.is_empty()).then_some(physical.len() as u32),
                cores_per_socket: values("cpu cores").find_map(|v| v.parse().ok()),
                threads: members.len() as u32,
                mhz: (!mhz.is_empty()).then(|| mhz.iter().sum::<f64>() / mhz.len() as f64),
                cache: values("cache size").next().map(|v| clean(v, 64)),
                bogomips,
            }
        })
        .collect()
}

/// 一个逻辑 CPU 的型号：x86 的 `model name`，老 ARM 的 `Processor`，MIPS 的 `cpu model`，PowerPC 的 `cpu`，
/// RISC-V 的 `uarch`；64 位 ARM 一般都没有，按 `CPU implementer` / `CPU part` 查表，再不行用全机的 `Hardware`
fn cpu_model(block: &[(&str, &str)], global: &[(&str, &str)]) -> String {
    let model = ["model name", "Processor", "cpu model", "cpu", "uarch"]
        .iter()
        .find_map(|k| cpuinfo_get(block, k))
        .map(str::to_string)
        .or_else(|| arm_core_name(cpuinfo_get(block, "CPU implementer")?, cpuinfo_get(block, "CPU part")?))
        .or_else(|| cpuinfo_get(global, "Hardware").map(str::to_string))
        .unwrap_or_default();
    // 有的型号里有连续空格（Intel(R) Xeon(R) CPU           E5-2680）
    clean(&model, 256).split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 常见 ARM 核心的名字，照 util-linux 的 lscpu
fn arm_core_name(implementer: &str, part: &str) -> Option<String> {
    let hex = |s: &str| u32::from_str_radix(s.trim().trim_start_matches("0x"), 16).ok();
    let name = match (hex(implementer)?, hex(part)?) {
        (0x41, 0xd03) => "ARM Cortex-A53",
        (0x41, 0xd04) => "ARM Cortex-A35",
        (0x41, 0xd05) => "ARM Cortex-A55",
        (0x41, 0xd07) => "ARM Cortex-A57",
        (0x41, 0xd08) => "ARM Cortex-A72",
        (0x41, 0xd09) => "ARM Cortex-A73",
        (0x41, 0xd0a) => "ARM Cortex-A75",
        (0x41, 0xd0b) => "ARM Cortex-A76",
        (0x41, 0xd0c) => "ARM Neoverse-N1",
        (0x41, 0xd0d) => "ARM Cortex-A77",
        (0x41, 0xd40) => "ARM Neoverse-V1",
        (0x41, 0xd41) => "ARM Cortex-A78",
        (0x41, 0xd44) => "ARM Cortex-X1",
        (0x41, 0xd46) => "ARM Cortex-A510",
        (0x41, 0xd47) => "ARM Cortex-A710",
        (0x41, 0xd48) => "ARM Cortex-X2",
        (0x41, 0xd49) => "ARM Neoverse-N2",
        (0x41, 0xd4f) => "ARM Neoverse-V2",
        (0x41, 0xd80) => "ARM Cortex-A520",
        (0x41, 0xd81) => "ARM Cortex-A720",
        (0x41, 0xd82) => "ARM Cortex-X4",
        (0x41, 0xd84) => "ARM Neoverse-V3",
        (0x41, 0xd8e) => "ARM Neoverse-N3",
        (0x48, 0xd01) => "HiSilicon Kunpeng-920",
        (0xc0, 0xac3) => "Ampere-1",
        (0xc0, 0xac4) => "Ampere-1a",
        _ => return None,
    };
    Some(name.to_string())
}

/// 采样循环的句柄：丢弃即停止。
pub struct MonitorHandle {
    _stop: oneshot::Sender<()>,
    detail: tokio::sync::watch::Sender<MonitorDetail>,
}

impl MonitorHandle {
    /// 改采样时顺带多取哪些数据；和现在不一样时马上采一次，不等下一个周期
    pub fn set_detail(&self, detail: MonitorDetail) {
        self.detail
            .send_if_modified(|d| std::mem::replace(d, detail) != detail);
    }
}

/// 开始周期采样。每次先测延迟，再执行采样命令，解析后把快照送进返回的接收端；
/// 接收端被丢弃、或 [`MonitorHandle`] 被丢弃时循环结束。连接断开后采样命令会失败，
/// 之后的快照 `supported` 为 false，由调用方决定何时停。
/// `detail` 是一开始就顺带多取哪些数据，之后用 [`MonitorHandle::set_detail`] 改。
pub fn watch(
    conn: Arc<Connection>,
    interval: Duration,
    detail: MonitorDetail,
) -> (MonitorHandle, mpsc::UnboundedReceiver<MonitorSnapshot>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
    let (detail_tx, mut detail_rx) = tokio::sync::watch::channel(detail);
    crate::spawn(async move {
        let mut prev: Option<Sample> = None;
        loop {
            let detail = *detail_rx.borrow_and_update();
            let snap = sample(&conn, &mut prev, detail).await;
            if tx.send(snap).is_err() {
                break;
            }
            tokio::select! {
                _ = &mut stop_rx => break,
                _ = crate::sleep(interval) => {}
                // 开关变了马上采一次；句柄被丢弃时发送端也没了，一起停
                changed = detail_rx.changed() => {
                    if changed.is_err() {
                        break;
                    }
                }
            }
        }
    });
    (
        MonitorHandle {
            _stop: stop_tx,
            detail: detail_tx,
        },
        rx,
    )
}

async fn sample(conn: &Connection, prev: &mut Option<Sample>, detail: MonitorDetail) -> MonitorSnapshot {
    let latency = conn.ping().await.ok();
    let parsed = match conn.exec(&command(detail)).await {
        Ok(out) => parse(&out.stdout_lossy()),
        Err(e) => {
            log::debug!("监控采样失败: {e}");
            None
        }
    };
    match parsed {
        Some(cur) => {
            let snap = snapshot(prev.as_ref(), &cur, latency);
            *prev = Some(cur);
            snap
        }
        None => {
            *prev = None;
            MonitorSnapshot {
                latency_ms: latency,
                ..Default::default()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_A: &str = "\
==UPTIME==
100.00 380.12
==LOADAVG==
0.52 0.40 0.35 2/345 12345
==STAT==
cpu  1000 0 500 8000 100 0 50 0 0 0
==CORES==
4
==MEMINFO==
MemTotal:        8000000 kB
MemFree:         1000000 kB
MemAvailable:    5000000 kB
Buffers:          200000 kB
Cached:          3000000 kB
SwapTotal:       2000000 kB
SwapFree:        1500000 kB
==NETDEV==
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5000000   10000    0    0    0     0          0         0  5000000   10000    0    0    0     0       0          0
  eth0: 1000    100    0    0    0     0          0         0      500     50    0    0    0     0       0          0
==DF==
Filesystem     Type     1024-blocks     Used Available Capacity Mounted on
/dev/sda1      ext4        50000000 20000000  27000000      43% /
tmpfs          tmpfs        4000000        0   4000000       0% /dev/shm
/dev/loop3     squashfs       65536    65536         0     100% /snap/core/1
overlay        overlay     50000000 20000000  27000000      43% /var/lib/docker/overlay2/x/merged
/dev/sdb1      xfs        100000000 10000000  90000000      10% /data
/dev/sda1      ext4        50000000 20000000  27000000      43% /mnt/bind
server:/export nfs4       200000000 50000000 150000000      25% /mnt/nfs with space
==PAGESIZE==
4096
==PROCS==
1 300 200 3000 systemd
812 5000 1000 128000 mysqld
977 100 50 51200 nginx: worker
1203 10 5 2560 sshd
2 0 40 0 kthreadd
";

    const SAMPLE_B: &str = "\
==UPTIME==
102.00 385.00
==LOADAVG==
0.60 0.42 0.36 1/345 12350
==STAT==
cpu  1400 0 700 8600 100 0 50 0 0 0
==CORES==
4
==MEMINFO==
MemTotal:        8000000 kB
MemFree:         1000000 kB
MemAvailable:    5000000 kB
SwapTotal:       2000000 kB
SwapFree:        1500000 kB
==NETDEV==
  eth0: 3000    120    0    0    0     0          0         0     1500     60    0    0    0     0       0          0
    lo: 6000000   10000    0    0    0     0          0         0  6000000   10000    0    0    0     0       0          0
  wg0: 10    1    0    0    0     0          0         0     20     1    0    0    0     0       0          0
==DF==
Filesystem     1024-blocks     Used Available Capacity Mounted on
udev               4000000        0   4000000       0% /dev
/dev/vda1         50000000 20000000  27000000      43% /
tmpfs              4000000        0   4000000       0% /run
==PROCS==
";

    #[test]
    fn parses_static_fields() {
        let s = parse(SAMPLE_A).expect("应能解析");
        assert_eq!(s.uptime, 100.0);
        assert_eq!(s.load, [0.52, 0.40, 0.35]);
        assert_eq!(s.cpu, (9650, 8100));
        assert_eq!(s.cpu_times, [1000, 0, 500, 8000, 100, 0, 50, 0]);
        assert_eq!(s.cores, 4);
        assert_eq!(s.mem_total, 8_000_000 * 1024);
        assert_eq!(s.mem_used, 3_000_000 * 1024);
        assert_eq!(s.swap_total, 2_000_000 * 1024);
        assert_eq!(s.swap_used, 500_000 * 1024);
        assert_eq!(
            s.net,
            vec![("lo".to_string(), 5_000_000, 5_000_000), ("eth0".to_string(), 1000, 500)]
        );
        assert_eq!(s.procs.len(), 5);
        assert_eq!(
            s.procs[2],
            ProcSample { pid: 977, ticks: 150, mem_bytes: 51200 * 4096, name: "nginx: worker".into() }
        );
        // 没打开开关时这两段没有
        assert_eq!(s.proc_extra, None);
        assert_eq!(s.sockets, None);
    }

    #[test]
    fn df_keeps_real_filesystems_only() {
        let s = parse(SAMPLE_A).unwrap();
        let mounts: Vec<&str> = s.disks.iter().map(|d| d.mount.as_str()).collect();
        // tmpfs、squashfs(loop)、overlay 去掉；同一设备的 bind mount 只留第一个；挂载点含空格要完整
        assert_eq!(mounts, vec!["/", "/data", "/mnt/nfs with space"]);
        assert_eq!(
            s.disks[0],
            DiskInfo {
                mount: "/".into(),
                size: 50_000_000 * 1024,
                used: 20_000_000 * 1024,
                avail: 27_000_000 * 1024,
                device: "/dev/sda1".into(),
                fs_type: "ext4".into(),
            }
        );
        assert_eq!((s.disks[2].device.as_str(), s.disks[2].fs_type.as_str()), ("server:/export", "nfs4"));

        // 没有 Type 列时按名字过滤，类型为空字符串
        let s = parse(SAMPLE_B).unwrap();
        let mounts: Vec<&str> = s.disks.iter().map(|d| d.mount.as_str()).collect();
        assert_eq!(mounts, vec!["/"]);
        assert_eq!((s.disks[0].device.as_str(), s.disks[0].fs_type.as_str()), ("/dev/vda1", ""));
    }

    #[test]
    fn cpu_and_net_rates_come_from_deltas() {
        let a = parse(SAMPLE_A).unwrap();
        let b = parse(SAMPLE_B).unwrap();

        let first = snapshot(None, &a, Some(12.5));
        assert!(first.supported);
        assert_eq!(first.cpu_percent, 0.0);
        assert_eq!(first.cpu_detail, None);
        assert!(first.net.is_empty());
        assert_eq!(first.latency_ms, Some(12.5));

        let second = snapshot(Some(&a), &b, None);
        // Δtotal = 1200，Δidle = 600 → 50%
        assert!((second.cpu_percent - 50.0).abs() < 1e-9, "{}", second.cpu_percent);
        // 2 秒内收 2000 字节、发 1000 字节；lo 和刚出现的 wg0 不在 net 里
        assert_eq!(
            second.net,
            vec![NetRate { iface: "eth0".into(), rx_per_sec: 1000.0, tx_per_sec: 500.0 }]
        );
        assert_eq!(second.uptime_secs, 102.0);
        assert_eq!(second.latency_ms, None);
        assert!(second.procs.is_empty());
    }

    #[test]
    fn cpu_detail_splits_by_purpose() {
        let a = parse(SAMPLE_A).unwrap();
        let mut b = a.clone();
        // 两次之间：user 300 nice 10 system 100 idle 500 iowait 50 irq 10 softirq 20 steal 10，共 1000
        let delta = [300, 10, 100, 500, 50, 10, 20, 10];
        for (t, d) in b.cpu_times.iter_mut().zip(delta) {
            *t += d;
        }
        b.uptime += 2.0;
        let d = snapshot(Some(&a), &b, None).cpu_detail.expect("第二次采样应有细分");
        let got = [d.user, d.nice, d.system, d.idle, d.iowait, d.irq, d.softirq, d.steal];
        assert_eq!(got, [30.0, 1.0, 10.0, 50.0, 5.0, 1.0, 2.0, 1.0]);

        // 计数器没动（两次挨得太近）时算不出
        assert_eq!(snapshot(Some(&a), &a, None).cpu_detail, None);
        // 只有 4 项的老内核，后面几项记 0
        let s = parse("==UPTIME==\n1 1\n==LOADAVG==\n0 0 0 1/1 1\n==STAT==\ncpu 1 2 3 4\n==MEMINFO==\nMemTotal: 2 kB\nMemAvailable: 1 kB\n").unwrap();
        assert_eq!(s.cpu_times, [1, 2, 3, 4, 0, 0, 0, 0]);
    }

    #[test]
    fn ifaces_include_lo_and_new_ones_have_no_rate() {
        let a = parse(SAMPLE_A).unwrap();
        let b = parse(SAMPLE_B).unwrap();
        let first = snapshot(None, &a, None);
        assert_eq!(
            first.ifaces,
            vec![
                IfaceStat { iface: "lo".into(), rx_bytes: 5_000_000, tx_bytes: 5_000_000, rx_per_sec: None, tx_per_sec: None },
                IfaceStat { iface: "eth0".into(), rx_bytes: 1000, tx_bytes: 500, rx_per_sec: None, tx_per_sec: None },
            ]
        );
        let second = snapshot(Some(&a), &b, None);
        let by_name = |n: &str| second.ifaces.iter().find(|i| i.iface == n).unwrap().clone();
        assert_eq!(by_name("lo").rx_per_sec, Some(500_000.0));
        assert_eq!(by_name("eth0").tx_per_sec, Some(500.0));
        assert_eq!((by_name("wg0").rx_bytes, by_name("wg0").rx_per_sec), (10, None), "刚出现的网卡算不出速率");
    }

    /// 只留进程段，方便单独测进程列表
    fn with_procs(base: &str, cpu_total: u64, procs: &str) -> Sample {
        let mut s = parse(base).unwrap();
        s.cpu.0 = cpu_total;
        s.procs = parse_procs(&procs.lines().collect::<Vec<_>>(), 4096);
        s
    }

    #[test]
    fn proc_cpu_comes_from_deltas() {
        // 4 核，两次采样之间所有核一共走了 800 个滴答，也就是每个核 200 个
        let a = with_procs(SAMPLE_A, 10_000, "10 1000 0 100 java\n20 50 50 900 mysqld\n30 0 0 10 sleeper\n40 9000 0 5 reused");
        let b = with_procs(SAMPLE_A, 10_800, "10 1300 100 100 java\n20 110 50 900 mysqld\n30 0 0 10 sleeper\n40 10 0 5 reused\n50 999 0 1 newcomer");

        let first = snapshot(None, &a, None);
        assert!(first.procs.iter().all(|p| p.cpu_percent == 0.0), "第一次采样没有参照");

        let second = snapshot(Some(&a), &b, None);
        let cpu = |name: &str| second.procs.iter().find(|p| p.name == name).unwrap().cpu_percent;
        // java 用了 400 个滴答 = 两个核跑满，和 top 一样显示 200
        assert!((cpu("java") - 200.0).abs() < 1e-9);
        assert!((cpu("mysqld") - 30.0).abs() < 1e-9);
        assert_eq!(cpu("sleeper"), 0.0);
        // 进程号被重用、累计时间变小了，不能算成负数
        assert_eq!(cpu("reused"), 0.0);
        // 上次没有的新进程先记 0
        assert_eq!(cpu("newcomer"), 0.0);
        assert_eq!(second.procs[0].pid, 20, "默认按内存从高到低");
    }

    #[test]
    fn keeps_top_by_memory_and_top_by_cpu() {
        // 30 个进程：内存越往后越小，CPU 越往后越大
        let lines = |cpu_scale: u64| -> String {
            (1..=30u64)
                .map(|i| format!("{i} {} 0 {} p{i}", i * cpu_scale, 1000 - i))
                .collect::<Vec<_>>()
                .join("\n")
        };
        let a = with_procs(SAMPLE_A, 10_000, &lines(0));
        let b = with_procs(SAMPLE_A, 20_000, &lines(1));
        let snap = snapshot(Some(&a), &b, None);
        let pids: Vec<u32> = snap.procs.iter().map(|p| p.pid).collect();
        // 内存前 10 是 1..=10，CPU 前 10 是 21..=30，按内存排
        let expected: Vec<u32> = (1..=10).chain(21..=30).collect();
        assert_eq!(pids, expected);

        // CPU 都是 0 时两份前 10 重合，只给 10 个
        let snap = snapshot(None, &b, None);
        assert_eq!(snap.procs.len(), TOP_PROCS);
        // 没打开开关时没有全部进程
        assert_eq!(snap.all_procs, None);
    }

    #[test]
    fn procs_parse_rejects_garbage() {
        let lines = ["abc 1 2 3 x", "12 1 2 3", "", "7 1 2 notnum x", "8 1 2 3 a  b"];
        let procs = parse_procs(&lines, 4096);
        assert_eq!(procs.len(), 1);
        assert_eq!(procs[0].name, "a b");
        // 拿不到页大小时按 4K 算
        let text = "==UPTIME==\n1 1\n==LOADAVG==\n0 0 0 1/1 1\n==STAT==\ncpu 1 1 1 1\n==MEMINFO==\n\
MemTotal: 1000 kB\nMemAvailable: 500 kB\n==PROCS==\n9 1 1 2 init\n";
        assert_eq!(parse(text).unwrap().procs[0].mem_bytes, 2 * 4096);
    }

    /// 基础段加上进程、网络各段
    fn with_sections(base: &str, extra: &str) -> Sample {
        parse(&format!("{base}{extra}")).unwrap()
    }

    /// Ubuntu 24.04 的 procps：`ps -eww -o pid= -o user:32= -o args=`
    const PSARGS_PROCPS: &str = "\
==PSARGS==
      1 root                             /sbin/init splash
      2 root                             [kthreadd]
    812 mysql                            /usr/sbin/mysqld
    977 www-data                         nginx: worker process
   1203 root                             sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups
==EXE==
lrwxrwxrwx 1 root root 0 Oct 23 10:00 /proc/1/exe -> /usr/lib/systemd/systemd
lrwxrwxrwx 1 root root 0 Oct 23 10:00 /proc/2/exe
lrwxrwxrwx 1 mysql mysql 0 Oct 23 10:00 /proc/812/exe -> /usr/sbin/mysqld (deleted)
lrwxrwxrwx 1 www-data www-data 0 Oct 23 10:00 /proc/977/exe -> /usr/sbin/nginx
";

    #[test]
    fn all_procs_merge_user_cmdline_and_exe() {
        let a = parse(SAMPLE_A).unwrap();
        let b = with_sections(SAMPLE_A, PSARGS_PROCPS);
        let snap = snapshot(Some(&a), &b, None);
        let all = snap.all_procs.expect("打开了进程开关");
        assert_eq!(all.len(), 5);
        let p = |pid: u32| all.iter().find(|p| p.pid == pid).unwrap().clone();
        assert_eq!(
            p(1),
            ProcDetail {
                pid: 1,
                user: "root".into(),
                name: "systemd".into(),
                cmdline: "/sbin/init splash".into(),
                exe: "/usr/lib/systemd/systemd".into(),
                mem_bytes: 3000 * 4096,
                cpu_percent: 0.0,
            }
        );
        // 内核线程：ps 显示成 [kthreadd]，读不到程序位置，命令行留空
        assert_eq!((p(2).cmdline.as_str(), p(2).exe.as_str(), p(2).user.as_str()), ("", "", "root"));
        // 程序文件被删掉了（升级后没重启），原样显示
        assert_eq!(p(812).exe, "/usr/sbin/mysqld (deleted)");
        assert_eq!(p(977).cmdline, "nginx: worker process");
        // ls 没给这一行（看不到）就留空
        assert_eq!(p(1203).exe, "");
        assert_eq!(p(1203).cmdline, "sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups");
        // 状态栏用的前 10 不受影响
        assert_eq!(snap.procs, top_procs(proc_cpu(Some(&a), &b)));
    }

    #[test]
    fn busybox_ps_header_is_skipped() {
        let text = "\
==PSARGS==
PID   USER     COMMAND
    1 root     init
    2 root     [kthreadd]
  812 mysql    /usr/bin/mysqld --user=mysql
==EXE==
lrwxrwxrwx    1 root     root             0 Oct 23 10:00 /proc/1/exe -> /bin/busybox
";
        let b = with_sections(SAMPLE_A, text);
        let all = snapshot(None, &b, None).all_procs.unwrap();
        let p = |pid: u32| all.iter().find(|p| p.pid == pid).unwrap().clone();
        assert_eq!((p(1).user.as_str(), p(1).cmdline.as_str(), p(1).exe.as_str()), ("root", "init", "/bin/busybox"));
        assert_eq!(p(812).cmdline, "/usr/bin/mysqld --user=mysql");
        assert_eq!(p(2).cmdline, "");
        // ps 里没有的进程（977）各项留空，不出错
        assert_eq!((p(977).user.as_str(), p(977).cmdline.as_str()), ("", ""));
        assert_eq!(parse_ps_line("PID   USER     COMMAND"), None);
    }

    #[test]
    fn cmdline_is_cleaned_and_capped() {
        let long = "x".repeat(5000);
        let text = format!("==PSARGS==\n  977 www-data a\x07b\x1b[31mc {long}\n==EXE==\n");
        let b = with_sections(SAMPLE_A, &text);
        let all = snapshot(None, &b, None).all_procs.unwrap();
        let cmd = &all.iter().find(|p| p.pid == 977).unwrap().cmdline;
        assert!(cmd.starts_with("a b [31mc xxx"), "{cmd}");
        assert_eq!(cmd.chars().count(), MAX_CMDLINE);
        // 能读到程序位置的不当成内核线程，哪怕命令行像
        let text = "==PSARGS==\n    2 root [kthreadd]\n==EXE==\n\
lrwxrwxrwx 1 root root 0 Oct 23 10:00 /proc/2/exe -> /tmp/.x/miner\n";
        let all = snapshot(None, &with_sections(SAMPLE_A, text), None).all_procs.unwrap();
        assert_eq!(all.iter().find(|p| p.pid == 2).unwrap().cmdline, "[kthreadd]");
    }

    #[test]
    fn all_procs_capped() {
        let n = MAX_PROCS + 5;
        let procs: String = (1..=n).map(|i| format!("{i} 0 0 1 p{i}\n")).collect();
        let text = format!("{SAMPLE_B}{procs}==PSARGS==\n==EXE==\n");
        let all = snapshot(None, &parse(&text).unwrap(), None).all_procs.unwrap();
        assert_eq!(all.len(), MAX_PROCS);
    }

    /// Ubuntu 24.04 上 root 跑 `ss -Htulnp`。22 端口是 systemd 套接字激活，先列出的是 systemd
    const LISTEN_UBUNTU: &str = "\
==LISTEN==
udp   UNCONN 0      0                    127.0.0.54:53         0.0.0.0:*    users:((\"systemd-resolve\",pid=578,fd=16))
udp   UNCONN 0      0                 127.0.0.53%lo:53         0.0.0.0:*    users:((\"systemd-resolve\",pid=578,fd=14))
udp   UNCONN 0      0               10.0.0.5%eth0:68           0.0.0.0:*    users:((\"systemd-network\",pid=550,fd=23))
udp   UNCONN 0      0                     127.0.0.1:323        0.0.0.0:*    users:((\"chronyd\",pid=700,fd=5))
udp   UNCONN 0      0                         [::1]:323           [::]:*    users:((\"chronyd\",pid=700,fd=6))
tcp   LISTEN 0      4096              127.0.0.53%lo:53         0.0.0.0:*    users:((\"systemd-resolve\",pid=578,fd=15))
tcp   LISTEN 0      4096                    0.0.0.0:22         0.0.0.0:*    users:((\"systemd\",pid=1,fd=88),(\"sshd\",pid=1201,fd=3))
tcp   LISTEN 0      511                   127.0.0.1:6379       0.0.0.0:*    users:((\"redis-server\",pid=900,fd=6))
tcp   LISTEN 0      4096                       [::]:22            [::]:*    users:((\"systemd\",pid=1,fd=89),(\"sshd\",pid=1201,fd=4))
tcp   LISTEN 0      511                           *:80               *:*    users:((\"apache2\",pid=1300,fd=4),(\"apache2\",pid=1302,fd=4))
tcp   LISTEN 0      128                     0.0.0.0:8080       0.0.0.0:*
";

    /// `ss -Htunpi state established`：只选了一种状态，没有 State 列；TCP 连接下一行是 `-i` 的信息
    const CONNS_UBUNTU: &str = "\
==CONNS==
udp   0      0          10.0.0.5%eth0:68       10.0.0.1:67    users:((\"systemd-network\",pid=550,fd=23))
tcp   0      0               10.0.0.5:22     203.0.113.9:51234 users:((\"sshd\",pid=2345,fd=4),(\"sshd\",pid=2300,fd=4))
\t cubic wscale:7,7 rto:216 rtt:15.3/2.1 ato:40 mss:1448 pmtu:1500 rcvmss:1392 advmss:1448 cwnd:10 bytes_sent:52341 bytes_acked:52300 bytes_received:8812 segs_out:200 segs_in:180 data_segs_out:150 data_segs_in:90 send 7.57Mbps lastsnd:20 lastrcv:24 lastack:20 pacing_rate 15.1Mbps delivery_rate 3.2Mbps delivered:151 app_limited busy:2400ms rcv_space:14600 rcv_ssthresh:64076 minrtt:12.1 snd_wnd:501760
tcp   0      36              10.0.0.5:22     203.0.113.9:51300 users:((\"sshd\",pid=2400,fd=4))
\t cubic wscale:7,7 rto:204 rtt:1.2/0.6 mss:1448 cwnd:10 bytes_sent:1000 bytes_acked:964 bytes_received:2000 segs_out:20 segs_in:30
tcp   0      0     [2001:db8::5]:22      [2001:db8::9]:60000 users:((\"sshd\",pid=2500,fd=4))
\t cubic wscale:7,7 rto:204 rtt:0.3/0.1 mss:1428 cwnd:10 bytes_acked:100 bytes_received:50 segs_out:5 segs_in:6
tcp   0      0     [::ffff:10.0.0.5]:80   [::ffff:198.51.100.7]:40022 users:((\"apache2\",pid=1302,fd=10))
\t cubic wscale:7,7 rto:204 rtt:0.3/0.1 mss:1448 cwnd:10 bytes_acked:4096 bytes_received:300 segs_out:5 segs_in:6
tcp   0      0               127.0.0.1:6379      127.0.0.1:52000 users:((\"redis-server\",pid=900,fd=8))
\t cubic rto:204 rtt:0.03/0.01 mss:65483 cwnd:10 bytes_acked:10 bytes_received:20
tcp   0      0               127.0.0.1:52000     127.0.0.1:6379 users:((\"php-fpm8.3\",pid=1500,fd=9))
\t cubic rto:204 rtt:0.03/0.01 mss:65483 cwnd:10 bytes_acked:20 bytes_received:10
tcp   0      0               10.0.0.5:44120  140.82.112.3:443 users:((\"git-remote-http\",pid=3100,fd=5))
\t cubic wscale:7,7 rto:240 rtt:38/4 mss:1448 cwnd:10 bytes_sent:500 bytes_acked:500 bytes_received:90000
tcp   0      0               10.0.0.5:8080      192.0.2.1:3333
\t cubic rto:204 rtt:1/0.5 mss:1448 cwnd:10 bytes_acked:7 bytes_received:9
";

    fn row<'a>(t: &'a SocketTable, ip: Option<&str>, port: Option<u16>, name: &str) -> &'a SocketRow {
        t.rows
            .iter()
            .find(|r| r.listen_ip.as_deref() == ip && r.port == port && r.name == name)
            .unwrap_or_else(|| panic!("没有 {ip:?}:{port:?} {name}：{:#?}", t.rows))
    }

    #[test]
    fn ss_lines_parse() {
        let s = with_sections(SAMPLE_A, &format!("{LISTEN_UBUNTU}{CONNS_UBUNTU}")).sockets.unwrap();
        assert!(s.available);
        assert_eq!(s.listen.len(), 11);
        assert_eq!(s.conns.len(), 9);
        // 取第一个进程
        let ssh = &s.listen[6];
        assert_eq!((ssh.proto.as_str(), ssh.local.as_str(), ssh.pid, ssh.name.as_str()), ("tcp", "0.0.0.0:22", Some(1), "systemd"));
        // 不是 root 看不到进程
        assert_eq!((s.listen[10].pid, s.listen[10].name.as_str()), (None, ""));
        // 没有 State 列时也认得出；-i 的第二行归给上一条，bytes_acked 优先于 bytes_sent
        let c = &s.conns[1];
        assert_eq!(
            c,
            &SsEntry {
                proto: "tcp".into(),
                local: "10.0.0.5:22".into(),
                peer: "203.0.113.9:51234".into(),
                pid: Some(2345),
                name: "sshd".into(),
                tx_bytes: Some(52300),
                rx_bytes: Some(8812),
            }
        );
        // UDP 没有字节数
        assert_eq!((s.conns[0].proto.as_str(), s.conns[0].tx_bytes), ("udp", None));
        // 没有 bytes_acked 时用 bytes_sent
        let mut e = s.conns[0].clone();
        apply_tcp_info(&mut e, "\t cubic bytes_sent:77 bytes_received:5");
        assert_eq!((e.tx_bytes, e.rx_bytes), (Some(77), Some(5)));
        // 老版本 ss 的进程写法
        assert_eq!(parse_ss_users(r#"users:(("sshd",1234,3))"#), (Some(1234), "sshd".into()));
        assert_eq!(parse_ss_users(r#"users:(("tmux: server",pid=7,fd=3))"#), (Some(7), "tmux: server".into()));
    }

    #[test]
    fn addresses_normalize() {
        assert_eq!(split_addr("127.0.0.53%lo:53"), ("127.0.0.53".into(), Some(53)));
        assert_eq!(split_addr("[::]:22"), ("::".into(), Some(22)));
        assert_eq!(split_addr("[::1]:323"), ("::1".into(), Some(323)));
        assert_eq!(split_addr("[fe80::5054:ff:fe12:3456]%enp1s0:546"), ("fe80::5054:ff:fe12:3456".into(), Some(546)));
        assert_eq!(split_addr("[fe80::1%eth0]:546"), ("fe80::1".into(), Some(546)));
        assert_eq!(split_addr("[::ffff:10.0.0.5]:80"), ("10.0.0.5".into(), Some(80)));
        assert_eq!(split_addr("::FFFF:10.0.0.5:80"), ("10.0.0.5".into(), Some(80)));
        assert_eq!(split_addr("0.0.0.0:*"), ("0.0.0.0".into(), None));
        assert_eq!(split_addr("*:*"), ("*".into(), None));
        // CentOS 7 的老 ss 不加方括号
        assert_eq!(split_addr(":::22"), ("::".into(), Some(22)));
        assert_eq!(split_addr("::1:25"), ("::1".into(), Some(25)));
    }

    #[test]
    fn connections_go_to_listen_rows() {
        let b = with_sections(SAMPLE_A, &format!("{LISTEN_UBUNTU}{CONNS_UBUNTU}"));
        let t = snapshot(None, &b, None).sockets.unwrap();
        assert!(t.available);
        // 监听的是 systemd，连接属于 sshd，照样归到 22 端口；IPv4 的归 0.0.0.0，IPv6 的归 ::
        let v4 = row(&t, Some("0.0.0.0"), Some(22), "systemd");
        assert_eq!((v4.pid, v4.conns, v4.ips), (Some(1), 2, 1));
        let v6 = row(&t, Some("::"), Some(22), "systemd");
        assert_eq!((v6.conns, v6.ips), (1, 1));
        // ::ffff: 的连接归到 * 监听
        assert_eq!(row(&t, Some("*"), Some(80), "apache2").conns, 1);
        // 地址相同的才算；连 redis 的客户端那头（本地端口 52000）算“主动连出去”
        assert_eq!(row(&t, Some("127.0.0.1"), Some(6379), "redis-server").conns, 1);
        let php = row(&t, None, None, "php-fpm8.3");
        assert_eq!((php.pid, php.conns, php.ips), (Some(1500), 1, 1));
        assert_eq!(row(&t, None, None, "git-remote-http").conns, 1);
        // 看不到进程的连接照样按端口归
        assert_eq!(row(&t, Some("0.0.0.0"), Some(8080), "").conns, 1);
        // UDP 已连接的套接字本地端口 68 正好也在监听（同一进程），归过去
        assert_eq!(row(&t, Some("10.0.0.5"), Some(68), "systemd-network").conns, 1);
        // 同一进程同一地址同一端口 TCP、UDP 都在监听，合成一行
        let dns: Vec<&SocketRow> = t.rows.iter().filter(|r| r.port == Some(53)).collect();
        assert_eq!(dns.len(), 2, "{dns:#?}");
        assert_eq!(row(&t, Some("127.0.0.53"), Some(53), "systemd-resolve").conns, 0);
        // 没有连接的监听行也在；第一次采样速率为 0
        assert_eq!(row(&t, Some("::1"), Some(323), "chronyd").conns, 0);
        assert!(t.rows.iter().all(|r| r.tx_per_sec == 0.0 && r.rx_per_sec == 0.0));
        // 监听行在前、按端口排，主动连出去的在后
        let ports: Vec<Option<u16>> = t.rows.iter().map(|r| r.port).collect();
        let first_none = ports.iter().position(Option::is_none).unwrap();
        assert!(ports[first_none..].iter().all(Option::is_none));
        assert!(ports[..first_none].windows(2).all(|w| w[0] <= w[1]));
    }

    #[test]
    fn listener_prefers_exact_then_same_family() {
        assert_eq!(listener_score("10.0.0.5", "10.0.0.5"), Some(0));
        assert_eq!(listener_score("0.0.0.0", "10.0.0.5"), Some(1));
        assert_eq!(listener_score("::", "2001:db8::5"), Some(1));
        assert_eq!(listener_score("*", "10.0.0.5"), Some(2));
        assert_eq!(listener_score("::", "10.0.0.5"), Some(3));
        assert_eq!(listener_score("127.0.0.1", "10.0.0.5"), None);
        // 同一端口既有精确地址又有 0.0.0.0（SO_REUSEPORT）：精确的优先
        let text = "==LISTEN==\n\
tcp LISTEN 0 128 0.0.0.0:9000 0.0.0.0:* users:((\"a\",pid=1,fd=3))\n\
tcp LISTEN 0 128 10.0.0.5:9000 0.0.0.0:* users:((\"b\",pid=2,fd=3))\n\
==CONNS==\n\
tcp 0 0 10.0.0.5:9000 192.0.2.1:1 users:((\"a\",pid=1,fd=4))\n\
tcp 0 0 127.0.0.1:9000 127.0.0.1:2 users:((\"a\",pid=1,fd=5))\n";
        let t = snapshot(None, &with_sections(SAMPLE_A, text), None).sockets.unwrap();
        assert_eq!(row(&t, Some("10.0.0.5"), Some(9000), "b").conns, 1);
        assert_eq!(row(&t, Some("0.0.0.0"), Some(9000), "a").conns, 1);
    }

    #[test]
    fn connection_rates_from_two_samples() {
        let extra = |conns: &str| format!("==LISTEN==\ntcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:((\"sshd\",pid=1,fd=3))\n==CONNS==\n{conns}");
        let conn = |port: u16, acked: u64, received: u64| {
            format!("tcp 0 0 10.0.0.5:22 203.0.113.9:{port} users:((\"sshd\",pid=9,fd=4))\n\t cubic bytes_acked:{acked} bytes_received:{received}\n")
        };
        // SAMPLE_A 的 uptime 100，SAMPLE_B 102：间隔 2 秒
        let a = with_sections(SAMPLE_A, &extra(&conn(1000, 1000, 500)));
        let b = with_sections(SAMPLE_B, &extra(&format!("{}{}", conn(1000, 5000, 2500), conn(2000, 600, 400))));
        let t = snapshot(Some(&a), &b, None).sockets.unwrap();
        let r = row(&t, Some("0.0.0.0"), Some(22), "sshd");
        // 老连接 2 秒发 4000、收 2000；新连接整条的累计量（600 / 400）都算进这 2 秒
        assert_eq!((r.conns, r.ips), (2, 1));
        assert_eq!(r.tx_per_sec, (4000.0 + 600.0) / 2.0);
        assert_eq!(r.rx_per_sec, (2000.0 + 400.0) / 2.0);

        // 上一次没取连接（刚打开网络页）：速率记 0
        let plain = parse(SAMPLE_A).unwrap();
        let t = snapshot(Some(&plain), &b, None).sockets.unwrap();
        assert_eq!(row(&t, Some("0.0.0.0"), Some(22), "sshd").tx_per_sec, 0.0);
        // 累计量变小（同一对地址和端口换了一条新连接）不算负数
        let mut later = a.clone();
        later.uptime = 200.0;
        let t = snapshot(Some(&b), &later, None).sockets.unwrap();
        assert_eq!(row(&t, Some("0.0.0.0"), Some(22), "sshd").tx_per_sec, 0.0);
    }

    #[test]
    fn old_ss_header_and_missing_ss() {
        // CentOS 7 的 ss 不认 -H，退回带表头的写法；IPv6 没有方括号
        let text = "==LISTEN==\n\
Netid  State      Recv-Q Send-Q Local Address:Port               Peer Address:Port\n\
tcp    LISTEN     0      128         *:22                       *:*                   users:((\"sshd\",pid=1100,fd=3))\n\
tcp    LISTEN     0      128        :::22                      :::*                   users:((\"sshd\",pid=1100,fd=4))\n\
==CONNS==\n\
Netid Recv-Q Send-Q Local Address:Port               Peer Address:Port\n\
tcp   0      0      10.0.0.5:22                 203.0.113.9:51234               users:((\"sshd\",pid=2000,fd=3))\n\
\t cubic wscale:7,7 rto:204 rtt:1/0.5 mss:1448 cwnd:10 bytes_acked:10 bytes_received:20\n";
        let s = with_sections(SAMPLE_A, text).sockets.unwrap();
        assert_eq!((s.listen.len(), s.conns.len()), (2, 1));
        let t = snapshot(None, &with_sections(SAMPLE_A, text), None).sockets.unwrap();
        assert_eq!(row(&t, Some("*"), Some(22), "sshd").conns, 1);
        assert_eq!(row(&t, Some("::"), Some(22), "sshd").conns, 0);

        // 没有 ss
        let t = snapshot(None, &with_sections(SAMPLE_A, "==LISTEN==\nNOSS\n==CONNS==\n"), None).sockets.unwrap();
        assert_eq!(t, SocketTable { available: false, rows: vec![] });
        // 有 ss 但什么都没在监听
        let t = snapshot(None, &with_sections(SAMPLE_A, "==LISTEN==\n==CONNS==\n"), None).sockets.unwrap();
        assert_eq!(t, SocketTable { available: true, rows: vec![] });
    }

    #[test]
    fn ss_info_line_only_follows_its_connection() {
        // 表头后面跟着一行缩进的信息，不能挂到前面的连接上
        let lines = [
            "tcp 0 0 10.0.0.5:22 203.0.113.9:1 users:((\"sshd\",pid=9,fd=4))",
            "garbage header",
            "\t cubic bytes_acked:99 bytes_received:99",
        ];
        let s = parse_sockets(&[], &lines);
        assert_eq!(s.conns[0].tx_bytes, None);
    }

    #[test]
    fn connections_capped() {
        let n = MAX_CONNS + 10;
        let mut text = String::from("==LISTEN==\n==CONNS==\n");
        for i in 0..n {
            text.push_str(&format!("tcp 0 0 10.0.0.5:{} 203.0.113.9:443\n\t bytes_acked:1 bytes_received:1\n", 1024 + i % 60000));
        }
        let s = with_sections(SAMPLE_A, &text).sockets.unwrap();
        assert_eq!(s.conns.len(), MAX_CONNS);
        assert!(s.conns.iter().all(|c| c.tx_bytes == Some(1)), "最后一条的第二行也要读到");
    }

    #[test]
    fn command_is_safe_inside_double_quotes() {
        // 外层双引号里的内容交给用户的登录 shell，这几个字符在 bash / zsh / fish / csh 里含义各不相同
        let check = |cmd: &str| {
            let inner = cmd
                .strip_prefix(COMMAND_HEAD)
                .and_then(|s| s.strip_suffix('"'))
                .unwrap_or_else(|| panic!("命令格式不对：{cmd}"));
            for bad in ['$', '`', '\\', '"', '!'] {
                assert!(!inner.contains(bad), "采样命令里不能有 {bad}：{inner}");
            }
        };
        for procs in [false, true] {
            for sockets in [false, true] {
                let cmd = command(MonitorDetail { procs, sockets });
                check(&cmd);
                assert_eq!(cmd.contains("==PSARGS=="), procs);
                assert_eq!(cmd.contains("==EXE=="), procs);
                assert_eq!(cmd.contains("==LISTEN=="), sockets);
                assert_eq!(cmd.contains("==CONNS=="), sockets);
            }
        }
        check(SYSTEM_INFO_COMMAND);
    }

    #[test]
    fn detail_deserializes_from_ui_shape() {
        let d: MonitorDetail = serde_json::from_str(r#"{"procs":true,"sockets":false}"#).unwrap();
        assert_eq!(d, MonitorDetail { procs: true, sockets: false });
    }

    /// 把采样命令里读 /proc 的地方换成假文件，在本机的 sh 和 awk 上真跑一遍
    #[cfg(unix)]
    #[test]
    fn procs_awk_extracts_fields() {
        let dir = std::env::temp_dir().join(format!("evershell-procs-{}", std::process::id()));
        let stats = [
            ("1", "1 (systemd) S 0 1 1 0 -1 4194560 46525 2370516 113 1287 297 263 4527 2104 20 0 1 0 2 172544000 3170 18446744073709551615 1 1 0 0 0 0 671173123 4096 1260 0 0 0 17 0 0 0 0 0 0 0 0 0 0 0 0 0 0"),
            ("333", "333 (tmux: server) S 1 333 333 0 -1 4194368 1000 0 0 0 9000000000 123 0 0 20 0 1 0 500 10000000 2500 18446744073709551615 1 1 0 0 0 0 0 4096 1260 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0"),
            ("4444", "4444 (a) b) R 1 333 333 0 -1 4194368 1000 0 0 0 7 8 0 0 20 0 1 0 500 10000000 12 18446744073709551615 1 1 0 0 0 0 0 4096 1260 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0"),
            ("55", "55 (short) S 1 2 3"),
        ];
        for (pid, line) in stats {
            std::fs::create_dir_all(dir.join(pid)).unwrap();
            std::fs::write(dir.join(pid).join("stat"), format!("{line}\n")).unwrap();
        }
        let cmd = command(MonitorDetail::default())
            .replace("/proc/[0-9]*/stat", &format!("{}/[0-9]*/stat", dir.display()));
        let out = std::process::Command::new("sh").arg("-c").arg(&cmd).output().unwrap();
        std::fs::remove_dir_all(&dir).ok();
        let stdout = String::from_utf8_lossy(&out.stdout);
        let procs_section: Vec<&str> = stdout.split("==PROCS==\n").nth(1).unwrap().lines().collect();
        let mut procs = parse_procs(&procs_section, 4096);
        procs.sort_by_key(|p| p.pid);
        assert_eq!(
            procs,
            vec![
                ProcSample { pid: 1, ticks: 297 + 263, mem_bytes: 3170 * 4096, name: "systemd".into() },
                ProcSample { pid: 333, ticks: 9_000_000_123, mem_bytes: 2500 * 4096, name: "tmux: server".into() },
                ProcSample { pid: 4444, ticks: 15, mem_bytes: 12 * 4096, name: "a) b".into() },
            ]
        );
    }

    /// 打开全部开关，把 /proc 换成一个假目录，整条命令在本机 sh 上真跑一遍。
    /// 本机（macOS）没有 ss，网络段应是“没有 ss”；ps 是本机的，只要求能解析、不出错
    #[cfg(unix)]
    #[test]
    fn full_command_runs_on_local_sh() {
        let root = std::env::temp_dir().join(format!("evershell-full-{}", std::process::id()));
        let proc_dir = root.join("proc");
        let write = |rel: &str, text: &str| {
            let path = proc_dir.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        };
        write("uptime", "100.00 380.12\n");
        write("loadavg", "0.52 0.40 0.35 2/345 12345\n");
        write("stat", "cpu  1000 0 500 8000 100 0 50 0 0 0\ncpu0 1 1 1 1\n");
        write("cpuinfo", "processor\t: 0\nprocessor\t: 1\n");
        write("meminfo", "MemTotal: 8000000 kB\nMemAvailable: 5000000 kB\n");
        write("net/dev", "  eth0: 1000 100 0 0 0 0 0 0 500 50 0 0 0 0 0 0\n");
        write("4242/stat", "4242 (fake) S 1 1 1 0 -1 0 0 0 0 0 7 8 0 0 20 0 1 0 500 10000000 12 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n");
        std::os::unix::fs::symlink("/usr/lib/fake/bin", proc_dir.join("4242/exe")).unwrap();

        let cmd = command(MonitorDetail { procs: true, sockets: true })
            .replace("/proc/", &format!("{}/", proc_dir.display()));
        let out = std::process::Command::new("sh").arg("-c").arg(&cmd).output().unwrap();
        std::fs::remove_dir_all(&root).ok();
        let stdout = String::from_utf8_lossy(&out.stdout);

        let s = parse(&stdout).unwrap_or_else(|| panic!("应能解析：{stdout}"));
        assert_eq!(s.uptime, 100.0);
        assert_eq!(s.net, vec![("eth0".to_string(), 1000, 500)]);
        assert_eq!(s.procs.len(), 1);
        let extra = s.proc_extra.as_ref().expect("打开了进程开关");
        assert_eq!(extra.get(&4242).map(|e| e.exe.as_str()), Some("/usr/lib/fake/bin"));
        let snap = snapshot(None, &s, None);
        assert_eq!(snap.all_procs.as_ref().map(Vec::len), Some(1));
        let sockets = snap.sockets.expect("打开了网络开关");
        if cfg!(target_os = "macos") {
            assert!(!sockets.available, "macOS 没有 ss");
        }
    }

    #[test]
    fn meminfo_without_memavailable_falls_back() {
        let text = "==UPTIME==\n1 1\n==LOADAVG==\n0 0 0 1/1 1\n==STAT==\ncpu 1 1 1 1\n==MEMINFO==\n\
MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 200 kB\nCached: 300 kB\n";
        let s = parse(text).unwrap();
        assert_eq!(s.mem_used, 400 * 1024);
        assert_eq!(s.swap_total, 0);
        assert_eq!(s.cores, 0);
    }

    #[test]
    fn huge_numbers_do_not_panic() {
        let max = u64::MAX;
        let text = format!(
            "==UPTIME==\n1 1\n==LOADAVG==\n0 0 0 1/1 1\n==STAT==\ncpu {max} {max} {max} {max} {max}\n==MEMINFO==\n\
MemTotal: {max} kB\nMemFree: {max} kB\nBuffers: {max} kB\n==DF==\nFilesystem 1024-blocks Used Available Capacity Mounted on\n\
/dev/sda1 {max} {max} {max} 1% /\n"
        );
        let s = parse(&text).unwrap();
        assert_eq!(s.cpu, (max, max));
        assert_eq!(s.disks[0].size, max);
    }

    #[test]
    fn non_linux_output_is_unsupported() {
        // macOS 没有 /proc：各段都是空的（错误进了 stderr）
        let text = "==UPTIME==\n==LOADAVG==\n==STAT==\n==CORES==\n8\n==MEMINFO==\n==NETDEV==\n==DF==\n\
Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3s1 1000 500 500 50% /\n==PAGESIZE==\n4096\n==PROCS==\n";
        assert!(parse(text).is_none());
        assert!(parse("").is_none());
        assert!(parse("bash: /proc/uptime: No such file\n").is_none());
    }

    #[test]
    fn ignores_text_before_first_marker_and_crlf() {
        let text = format!("motd from .bashrc\r\n{}", SAMPLE_A.replace('\n', "\r\n"));
        let s = parse(&text).unwrap();
        assert_eq!(s.cores, 4);
        assert_eq!(s.disks.len(), 3);
    }

    #[test]
    fn snapshot_serializes_camel_case() {
        let a = parse(SAMPLE_A).unwrap();
        let json = serde_json::to_value(snapshot(None, &a, None)).unwrap();
        assert_eq!(json["cpuCores"], 4);
        assert_eq!(json["memTotal"], 8_000_000u64 * 1024);
        assert_eq!(json["latencyMs"], serde_json::Value::Null);
        assert_eq!(json["cpuDetail"], serde_json::Value::Null);
        assert_eq!(json["allProcs"], serde_json::Value::Null);
        assert_eq!(json["sockets"], serde_json::Value::Null);
        assert_eq!(json["procs"][0]["memBytes"], 128000u64 * 4096);
        assert_eq!(json["procs"][0]["pid"], 812);
        assert_eq!(json["disks"][0]["mount"], "/");
        assert_eq!(json["disks"][0]["fsType"], "ext4");
        assert_eq!(json["disks"][0]["used"], 20_000_000u64 * 1024);
        assert_eq!(json["disks"][0]["device"], "/dev/sda1");
        assert_eq!(json["ifaces"][0]["rxBytes"], 5_000_000u64);
        assert_eq!(json["ifaces"][0]["rxPerSec"], serde_json::Value::Null);

        let b = with_sections(SAMPLE_B, &format!("{PSARGS_PROCPS}{LISTEN_UBUNTU}{CONNS_UBUNTU}"));
        let json = serde_json::to_value(snapshot(Some(&a), &b, None)).unwrap();
        assert!(json["cpuDetail"]["softirq"].is_number());
        assert!(json["cpuDetail"]["steal"].is_number());
        assert!(json["allProcs"].is_array());
        assert_eq!(json["sockets"]["available"], true);
        let rows = json["sockets"]["rows"].as_array().unwrap();
        let out = rows.iter().find(|r| r["name"] == "php-fpm8.3").unwrap();
        assert_eq!(out["listenIp"], serde_json::Value::Null);
        assert_eq!(out["port"], serde_json::Value::Null);
        assert_eq!(out["pid"], 1500);
        for key in ["ips", "conns", "txPerSec", "rxPerSec"] {
            assert!(out[key].is_number(), "{key}");
        }
        let unknown = rows.iter().find(|r| r["port"] == 8080).unwrap();
        assert_eq!(unknown["pid"], serde_json::Value::Null);
        assert_eq!(unknown["listenIp"], "0.0.0.0");
    }

    const CPUINFO_X86: &str = "\
processor\t: 0
vendor_id\t: GenuineIntel
cpu family\t: 6
model\t\t: 79
model name\t: Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz
stepping\t: 1
cpu MHz\t\t: 2400.000
cache size\t: 35840 KB
physical id\t: 0
siblings\t: 2
core id\t\t: 0
cpu cores\t: 1
flags\t\t: fpu vme de pse
bogomips\t: 4800.00
clflush size\t: 64

processor\t: 1
vendor_id\t: GenuineIntel
model name\t: Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz
cpu MHz\t\t: 2600.000
cache size\t: 35840 KB
physical id\t: 0
cpu cores\t: 1
bogomips\t: 4800.00

processor\t: 2
model name\t: Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz
cpu MHz\t\t: 2500.000
cache size\t: 35840 KB
physical id\t: 1
cpu cores\t: 1
bogomips\t: 4800.00

processor\t: 3
model name\t: Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz
cpu MHz\t\t: 2500.000
cache size\t: 35840 KB
physical id\t: 1
cpu cores\t: 1
bogomips\t: 4800.00
";

    /// 64 位 ARM（Ampere Altra / Graviton2 一类）：没有 model name，也没有 physical id、cpu MHz
    const CPUINFO_ARM64: &str = "\
processor\t: 0
BogoMIPS\t: 50.00
Features\t: fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid asimdrdm lrcpc dcpop asimddp ssbs
CPU implementer\t: 0x41
CPU architecture: 8
CPU variant\t: 0x3
CPU part\t: 0xd0c
CPU revision\t: 1

processor\t: 1
BogoMIPS\t: 50.00
Features\t: fp asimd evtstrm aes pmull sha1 sha2 crc32 atomics fphp asimdhp cpuid asimdrdm lrcpc dcpop asimddp ssbs
CPU implementer\t: 0x41
CPU architecture: 8
CPU variant\t: 0x3
CPU part\t: 0xd0c
CPU revision\t: 1

";

    /// 树莓派 32 位系统：有 model name，末尾一段全机共用的 Hardware / Model
    const CPUINFO_RPI: &str = "\
processor\t: 0
model name\t: ARMv7 Processor rev 3 (v7l)
BogoMIPS\t: 108.00
Features\t: half thumb fastmult vfp edsp neon vfpv3 tls vfpv4 idiva idivt vfpd32 lpae evtstrm crc32
CPU implementer\t: 0x41
CPU part\t: 0xd08

processor\t: 1
model name\t: ARMv7 Processor rev 3 (v7l)
BogoMIPS\t: 108.00
CPU implementer\t: 0x41
CPU part\t: 0xd08

Hardware\t: BCM2711
Revision\t: c03114
Serial\t\t: 100000000000000a
Model\t\t: Raspberry Pi 4 Model B Rev 1.4
";

    #[test]
    fn cpuinfo_x86_groups_by_model() {
        let groups = parse_cpuinfo(&CPUINFO_X86.lines().collect::<Vec<_>>());
        assert_eq!(
            groups,
            vec![CpuGroup {
                model: "Intel(R) Xeon(R) CPU E5-2680 v4 @ 2.40GHz".into(),
                sockets: Some(2),
                cores_per_socket: Some(1),
                threads: 4,
                mhz: Some(2500.0),
                cache: Some("35840 KB".into()),
                bogomips: Some(4800.0),
            }]
        );
    }

    #[test]
    fn cpuinfo_arm_without_model_name() {
        let groups = parse_cpuinfo(&CPUINFO_ARM64.lines().collect::<Vec<_>>());
        assert_eq!(
            groups,
            vec![CpuGroup {
                model: "ARM Neoverse-N1".into(),
                sockets: None,
                cores_per_socket: None,
                threads: 2,
                mhz: None,
                cache: None,
                bogomips: Some(50.0),
            }]
        );
        // 有 model name 时用它，末尾的 Hardware 段不算一个 CPU
        let groups = parse_cpuinfo(&CPUINFO_RPI.lines().collect::<Vec<_>>());
        assert_eq!(groups.len(), 1);
        assert_eq!((groups[0].model.as_str(), groups[0].threads), ("ARMv7 Processor rev 3 (v7l)", 2));
        // 查不到核心名时退回 Hardware，再没有就是空字符串
        let unknown = "processor : 0\nCPU implementer : 0x99\nCPU part : 0x001\n\nHardware : Some SoC\n";
        assert_eq!(parse_cpuinfo(&unknown.lines().collect::<Vec<_>>())[0].model, "Some SoC");
        let bare = "processor : 0\nprocessor : 1\n";
        let groups = parse_cpuinfo(&bare.lines().collect::<Vec<_>>());
        assert_eq!(groups, vec![CpuGroup { model: String::new(), sockets: None, cores_per_socket: None, threads: 2, mhz: None, cache: None, bogomips: None }]);
        // big.LITTLE：两种核心分两组
        let mixed = "processor : 0\nCPU implementer : 0x41\nCPU part : 0xd05\n\nprocessor : 1\nCPU implementer : 0x41\nCPU part : 0xd0b\n";
        let models: Vec<String> = parse_cpuinfo(&mixed.lines().collect::<Vec<_>>()).into_iter().map(|g| g.model).collect();
        assert_eq!(models, vec!["ARM Cortex-A55", "ARM Cortex-A76"]);
    }

    #[test]
    fn system_info_parses_all_sections() {
        let text = format!(
            "==OSRELEASE==\n\
PRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\nNAME=\"Ubuntu\"\nVERSION_ID=\"24.04\"\nVERSION=\"24.04.1 LTS (Noble Numbat)\"\nID=ubuntu\n\
==KERNEL==\nLinux\n==RELEASE==\n6.8.0-110-generic\n==ARCH==\nx86_64\n==HOSTNAME==\nweb-01\n==CPUINFO==\n{CPUINFO_X86}"
        );
        let info = parse_system_info(&text);
        assert_eq!(info.os, "Ubuntu 24.04.1 LTS");
        assert_eq!(info.kernel, "Linux");
        assert_eq!(info.kernel_release, "6.8.0-110-generic");
        assert_eq!(info.arch, "x86_64");
        assert_eq!(info.hostname, "web-01");
        assert_eq!(info.cpus.len(), 1);
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["kernelRelease"], "6.8.0-110-generic");
        assert_eq!(json["cpus"][0]["coresPerSocket"], 1);
        assert_eq!(json["cpus"][0]["sockets"], 2);

        // 没有 PRETTY_NAME 时拼 NAME VERSION；单引号、转义
        assert_eq!(parse_os_release(&["NAME='Alpine Linux'", "VERSION=3.20"]), "Alpine Linux 3.20");
        assert_eq!(parse_os_release(&[r#"PRETTY_NAME="Say \"hi\"""#]), "Say \"hi\"");
        // macOS：没有 os-release、/proc/cpuinfo，只有 uname
        let info = parse_system_info("==OSRELEASE==\n==KERNEL==\nDarwin\n==RELEASE==\n25.0.0\n==ARCH==\narm64\n==HOSTNAME==\nmac\n==CPUINFO==\n");
        assert_eq!((info.os.as_str(), info.kernel.as_str(), info.cpus.len()), ("", "Darwin", 0));
        assert_eq!(parse_system_info(""), SystemInfo::default());
    }

    /// 系统信息命令在本机 sh 上真跑一遍
    #[cfg(unix)]
    #[test]
    fn system_info_command_runs_on_local_sh() {
        let out = std::process::Command::new("sh").arg("-c").arg(SYSTEM_INFO_COMMAND).output().unwrap();
        let info = parse_system_info(&String::from_utf8_lossy(&out.stdout));
        assert!(!info.kernel.is_empty() && !info.arch.is_empty() && !info.hostname.is_empty(), "{info:?}");
        if cfg!(target_os = "macos") {
            assert_eq!(info.kernel, "Darwin");
        }
    }
}
