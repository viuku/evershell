// 数值格式化。后端只给原始单位，展示规则统一放这里。

const UNITS = ['B', 'K', 'M', 'G', 'T', 'P'];

/** 紧凑写法：5.2G、386K、0 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  let i = 0;
  let v = n;
  while (v >= 1000 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = v >= 100 || i === 0 ? 0 : 1;
  return `${v.toFixed(digits)}${UNITS[i]}`;
}

/** 带空格和完整单位：48.3 MB */
export function formatBytesLong(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-';
  if (n < 1024) return `${n} B`;
  let i = 0;
  let v = n;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${UNITS[i]}B`;
}

export function formatRate(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatUptime(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '-';
  const days = Math.floor(secs / 86400);
  const hours = Math.floor((secs % 86400) / 3600);
  const mins = Math.floor((secs % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${mins} 分`;
  return `${mins} 分钟`;
}

export function formatLoad(load: [number, number, number]): string {
  return load.map((x) => x.toFixed(2)).join(', ');
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 文件修改时间：当年显示 MM-DD HH:mm，往年显示 YYYY-MM-DD */
export function formatMtime(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  if (Number.isNaN(d.getTime())) return '-';
  const now = new Date();
  if (d.getFullYear() !== now.getFullYear()) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 历史命令的时间列：今天显示 HH:mm，昨天显示“昨天”，更早显示 MM-DD */
export function formatClock(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= startOfToday) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (ts >= startOfToday - 86400_000) return '昨天';
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 相对时间：2 分钟前、昨天、2 周前 */
export function formatRelative(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const min = 60_000;
  if (diff < min) return '刚刚';
  if (diff < 60 * min) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < 24 * 60 * min) return `${Math.floor(diff / (60 * min))} 小时前`;
  const days = Math.floor(diff / (24 * 60 * min));
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

export function formatEta(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return '';
  if (secs < 60) return `剩 ${Math.ceil(secs)} 秒`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `剩 ${m} 分 ${s} 秒`;
}

export function formatPercent(n: number): string {
  return `${Math.round(Math.max(0, Math.min(100, n)))}%`;
}

/** 坐标轴刻度：把最大值向上取整到好看的数字（1、2、5 × 10^n） */
export function niceCeilBytes(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1024;
  let unit = 1;
  while (n / unit >= 1024) unit *= 1024;
  return niceCeil(n / unit) * unit;
}

export function niceCeil(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 1;
  const exp = Math.floor(Math.log10(n));
  const base = 10 ** exp;
  const m = n / base;
  const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return nice * base;
}
