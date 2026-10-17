import { joinPath, normalizePath } from '../core/paths';
import type { MockFs } from './mock-fs';

// 一个只认几条命令的假 shell：回显、提示符、cd 时发 OSC 7，够在界面上走通流程

const ESC = '\x1b';
const C = {
  reset: `${ESC}[0m`,
  dim: `${ESC}[90m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
  cyan: `${ESC}[36m`,
  bold: `${ESC}[1m`,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class FakeShell {
  private cwd: string;
  private buf = '';
  private esc = '';
  private busy = false;
  private closed = false;
  private readonly pending: string[] = [];

  constructor(
    private readonly fs: MockFs,
    private readonly user: string,
    private readonly hostname: string,
    private readonly home: string,
    private readonly out: (data: Uint8Array) => void,
    private readonly exit: (code: number) => void,
  ) {
    this.cwd = home;
  }

  start(): void {
    const d = new Date(Date.now() - 3 * 3600_000).toString().slice(0, 24);
    this.write(`${C.dim}Last login: ${d} from 203.0.113.24${C.reset}\r\n`);
    this.write(`${C.dim}（Mock 后端：输入 help 查看可用命令）${C.reset}\r\n`);
    this.prompt();
  }

  input(data: Uint8Array): void {
    if (this.closed) return;
    const text = decoder.decode(data);
    for (const ch of text) this.key(ch);
  }

  close(): void {
    this.closed = true;
  }

  private write(s: string): void {
    if (!this.closed) this.out(encoder.encode(s));
  }

  private cwdDisplay(): string {
    if (this.cwd === this.home) return '~';
    if (this.cwd.startsWith(`${this.home}/`)) return `~${this.cwd.slice(this.home.length)}`;
    return this.cwd;
  }

  private prompt(): void {
    const sym = this.user === 'root' ? '#' : '$';
    // OSC 7 告诉界面当前目录，OSC 0 设置标题
    this.write(`${ESC}]7;file://${this.hostname}${this.cwd}\x07`);
    this.write(`${ESC}]0;${this.user}@${this.hostname}: ${this.cwdDisplay()}\x07`);
    this.write(`${C.green}${this.user}@${this.hostname}${C.reset}:${C.blue}${this.cwdDisplay()}${C.reset}${sym} `);
  }

  private key(ch: string): void {
    // 吞掉方向键之类的转义序列
    if (this.esc) {
      this.esc += ch;
      if (/[A-Za-z~]/.test(ch)) this.esc = '';
      return;
    }
    if (ch === ESC) {
      this.esc = ch;
      return;
    }
    if (this.busy) {
      if (ch === '\x03') this.write('^C\r\n');
      return;
    }
    switch (ch) {
      case '\r':
      case '\n':
        this.write('\r\n');
        void this.run(this.buf);
        this.buf = '';
        return;
      case '\x7f':
      case '\b':
        if (this.buf) {
          this.buf = this.buf.slice(0, -1);
          this.write('\b \b');
        }
        return;
      case '\x03':
        this.write('^C\r\n');
        this.buf = '';
        this.prompt();
        return;
      case '\x0c':
        this.write(`${ESC}[2J${ESC}[H`);
        this.prompt();
        this.write(this.buf);
        return;
      case '\x04':
        if (!this.buf) {
          this.write('logout\r\n');
          this.closed = true;
          this.exit(0);
        }
        return;
      case '\t':
        return;
      default:
        if (ch >= ' ') {
          this.buf += ch;
          this.write(ch);
        }
    }
  }

  private async run(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) {
      this.prompt();
      return;
    }
    this.busy = true;
    await delay(40 + Math.random() * 80);
    const [cmd = '', ...args] = tokenize(trimmed);
    try {
      const output = this.exec(cmd, args, trimmed);
      if (output === null) return; // exit
      if (output) this.write(output.replace(/\n/g, '\r\n'));
    } catch (err) {
      this.write(`${err instanceof Error ? err.message : String(err)}\r\n`);
    }
    this.busy = false;
    if (!this.closed) this.prompt();
  }

  private resolve(p: string): string {
    if (!p || p === '~') return this.home;
    if (p.startsWith('~/')) return normalizePath(`${this.home}/${p.slice(2)}`);
    return p.startsWith('/') ? normalizePath(p) : joinPath(this.cwd, p);
  }

  private exec(cmd: string, args: string[], raw: string): string | null {
    switch (cmd) {
      case 'help':
        return `可用命令：ls、cd、pwd、cat、echo、mkdir、touch、rm、df、free、uptime、uname、whoami、hostname、date、clear、exit\n`;
      case 'pwd':
        return `${this.cwd}\n`;
      case 'cd': {
        const target = this.resolve(args[0] ?? '');
        this.fs.dirOf(target);
        this.cwd = target;
        return '';
      }
      case 'ls':
        return this.ls(args);
      case 'cat':
        return args.map((a) => this.fs.readFile(this.resolve(a))).join('');
      case 'echo':
        return `${args.join(' ')}\n`;
      case 'mkdir':
        for (const a of args) if (!a.startsWith('-')) this.fs.mkdir(this.resolve(a), this.user);
        return '';
      case 'touch':
        for (const a of args) this.fs.writeFile(this.resolve(a), 0, this.user);
        return '';
      case 'rm':
        for (const a of args) if (!a.startsWith('-')) this.fs.remove(this.resolve(a));
        return '';
      case 'whoami':
        return `${this.user}\n`;
      case 'hostname':
        return `${this.hostname}\n`;
      case 'date':
        return `${new Date().toString()}\n`;
      case 'uname':
        return args.includes('-a')
          ? `Linux ${this.hostname} 6.8.0-45-generic #45-Ubuntu SMP x86_64 GNU/Linux\n`
          : 'Linux\n';
      case 'uptime':
        return ` ${new Date().toTimeString().slice(0, 8)} up 41 days,  6:12,  1 user,  load average: 0.42, 0.51, 0.47\n`;
      case 'df':
        return (
          `${C.dim}Filesystem      Size  Used Avail Use% Mounted on${C.reset}\n` +
          `/dev/nvme0n1p2   80G   38G   42G  48% /\n` +
          `/dev/nvme1n1    500G  412G   88G  ${C.yellow}82%${C.reset} /data\n` +
          `/dev/nvme0n1p1  1.0G  220M  780M  22% /boot\n`
        );
      case 'free':
        return (
          `${C.dim}               total        used        free      shared  buff/cache   available${C.reset}\n` +
          `Mem:           8.0Gi       5.2Gi       0.9Gi       0.3Gi       1.9Gi       2.4Gi\n` +
          `Swap:          2.0Gi       0.1Gi       1.9Gi\n`
        );
      case 'docker':
        if (args[0] === 'ps') {
          return (
            `${C.dim}CONTAINER ID   IMAGE             STATUS        NAMES${C.reset}\n` +
            `a3f9c2d1e8b0   nginx:1.27        Up 6 days     web-nginx\n` +
            `7be21c09f4aa   app/api:2.14.0    Up 6 days     api\n` +
            `c41d8e7a2f13   redis:7.4         Up 12 days    cache\n`
          );
        }
        return `docker: '${args[0] ?? ''}' is not a docker command（Mock）\n`;
      case 'clear':
        return `${ESC}[2J${ESC}[H`;
      case 'exit':
      case 'logout':
        this.write('logout\r\n');
        this.closed = true;
        this.exit(0);
        return null;
      default:
        if (raw.includes('|') || raw.includes('&&')) return `${C.dim}（Mock shell 不支持管道和组合命令）${C.reset}\n`;
        return `bash: ${cmd}: command not found\n`;
    }
  }

  private ls(args: string[]): string {
    const long = args.some((a) => a.startsWith('-') && a.includes('l'));
    const all = args.some((a) => a.startsWith('-') && a.includes('a'));
    const target = this.resolve(args.find((a) => !a.startsWith('-')) ?? '');
    const entries = this.fs
      .list(target)
      .filter((e) => all || !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name));
    const paint = (e: (typeof entries)[number]) => {
      if (e.kind === 'dir') return `${C.bold}${C.blue}${e.name}${C.reset}`;
      if (e.kind === 'link') return `${C.cyan}${e.name}${C.reset}`;
      if (e.perm.includes('x')) return `${C.green}${e.name}${C.reset}`;
      return e.name;
    };
    if (!long) return entries.length ? `${entries.map(paint).join('  ')}\n` : '';
    const lines = entries.map((e) => {
      const d = new Date(e.mtime * 1000);
      const when = `${d.toLocaleString('en-US', { month: 'short' })} ${String(d.getDate()).padStart(2)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      return `${e.perm} 1 ${e.owner.padEnd(8)} ${e.owner.padEnd(8)} ${String(e.size).padStart(10)} ${when} ${paint(e)}`;
    });
    return `total ${entries.length}\n${lines.join('\n')}\n`;
  }
}

function tokenize(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}
