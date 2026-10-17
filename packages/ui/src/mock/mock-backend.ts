import { readJson, writeJson } from '../core/storage';
import type {
  ConnectOptions,
  MonitorSnapshot,
  SecretStore,
  ShellHandlers,
  SshBackend,
  SshSession,
  TransferProgress,
} from '../types';
import { FakeShell } from './fake-shell';
import { MockFs } from './mock-fs';
import { browserDownload } from '../core/browser-download';

// 不连服务器也能完整预览界面的假后端。网页端 URL 带 ?mock 时使用。
// 约定几个特殊输入方便测试：主机含 fail → 连接失败；密码 wrong → 认证失败；主机含 bsd → 监控不支持。

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function randomFingerprint(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `SHA256:${btoa(String.fromCharCode(...bytes)).replace(/=+$/, '')}`;
}

const PROCS = [
  { name: 'node', mem: 1.1 * 2 ** 30, cpu: 12.4 },
  { name: 'dockerd', mem: 612 * 2 ** 20, cpu: 3.1 },
  { name: 'redis-server', mem: 488 * 2 ** 20, cpu: 0.8 },
  { name: 'nginx', mem: 236 * 2 ** 20, cpu: 4.6 },
  { name: 'containerd', mem: 142 * 2 ** 20, cpu: 0.2 },
  { name: 'systemd-journald', mem: 64 * 2 ** 20, cpu: 0.1 },
  { name: 'sshd', mem: 38 * 2 ** 20, cpu: 0.1 },
];

const DISKS = [
  { mount: '/', size: 80 * 2 ** 30, avail: 42 * 2 ** 30 },
  { mount: '/data', size: 500 * 2 ** 30, avail: 88 * 2 ** 30 },
  { mount: '/boot', size: 2 ** 30, avail: 780 * 2 ** 20 },
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

  constructor(private readonly supported: boolean) {}

  snapshot(): MonitorSnapshot {
    this.samples++;
    if (!this.supported) {
      return {
        supported: false,
        uptimeSecs: 0,
        load: [0, 0, 0],
        cpuPercent: 0,
        cpuCores: 0,
        memTotal: 0,
        memUsed: 0,
        swapTotal: 0,
        swapUsed: 0,
        net: [],
        procs: [],
        disks: [],
        latencyMs: Math.round(this.latency.next()),
      };
    }
    const cpu = this.cpu.next();
    const memTotal = 8 * 2 ** 30;
    return {
      supported: true,
      uptimeSecs: 41 * 86400 + 6 * 3600 + Math.floor((Date.now() - this.started) / 1000),
      load: [0.42 + cpu / 200, 0.51, 0.47],
      cpuPercent: cpu,
      cpuCores: 4,
      memTotal,
      memUsed: Math.round(memTotal * this.mem.next()),
      swapTotal: 2 * 2 ** 30,
      swapUsed: 0.1 * 2 ** 30,
      // 第一次采样算不出速率
      net:
        this.samples === 1
          ? []
          : [
              { iface: 'eth0', rxPerSec: this.rx.next(), txPerSec: this.tx.next() },
              { iface: 'docker0', rxPerSec: this.dockerRx.next(), txPerSec: this.dockerRx.next() / 3 },
            ],
      procs: PROCS.map((p) => ({ name: p.name, memBytes: p.mem, cpuPercent: Math.max(0, p.cpu + (Math.random() - 0.5) * 2) })),
      disks: DISKS,
      latencyMs: Math.round(this.latency.next()),
    };
  }
}

/** 模拟分块传输进度，大约 6MB/s，至少走 400ms */
async function simulateTransfer(total: number, onProgress?: (p: TransferProgress) => void): Promise<void> {
  const size = Math.max(total, 1);
  const durationMs = Math.max(400, (size / (6 * 2 ** 20)) * 1000);
  const ticks = Math.max(4, Math.ceil(durationMs / 100));
  for (let i = 1; i <= ticks; i++) {
    await delay(durationMs / ticks);
    onProgress?.({ done: Math.round((size * i) / ticks), total: size });
  }
}

class MockSession implements SshSession {
  readonly hostKeyFingerprint = randomFingerprint();
  private readonly shell: FakeShell;
  private readonly monitor: MockMonitor;
  private closed = false;
  private readonly home: string;

  constructor(
    private readonly fs: MockFs,
    private readonly opts: ConnectOptions,
    handlers: ShellHandlers,
  ) {
    this.home = fs.ensureHome(opts.user);
    // IP 原样显示，域名只取第一段
    const hostname = /^[\d.:]+$/.test(opts.host) ? opts.host : opts.host.split('.')[0] || 'server';
    this.shell = new FakeShell(fs, opts.user, hostname, this.home, handlers.onData, (code) => {
      if (this.closed) return;
      this.closed = true;
      handlers.onExit(code);
    });
    this.monitor = new MockMonitor(!/bsd|unsupported/i.test(opts.host));
    setTimeout(() => this.shell.start(), 50);
  }

  write(data: Uint8Array): void {
    this.shell.input(data);
  }

  resize(): void {}

  close(): void {
    this.closed = true;
    this.shell.close();
  }

  watchMonitor(onSnapshot: (s: MonitorSnapshot) => void, intervalMs: number): () => void {
    const first = setTimeout(() => onSnapshot(this.monitor.snapshot()), 300);
    const timer = setInterval(() => onSnapshot(this.monitor.snapshot()), intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }

  async homeDir(): Promise<string> {
    await delay(80);
    return this.home;
  }

  async listDir(path: string) {
    await delay(60 + Math.random() * 120);
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

  async upload(remotePath: string, data: Blob, onProgress?: (p: TransferProgress) => void): Promise<void> {
    await simulateTransfer(data.size, onProgress);
    this.fs.writeFile(remotePath, data.size, this.opts.user);
  }

  async download(remotePath: string, onProgress?: (p: TransferProgress) => void): Promise<string> {
    const node = this.fs.resolve(remotePath);
    if (!node) throw new Error(`没有这个文件：${remotePath}`);
    await simulateTransfer(node.kind === 'dir' ? 4096 : node.size, onProgress);
    return `~/Downloads/${remotePath.slice(remotePath.lastIndexOf('/') + 1)}`;
  }
}

const SECRETS_KEY = 'evershell.mock-secrets';

/** 假钥匙串：存在 localStorage，只为了让“记住密码”流程能走通 */
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
    async connect(opts: ConnectOptions, handlers: ShellHandlers): Promise<SshSession> {
      await delay(400 + Math.random() * 500);
      if (/fail/i.test(opts.host)) throw new Error('连接超时：服务器无响应');
      if (opts.auth.type === 'password' && opts.auth.password === 'wrong') {
        throw new Error('认证失败：用户名、密码或私钥不正确');
      }
      if (!opts.user) throw new Error('用户名不能为空');
      return new MockSession(fs, opts, handlers);
    },
  };
}
