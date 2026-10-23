//! 服务器监控：不装 agent，每次采样只在服务器上执行一条命令，把 /proc 的几段文本一次性取回来，
//! 在本地解析。CPU 使用率和网速要靠相邻两次采样的差值算出来。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::{mpsc, oneshot};

use crate::Connection;

/// 一次采样命令：各段用 `==NAME==` 分隔。
/// 用 `env LC_ALL=C sh -c` 包一层，不依赖用户的登录 shell 是不是 POSIX 的；
/// 字符串里不含 `$`、反引号、反斜杠和双引号，所以放在双引号里对 bash / zsh / fish / csh 都一样。
/// `df -kPT` 能给文件系统类型（GNU、busybox 都支持），不支持时退回 `df -kP`。
///
/// 进程不用 `ps`：它给的 CPU 是进程从启动到现在的平均值，几乎不动；BusyBox 的 `ps` 也不支持要用的字段。
/// 改成读每个进程的 `/proc/<pid>/stat`，用 awk 只挑出 `pid utime stime rss comm` 五项
/// （第 1、14、15、24、2 项），整行五十多项原样传回来每次要多几十 KB。comm 在括号里，
/// 可能含空格和右括号，所以用最后一个右括号定位。awk 不能写 `$0` 和字符串常量，
/// 所以用 getline 读进变量、用正则找括号；只截取不做加法，老版 mawk 会把超过 2^31 的数打成科学计数法。
const COMMAND: &str = "env LC_ALL=C sh -c \"\
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
print substr(l,1,o-2),f[12],f[13],f[22],substr(l,o+1,c-o-1)}}'\"";

/// 进程列表给界面多少个。实际传内存前这么多个、CPU 前这么多个的并集，界面按哪列排都能拿到真正的前几名。
pub const TOP_PROCS: usize = 10;

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
    pub cpu_cores: u32,
    pub mem_total: u64,
    pub mem_used: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    /// 各网卡（不含 lo）的速率；第一次采样还算不出速率，为空
    pub net: Vec<NetRate>,
    /// 内存前 [`TOP_PROCS`] 和 CPU 前 [`TOP_PROCS`] 的并集，按内存从高到低
    pub procs: Vec<ProcInfo>,
    /// 真实文件系统的挂载点（不含 tmpfs、overlay 等）
    pub disks: Vec<DiskInfo>,
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

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcInfo {
    pub pid: u32,
    pub name: String,
    pub mem_bytes: u64,
    /// 两次采样之间的占用，和 top 一样 100 表示占满一个核，多线程的进程可以超过 100；第一次采样为 0
    pub cpu_percent: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub mount: String,
    pub size: u64,
    pub avail: u64,
}

/// 一次采样解析出来的原始数据，含算差值需要的累计计数器。
#[derive(Debug, Clone, PartialEq)]
pub struct Sample {
    pub uptime: f64,
    pub load: [f64; 3],
    /// /proc/stat 第一行的 (总 jiffies, 空闲 jiffies)
    pub cpu: (u64, u64),
    pub cores: u32,
    pub mem_total: u64,
    pub mem_used: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    /// (网卡, 累计收字节, 累计发字节)
    pub net: Vec<(String, u64, u64)>,
    /// 全部进程
    pub procs: Vec<ProcSample>,
    pub disks: Vec<DiskInfo>,
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

/// 解析采样命令的输出。缺少核心段（uptime / loadavg / stat / meminfo）时返回 None。
pub fn parse(output: &str) -> Option<Sample> {
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
    let section = |name: &str| -> &[&str] {
        sections
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, l)| l.as_slice())
            .unwrap_or(&[])
    };

    let uptime = parse_uptime(section("UPTIME"))?;
    let load = parse_loadavg(section("LOADAVG"))?;
    let cpu = parse_stat(section("STAT"))?;
    let (mem_total, mem_used, swap_total, swap_used) = parse_meminfo(section("MEMINFO"))?;
    let cores = parse_cores(section("CORES")).unwrap_or(0);
    // 取不到页大小时按最常见的 4K 算
    let page_size = section("PAGESIZE")
        .iter()
        .find_map(|l| l.trim().parse::<u64>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(4096);

    Some(Sample {
        uptime,
        load,
        cpu,
        cores,
        mem_total,
        mem_used,
        swap_total,
        swap_used,
        net: parse_netdev(section("NETDEV")),
        procs: parse_procs(section("PROCS"), page_size),
        disks: parse_df(section("DF")),
    })
}

/// 把当前采样和上一次采样合成一份快照。`prev` 为 None 时 CPU 为 0、网速为空。
pub fn snapshot(prev: Option<&Sample>, cur: &Sample, latency_ms: Option<f64>) -> MonitorSnapshot {
    let mut cpu_percent = 0.0;
    let mut net = Vec::new();
    if let Some(prev) = prev {
        let (total, idle) = (
            cur.cpu.0.saturating_sub(prev.cpu.0),
            cur.cpu.1.saturating_sub(prev.cpu.1),
        );
        if total > 0 {
            cpu_percent = (100.0 * (1.0 - idle as f64 / total as f64)).clamp(0.0, 100.0);
        }
        // 时间基准用服务器自己的 uptime 差，不受本地到服务器的网络抖动影响
        let dt = cur.uptime - prev.uptime;
        if dt > 0.0 {
            for (iface, rx, tx) in &cur.net {
                if let Some((_, prx, ptx)) = prev.net.iter().find(|(n, _, _)| n == iface) {
                    net.push(NetRate {
                        iface: iface.clone(),
                        rx_per_sec: rx.saturating_sub(*prx) as f64 / dt,
                        tx_per_sec: tx.saturating_sub(*ptx) as f64 / dt,
                    });
                }
            }
        }
    }
    MonitorSnapshot {
        supported: true,
        uptime_secs: cur.uptime,
        load: cur.load,
        cpu_percent,
        cpu_cores: cur.cores,
        mem_total: cur.mem_total,
        mem_used: cur.mem_used,
        swap_total: cur.swap_total,
        swap_used: cur.swap_used,
        net,
        procs: top_procs(prev, cur),
        disks: cur.disks.clone(),
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
/// 总量取前 8 项（guest 已含在 user / nice 里），空闲 = idle + iowait
fn parse_stat(lines: &[&str]) -> Option<(u64, u64)> {
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
    let total = nums.iter().sum();
    let idle = nums[3] + nums.get(4).copied().unwrap_or(0);
    Some((total, idle))
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
            v.split_whitespace().next()?.parse::<u64>().ok().map(|kb| kb * 1024)
        })
    };
    let total = get("MemTotal")?;
    // MemAvailable（3.14+）才是"还能用多少"；老内核退回 free + buffers + cached
    let available = get("MemAvailable").or_else(|| {
        Some(get("MemFree")? + get("Buffers").unwrap_or(0) + get("Cached").unwrap_or(0))
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

/// /proc/net/dev：`iface: rx_bytes ... (共 8 项) tx_bytes ...`，跳过 lo
fn parse_netdev(lines: &[&str]) -> Vec<(String, u64, u64)> {
    lines
        .iter()
        .filter_map(|l| {
            let (iface, rest) = l.split_once(':')?;
            let iface = iface.trim();
            if iface == "lo" {
                return None;
            }
            let nums: Vec<u64> = rest
                .split_whitespace()
                .filter_map(|s| s.parse().ok())
                .collect();
            Some((iface.to_string(), *nums.first()?, *nums.get(8)?))
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

/// 用两次采样的 CPU 时间差算每个进程的占用，再挑出内存前 [`TOP_PROCS`] 和 CPU 前 [`TOP_PROCS`]，按内存从高到低排。
fn top_procs(prev: Option<&Sample>, cur: &Sample) -> Vec<ProcInfo> {
    let cores = cur.cores.max(1) as f64;
    // 这段时间里一个核走过的滴答数；/proc/stat 第一行是所有核加起来的
    let per_core = prev.map_or(0.0, |p| cur.cpu.0.saturating_sub(p.cpu.0) as f64 / cores);
    let before: HashMap<u32, u64> = prev
        .map(|p| p.procs.iter().map(|q| (q.pid, q.ticks)).collect())
        .unwrap_or_default();
    let mut all: Vec<ProcInfo> = cur
        .procs
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
        .collect();
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
        let (Ok(size), Ok(avail)) = (rest[0].parse::<u64>(), rest[2].parse::<u64>()) else {
            continue;
        };
        let mount = rest[4..].join(" ");
        if mount.is_empty() {
            continue;
        }
        seen.push(fs);
        disks.push(DiskInfo {
            mount,
            size: size * 1024,
            avail: avail * 1024,
        });
    }
    disks
}

/// 采样循环的停止句柄：丢弃即停止。
pub struct MonitorHandle {
    _stop: oneshot::Sender<()>,
}

/// 开始周期采样。每次先测延迟，再执行采样命令，解析后把快照送进返回的接收端；
/// 接收端被丢弃、或 [`MonitorHandle`] 被丢弃时循环结束。连接断开后采样命令会失败，
/// 之后的快照 `supported` 为 false，由调用方决定何时停。
pub fn watch(
    conn: Arc<Connection>,
    interval: Duration,
) -> (MonitorHandle, mpsc::UnboundedReceiver<MonitorSnapshot>) {
    let (tx, rx) = mpsc::unbounded_channel();
    let (stop_tx, mut stop_rx) = oneshot::channel::<()>();
    crate::spawn(async move {
        let mut prev: Option<Sample> = None;
        loop {
            let snap = sample(&conn, &mut prev).await;
            if tx.send(snap).is_err() {
                break;
            }
            tokio::select! {
                _ = &mut stop_rx => break,
                _ = crate::sleep(interval) => {}
            }
        }
    });
    (MonitorHandle { _stop: stop_tx }, rx)
}

async fn sample(conn: &Connection, prev: &mut Option<Sample>) -> MonitorSnapshot {
    let latency = conn.ping().await.ok();
    let parsed = match conn.exec(COMMAND).await {
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
        assert_eq!(s.cores, 4);
        assert_eq!(s.mem_total, 8_000_000 * 1024);
        assert_eq!(s.mem_used, 3_000_000 * 1024);
        assert_eq!(s.swap_total, 2_000_000 * 1024);
        assert_eq!(s.swap_used, 500_000 * 1024);
        assert_eq!(s.net, vec![("eth0".to_string(), 1000, 500)]);
        assert_eq!(s.procs.len(), 5);
        assert_eq!(
            s.procs[2],
            ProcSample { pid: 977, ticks: 150, mem_bytes: 51200 * 4096, name: "nginx: worker".into() }
        );
    }

    #[test]
    fn df_keeps_real_filesystems_only() {
        let s = parse(SAMPLE_A).unwrap();
        let mounts: Vec<&str> = s.disks.iter().map(|d| d.mount.as_str()).collect();
        // tmpfs、squashfs(loop)、overlay 去掉；同一设备的 bind mount 只留第一个；挂载点含空格要完整
        assert_eq!(mounts, vec!["/", "/data", "/mnt/nfs with space"]);
        assert_eq!(s.disks[0].size, 50_000_000 * 1024);
        assert_eq!(s.disks[0].avail, 27_000_000 * 1024);

        // 没有 Type 列时按名字过滤
        let s = parse(SAMPLE_B).unwrap();
        let mounts: Vec<&str> = s.disks.iter().map(|d| d.mount.as_str()).collect();
        assert_eq!(mounts, vec!["/"]);
    }

    #[test]
    fn cpu_and_net_rates_come_from_deltas() {
        let a = parse(SAMPLE_A).unwrap();
        let b = parse(SAMPLE_B).unwrap();

        let first = snapshot(None, &a, Some(12.5));
        assert!(first.supported);
        assert_eq!(first.cpu_percent, 0.0);
        assert!(first.net.is_empty());
        assert_eq!(first.latency_ms, Some(12.5));

        let second = snapshot(Some(&a), &b, None);
        // Δtotal = 1200，Δidle = 600 → 50%
        assert!((second.cpu_percent - 50.0).abs() < 1e-9, "{}", second.cpu_percent);
        // 2 秒内收 2000 字节、发 1000 字节
        assert_eq!(
            second.net,
            vec![NetRate { iface: "eth0".into(), rx_per_sec: 1000.0, tx_per_sec: 500.0 }]
        );
        assert_eq!(second.uptime_secs, 102.0);
        assert_eq!(second.latency_ms, None);
        assert!(second.procs.is_empty());
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

    #[test]
    fn command_is_safe_inside_double_quotes() {
        // 外层双引号里的内容交给用户的登录 shell，这几个字符在 bash / zsh / fish / csh 里含义各不相同
        let inner = COMMAND
            .strip_prefix("env LC_ALL=C sh -c \"")
            .and_then(|s| s.strip_suffix('"'))
            .unwrap();
        for bad in ['$', '`', '\\', '"', '!'] {
            assert!(!inner.contains(bad), "采样命令里不能有 {bad}");
        }
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
        let cmd = COMMAND.replace("/proc/[0-9]*/stat", &format!("{}/[0-9]*/stat", dir.display()));
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
        assert_eq!(json["procs"][0]["memBytes"], 128000u64 * 4096);
        assert_eq!(json["procs"][0]["pid"], 812);
        assert_eq!(json["disks"][0]["mount"], "/");
    }
}
