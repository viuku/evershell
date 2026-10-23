import { hostName } from '../core/known-hosts';
import { readJson, writeJson } from '../core/storage';
import {
  HostKeyError,
  type ConnectOptions,
  type FileEntry,
  type HostKeyInfo,
  type KnownHostEntry,
  type LocalConfigFiles,
  type MonitorDetail,
  type MonitorSnapshot,
  type ProcDetail,
  type SecretStore,
  type ShellHandlers,
  type SshBackend,
  type SshSession,
  type SocketRow,
  type SystemInfo,
  type TransferProgress,
} from '../types';
import { FakeShell } from './fake-shell';
import { MockFs } from './mock-fs';
import { browserDownload } from '../core/browser-download';
import { encodeUtf8 } from '../core/importers/text';

// 不连服务器也能完整预览界面的假后端。网页端 URL 带 ?mock 时使用。
// 约定几个特殊输入方便测试：主机含 fail → 连接失败；密码 wrong → 认证失败；主机含 bsd → 监控不支持；
// 主机含 rekey → 信任过一次指纹后再连，服务器换一把钥匙（看“指纹变了”的警告）；
// 主机含 flaky → 连上 8 秒后像网络断了一样断开（看断线提示）；
// 主机含 slow → 网络很慢：列目录、查文件信息多等 1.5 秒，传文件约 20KB/s（看“加载中”和进度）。
// 服务器指纹和真的一样要先确认：第一次连每台服务器都会弹确认框。
// 密码留空时只有主机含 nopass 能连上（模拟不要密码的服务器），其他主机和真服务器一样报认证失败，界面再弹框要密码。
// 导入窗口的一键导入：假装找到了 FinalShell 和 ~/.ssh/config，SecureCRT、PuTTY 没找到。

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 由种子算出一串像 base64 的字符，同一个种子每次一样 */
function fakeBase64(seed: string, length: number): string {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let x = 2166136261;
  for (const ch of seed) x = Math.imul(x ^ ch.charCodeAt(0), 16777619);
  let out = '';
  for (let i = 0; i < length; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out += abc[(x >>> 0) % 64];
  }
  return out;
}

function mockKey(openssh: string): HostKeyInfo {
  return { algorithm: openssh.split(' ')[0] ?? 'ssh-ed25519', fingerprint: `SHA256:${fakeBase64(openssh, 43)}`, openssh };
}

/** 主机名含 rekey、已经换过钥匙的服务器 */
const rekeyed = new Set<string>();

/** 假服务器的钥匙按主机名算，同一台每次一样。照真后端的规则对指纹记录，对不上抛 HostKeyError */
function checkHostKey(opts: ConnectOptions): HostKeyInfo {
  const name = hostName(opts.host, opts.port);
  const keyOf = (version: number) => mockKey(`ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${fakeBase64(`${name}#${version}`, 43)}`);
  const recorded: KnownHostEntry[] = [];
  for (const line of opts.knownHosts.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3 || fields[0]!.startsWith('#') || !fields[0]!.split(',').includes(name)) continue;
    recorded.push({ key: mockKey(`${fields[1]} ${fields[2]}`), line, exact: true });
  }
  if (/rekey/i.test(opts.host) && recorded.some((r) => r.key.openssh === keyOf(1).openssh)) rekeyed.add(name);
  const key = keyOf(rekeyed.has(name) ? 2 : 1);
  if (recorded.some((r) => r.key.openssh === key.openssh)) return key;
  if (recorded.length) throw new HostKeyError({ kind: 'changed', host: opts.host, port: opts.port, key, recorded });
  throw new HostKeyError({ kind: 'unknown', host: opts.host, port: opts.port, key, otherTypes: [] });
}

// 后面几个内存小、CPU 高，按 CPU 排时才排得上来。内核线程没有命令行和程序位置
const PROCS = [
  { pid: 2314, user: 'deploy', name: 'node', cmd: 'node /srv/app/server.js --port 3000', exe: '/usr/bin/node', mem: 1.1 * 2 ** 30, cpu: 12.4 },
  { pid: 981, user: 'root', name: 'dockerd', cmd: '/usr/bin/dockerd -H fd:// --containerd=/run/containerd/containerd.sock', exe: '/usr/bin/dockerd', mem: 612 * 2 ** 20, cpu: 3.1 },
  { pid: 1420, user: 'redis', name: 'redis-server', cmd: '/usr/bin/redis-server 127.0.0.1:6379', exe: '/usr/bin/redis-server', mem: 488 * 2 ** 20, cpu: 0.8 },
  { pid: 1102, user: 'www-data', name: 'nginx', cmd: 'nginx: worker process', exe: '/usr/sbin/nginx', mem: 236 * 2 ** 20, cpu: 4.6 },
  { pid: 873, user: 'root', name: 'containerd', cmd: '/usr/bin/containerd', exe: '/usr/bin/containerd', mem: 142 * 2 ** 20, cpu: 0.2 },
  { pid: 412, user: 'root', name: 'systemd-journal', cmd: '/usr/lib/systemd/systemd-journald', exe: '/usr/lib/systemd/systemd-journald', mem: 64 * 2 ** 20, cpu: 0.1 },
  { pid: 4410, user: 'www-data', name: 'php-fpm', cmd: 'php-fpm: pool www', exe: '/usr/sbin/php-fpm8.3', mem: 52 * 2 ** 20, cpu: 6.2 },
  { pid: 1033, user: 'root', name: 'sshd', cmd: 'sshd: root@pts/0', exe: '/usr/sbin/sshd', mem: 38 * 2 ** 20, cpu: 0.1 },
  { pid: 1, user: 'root', name: 'systemd', cmd: '/lib/systemd/systemd --system --deserialize=29', exe: '/usr/lib/systemd/systemd', mem: 12 * 2 ** 20, cpu: 0 },
  { pid: 702, user: 'root', name: 'cron', cmd: '/usr/sbin/cron -f -P', exe: '/usr/sbin/cron', mem: 3 * 2 ** 20, cpu: 0 },
  { pid: 5120, user: 'root', name: 'tar', cmd: 'tar -czf /backup/www.tar.gz /var/www', exe: '/usr/bin/tar', mem: 6 * 2 ** 20, cpu: 38 },
  { pid: 5121, user: 'root', name: 'gzip', cmd: 'gzip', exe: '/usr/bin/gzip', mem: 2 * 2 ** 20, cpu: 96 },
  { pid: 23, user: 'root', name: 'kswapd0', cmd: '', exe: '', mem: 0, cpu: 1.5 },
  { pid: 2, user: 'root', name: 'kthreadd', cmd: '', exe: '', mem: 0, cpu: 0 },
  { pid: 15, user: 'root', name: 'ksoftirqd/0', cmd: '', exe: '', mem: 0, cpu: 0.3 },
  { pid: 1201, user: 'systemd-resolve', name: 'systemd-resolve', cmd: '/usr/lib/systemd/systemd-resolved', exe: '/usr/lib/systemd/systemd-resolved', mem: 9 * 2 ** 20, cpu: 0 },
  { pid: 1190, user: 'messagebus', name: 'dbus-daemon', cmd: '@dbus-daemon --system --address=systemd: --nofork --nopidfile --systemd-activation --syslog-only', exe: '/usr/bin/dbus-daemon', mem: 4 * 2 ** 20, cpu: 0 },
];

const DISKS = [
  { mount: '/', device: '/dev/vda1', fsType: 'ext4', size: 80 * 2 ** 30, used: 36 * 2 ** 30, avail: 42 * 2 ** 30 },
  { mount: '/data', device: '/dev/vdb1', fsType: 'xfs', size: 500 * 2 ** 30, used: 412 * 2 ** 30, avail: 88 * 2 ** 30 },
  { mount: '/boot', device: '/dev/vda2', fsType: 'ext4', size: 2 ** 30, used: 180 * 2 ** 20, avail: 780 * 2 ** 20 },
];

/** 网络页的行：[pid, 名称, 监听地址, 端口, 几个 IP, 几条连接, 上传、下载的量级]。地址为 null 的是主动连出去的；pid 为 null 是看不到的进程 */
const LISTENS: [number | null, string, string | null, number | null, number, number, number, number][] = [
  [1033, 'sshd', '0.0.0.0', 22, 1, 2, 18 * 1024, 1500],
  [1102, 'nginx', '0.0.0.0', 443, 23, 41, 860 * 1024, 96 * 1024],
  [1102, 'nginx', '0.0.0.0', 80, 6, 7, 12 * 1024, 4 * 1024],
  [2314, 'node', '127.0.0.1', 3000, 1, 8, 640 * 1024, 80 * 1024],
  [1420, 'redis-server', '127.0.0.1', 6379, 1, 4, 30 * 1024, 26 * 1024],
  [1201, 'systemd-resolve', '127.0.0.53', 53, 0, 0, 0, 0],
  [981, 'dockerd', '::', 2375, 0, 0, 0, 0],
  [null, '', '0.0.0.0', 9100, 1, 1, 2 * 1024, 300],
  [2314, 'node', null, null, 3, 5, 40 * 1024, 210 * 1024],
];

/** 随机游走，让数字看起来像真的在动 */
class Drift {
  constructor(
    private value: number,
    private readonly min: number,
    private readonly max: number,
    private readonly step: number,
  ) {}

  next(): number {
    this.value += (Math.random() - 0.5) * 2 * this.step;
    // 偶尔来一个尖峰
    if (Math.random() < 0.05) this.value += this.step * 4;
    this.value = Math.max(this.min, Math.min(this.max, this.value));
    return this.value;
  }
}

class MockMonitor {
  private readonly cpu = new Drift(23, 2, 95, 4);
  private readonly mem = new Drift(0.65, 0.3, 0.95, 0.01);
  private readonly rx = new Drift(380 * 1024, 20 * 1024, 4 * 2 ** 20, 60 * 1024);
  private readonly tx = new Drift(1.2 * 2 ** 20, 50 * 1024, 8 * 2 ** 20, 200 * 1024);
  private readonly dockerRx = new Drift(40 * 1024, 0, 400 * 1024, 15 * 1024);
  private readonly latency = new Drift(18, 6, 120, 3);
  private readonly started = Date.now();
  private samples = 0;
  /** 各网卡累计的 [收, 发] 字节，每次采样按速率往上加 */
  private readonly totals: Record<string, [number, number]> = {
    eth0: [182 * 2 ** 30, 96 * 2 ** 30],
    docker0: [3.2 * 2 ** 30, 1.1 * 2 ** 30],
    lo: [5.4 * 2 ** 30, 5.4 * 2 ** 30],
  };
  /** 开着网络页以来第几次采样；第一次没有上一次的数可减，速率记 0，和真后端一样 */
  private socketSamples = 0;
  detail: MonitorDetail = { procs: false, sockets: false };

  constructor(private readonly supported: boolean) {}

  snapshot(): MonitorSnapshot {
    this.samples++;
    this.socketSamples = this.detail.sockets ? this.socketSamples + 1 : 0;
    if (!this.supported) {
      return {
        supported: false,
        uptimeSecs: 0,
        load: [0, 0, 0],
        cpuPercent: 0,
        cpuDetail: null,
        cpuCores: 0,
        memTotal: 0,
        memUsed: 0,
        swapTotal: 0,
        swapUsed: 0,
        net: [],
        ifaces: [],
        procs: [],
        disks: [],
        allProcs: null,
        sockets: null,
        latencyMs: Math.round(this.latency.next()),
      };
    }
    const cpu = this.cpu.next();
    const memTotal = 8 * 2 ** 30;
    const first = this.samples === 1;
    // 第一次采样算不出速率
    const net = first
      ? []
      : [
          { iface: 'eth0', rxPerSec: this.rx.next(), txPerSec: this.tx.next() },
          { iface: 'docker0', rxPerSec: this.dockerRx.next(), txPerSec: this.dockerRx.next() / 3 },
          { iface: 'lo', rxPerSec: 6 * 1024 * (0.5 + Math.random()), txPerSec: 0 },
        ];
    for (const n of net) {
      if (n.iface === 'lo') n.txPerSec = n.rxPerSec;
      const t = this.totals[n.iface]!;
      t[0] += n.rxPerSec * 2;
      t[1] += n.txPerSec * 2;
    }
    const procs = PROCS.map((p) => ({ ...p, cpuNow: first ? 0 : p.cpu * (0.6 + Math.random() * 0.8) }));
    // 总占用拆成几份，剩下的是空闲
    const user = cpu * 0.55;
    const system = cpu * 0.3;
    const steal = cpu * 0.08;
    const softirq = cpu * 0.05;
    const iowait = cpu - user - system - steal - softirq;
    return {
      supported: true,
      uptimeSecs: 41 * 86400 + 6 * 3600 + Math.floor((Date.now() - this.started) / 1000),
      load: [0.42 + cpu / 200, 0.51, 0.47],
      cpuPercent: cpu,
      cpuDetail: first ? null : { user, nice: 0, system, idle: 100 - cpu, iowait, irq: 0, softirq, steal },
      cpuCores: 4,
      memTotal,
      memUsed: Math.round(memTotal * this.mem.next()),
      swapTotal: 2 * 2 ** 30,
      swapUsed: 0.1 * 2 ** 30,
      // 状态栏的网速不含 lo
      net: net.filter((n) => n.iface !== 'lo'),
      ifaces: ['lo', 'eth0', 'docker0'].map((iface) => {
        const n = net.find((x) => x.iface === iface);
        const [rxBytes, txBytes] = this.totals[iface]!;
        return { iface, rxBytes, txBytes, rxPerSec: n?.rxPerSec ?? null, txPerSec: n?.txPerSec ?? null };
      }),
      // 真实后端只给内存前 10 和 CPU 前 10，这里进程少，全给；第一次采样 CPU 算不出来
      procs: procs.map((p) => ({ pid: p.pid, name: p.name, memBytes: p.mem, cpuPercent: p.cpuNow })),
      disks: DISKS,
      allProcs: this.detail.procs
        ? procs.map((p): ProcDetail => ({ pid: p.pid, user: p.user, name: p.name, cmdline: p.cmd, exe: p.exe, memBytes: p.mem, cpuPercent: p.cpuNow }))
        : null,
      sockets: this.detail.sockets ? { available: true, rows: this.socketRows() } : null,
      latencyMs: Math.round(this.latency.next()),
    };
  }

  private socketRows(): SocketRow[] {
    const wiggle = () => (this.socketSamples === 1 ? 0 : 0.4 + Math.random() * 1.2);
    return LISTENS.map(([pid, name, listenIp, port, ips, conns, tx, rx]) => ({
      pid,
      name,
      listenIp,
      port,
      ips,
      conns,
      txPerSec: tx * wiggle(),
      rxPerSec: rx * wiggle(),
    }));
  }
}

/** 假服务器的系统信息；监控不支持的主机只给 uname 拿得到的 */
function mockSystemInfo(supported: boolean, hostname: string): SystemInfo {
  if (!supported) return { os: '', kernel: 'FreeBSD', kernelRelease: '14.1-RELEASE', arch: 'amd64', hostname, cpus: [] };
  return {
    os: 'Ubuntu 24.04.1 LTS',
    kernel: 'Linux',
    kernelRelease: '6.8.0-45-generic',
    arch: 'x86_64',
    hostname,
    cpus: [
      {
        model: 'Intel(R) Xeon(R) Platinum 8259CL CPU @ 2.50GHz',
        sockets: 1,
        coresPerSocket: 2,
        threads: 4,
        mhz: 2499.996,
        cache: '36608 KB',
        bogomips: 4999.99,
      },
    ],
  };
}

/** 模拟分块传输进度，大约 6MB/s（slow：约 20KB/s，最多 8 秒），至少走 400ms */
async function simulateTransfer(total: number, onProgress?: (p: TransferProgress) => void, slow = false): Promise<void> {
  const size = Math.max(total, 1);
  const durationMs = slow
    ? Math.min(8000, Math.max(1500, (size / (20 * 1024)) * 1000))
    : Math.max(400, (size / (6 * 2 ** 20)) * 1000);
  const ticks = Math.max(4, Math.ceil(durationMs / 100));
  for (let i = 1; i <= ticks; i++) {
    await delay(durationMs / ticks);
    onProgress?.({ done: Math.round((size * i) / ticks), total: size });
  }
}

class MockSession implements SshSession {
  readonly hostKeyFingerprint: string;
  private readonly shell: FakeShell;
  private readonly monitor: MockMonitor;
  private closed = false;
  private readonly home: string;
  /** 正在采样时，立刻采一次 */
  private sampleNow: (() => void) | null = null;

  constructor(
    private readonly fs: MockFs,
    private readonly opts: ConnectOptions,
    handlers: ShellHandlers,
    hostKey: HostKeyInfo,
  ) {
    this.hostKeyFingerprint = hostKey.fingerprint;
    this.home = fs.ensureHome(opts.user);
    // IP 原样显示，域名只取第一段
    const hostname = /^[\d.:]+$/.test(opts.host) ? opts.host : opts.host.split('.')[0] || 'server';
    this.shell = new FakeShell(fs, opts.user, hostname, this.home, handlers.onData, (code) => {
      if (this.closed) return;
      this.closed = true;
      handlers.onExit(code, null);
    });
    this.monitor = new MockMonitor(!/bsd|unsupported/i.test(opts.host));
    setTimeout(() => this.shell.start(), 50);
    if (/flaky/i.test(opts.host)) {
      setTimeout(() => {
        if (this.closed) return;
        this.closed = true;
        this.shell.close();
        handlers.onExit(null, '约 1 分钟没有收到服务器响应，可能网络断了或电脑休眠过');
      }, 8000);
    }
  }

  write(data: Uint8Array): void {
    this.shell.input(data);
  }

  // 假终端一次只吐几行，不需要流控
  ack(): void {}

  resize(): void {}

  close(): void {
    this.closed = true;
    this.shell.close();
  }

  watchMonitor(onSnapshot: (s: MonitorSnapshot) => void, intervalMs: number): () => void {
    let timer: ReturnType<typeof setInterval> | null = null;
    // 和真后端一样，改了要多取的数据就马上采一次，再从这时起重新计时
    const restart = () => {
      if (timer) clearInterval(timer);
      timer = setInterval(() => onSnapshot(this.monitor.snapshot()), intervalMs);
    };
    const first = setTimeout(() => onSnapshot(this.monitor.snapshot()), 300);
    restart();
    this.sampleNow = () => {
      onSnapshot(this.monitor.snapshot());
      restart();
    };
    return () => {
      clearTimeout(first);
      if (timer) clearInterval(timer);
      this.sampleNow = null;
    };
  }

  setMonitorDetail(detail: MonitorDetail): void {
    this.monitor.detail = detail;
    this.sampleNow?.();
  }

  async systemInfo(): Promise<SystemInfo> {
    await delay(150);
    return mockSystemInfo(!/bsd|unsupported/i.test(this.opts.host), this.opts.host);
  }

  /** 主机含 slow 时模拟很慢的网络 */
  private get slow(): boolean {
    return /slow/i.test(this.opts.host);
  }

  /** 一次往返的等待；网络慢时多等 1.5 秒 */
  private roundTrip(ms: number): Promise<void> {
    return delay(this.slow ? ms + 1500 : ms);
  }

  async homeDir(): Promise<string> {
    await this.roundTrip(80);
    return this.home;
  }

  async listDir(path: string) {
    await this.roundTrip(60 + Math.random() * 120);
    return this.fs.list(path);
  }

  async mkdir(path: string): Promise<void> {
    await delay(80);
    this.fs.mkdir(path, this.opts.user);
  }

  async remove(path: string): Promise<void> {
    await delay(80);
    this.fs.remove(path);
  }

  async rename(from: string, to: string): Promise<void> {
    await delay(80);
    this.fs.rename(from, to);
  }

  async stat(path: string): Promise<FileEntry> {
    await this.roundTrip(40);
    return this.fs.stat(path);
  }

  async readFile(path: string, maxBytes: number, onProgress?: (p: TransferProgress) => void): Promise<Uint8Array> {
    const node = this.fs.stat(path);
    if (node.size > maxBytes) throw new Error(`文件有 ${node.size} 字节，超过了 ${maxBytes} 字节的上限`);
    await simulateTransfer(node.size, onProgress, this.slow);
    return this.fs.readBytes(path);
  }

  async upload(remotePath: string, data: Blob, onProgress?: (p: TransferProgress) => void): Promise<void> {
    await simulateTransfer(data.size, onProgress, this.slow);
    // 小文件按文本存下来，编辑器保存后再打开能看到改过的内容
    const content = data.size <= 1024 * 1024 ? await data.text() : null;
    this.fs.writeFile(remotePath, data.size, this.opts.user, content);
  }

  async download(remotePath: string, onProgress?: (p: TransferProgress) => void): Promise<string> {
    const node = this.fs.resolve(remotePath);
    if (!node) throw new Error(`没有这个文件：${remotePath}`);
    await simulateTransfer(node.kind === 'dir' ? 4096 : node.size, onProgress, this.slow);
    return `~/Downloads/${remotePath.slice(remotePath.lastIndexOf('/') + 1)}`;
  }
}

/** 一键导入的样例：像 Mac 上装了 FinalShell、写过 ~/.ssh/config，SecureCRT 和 PuTTY 没装。密码密文取自导入测试的样例 */
function mockLocalConfigs(): LocalConfigFiles[] {
  const json = (path: string, rec: Record<string, unknown>) => ({ path, bytes: encodeUtf8(JSON.stringify(rec)) });
  const conn = (folder: string, id: string, name: string, host: string, port: number, user: string, password: string) =>
    json(`conn/${folder}/${id}_connect_config.json`, {
      id,
      name,
      host,
      port,
      user_name: user,
      password,
      parent_id: folder,
      conection_type: 100,
      authentication_type: 1,
    });
  const pw = 'OhHCBX4pkEsVowU9xIn1UBVPg3QVyR4W';
  const finalshell = [
    json('conn/p1/folder.json', { id: 'p1', name: '生产环境', parent_id: '' }),
    conn('p1', 'a1', 'web-01', '203.0.113.11', 22, 'root', pw),
    conn('p1', 'a2', 'web-02', '203.0.113.12', 22, 'root', pw),
    conn('p1', 'a3', 'db-master', '203.0.113.20', 2222, 'dba', 'YY4C8xQVZgeoticpurt8nK/FbdF/of7s'),
    json('conn/t1/folder.json', { id: 't1', name: '测试', parent_id: '' }),
    conn('t1', 'b1', 'test-box', '192.0.2.50', 22, 'ubuntu', ''),
  ];
  const sshConfig = 'Host bastion\n  HostName 198.51.100.9\n  User ops\n\nHost *.internal\n  User me\n\nHost build\n  HostName 192.0.2.30\n  Port 2200\n';
  return [
    { source: 'finalshell', location: '~/Library/FinalShell/conn', files: finalshell, error: null },
    { source: 'putty', location: '~/.putty/sessions', files: [], error: null },
    { source: 'securecrt', location: '~/Library/Application Support/VanDyke/SecureCRT/Config/Sessions', files: [], error: null },
    { source: 'openssh', location: '~/.ssh/config', files: [{ path: 'config', bytes: encodeUtf8(sshConfig) }], error: null },
  ];
}

const SECRETS_KEY = 'evershell.mock-secrets';

/** 假保险箱：存在 localStorage，只为了让“记住密码”流程能走通 */
class MockSecrets implements SecretStore {
  readonly available = true;
  private readonly map = new Map<string, string>(Object.entries(readJson<Record<string, string>>(SECRETS_KEY, {})));

  async get(id: string): Promise<string | null> {
    return this.map.get(id) ?? null;
  }

  async set(id: string, secret: string): Promise<void> {
    this.map.set(id, secret);
    writeJson(SECRETS_KEY, Object.fromEntries(this.map));
  }

  async remove(id: string): Promise<void> {
    this.map.delete(id);
    writeJson(SECRETS_KEY, Object.fromEntries(this.map));
  }
}

export function createMockBackend(): SshBackend {
  const fs = new MockFs();
  return {
    secrets: new MockSecrets(),
    async saveFile(name: string, data: Uint8Array): Promise<string> {
      return browserDownload(name, data);
    },
    async findLocalConfigs(): Promise<LocalConfigFiles[]> {
      await delay(120);
      return mockLocalConfigs();
    },
    async connect(opts: ConnectOptions, handlers: ShellHandlers): Promise<SshSession> {
      await delay(400 + Math.random() * 500);
      if (/fail/i.test(opts.host)) throw new Error('连接超时：服务器无响应');
      const hostKey = checkHostKey(opts);
      if (opts.auth.type === 'password' && (opts.auth.password === 'wrong' || (opts.auth.password === '' && !/nopass/i.test(opts.host)))) {
        throw new Error('认证失败：用户名、密码或私钥不正确');
      }
      if (!opts.user) throw new Error('用户名不能为空');
      return new MockSession(fs, opts, handlers, hostKey);
    },
  };
}
