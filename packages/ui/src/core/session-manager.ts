import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type IDisposable, type ITheme } from '@xterm/xterm';
import type { AuthConfig, ConnectOptions, MonitorSnapshot, SshBackend, SshSession } from '../types';
import { isAuthFailure, isBlankPassword, type ConnectTarget } from './connect';
import { FileBrowser } from './file-browser';
import { pushHistory } from './history-store';
import { normalizePath } from './paths';
import { Store } from './store';

export type SessionStatus = 'connecting' | 'connected' | 'closed' | 'error';

export interface SessionInfo {
  id: string;
  /** 来自连接管理器的哪条记录；临时连接为 null */
  serverId: string | null;
  name: string;
  host: string;
  port: number;
  user: string;
  status: SessionStatus;
  fingerprint: string | null;
  error: string | null;
  exitCode: number | null;
  cols: number;
  rows: number;
  /** 终端当前目录（OSC 7 或从标题推断），不知道时为 null */
  cwd: string | null;
}

/** 标签页：session 为 null 就是“新标签页” */
export interface TabInfo {
  id: string;
  session: SessionInfo | null;
}

export interface WorkspaceSnapshot {
  tabs: TabInfo[];
  activeId: string | null;
}

export interface OpenSessionOptions {
  serverId: string | null;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: AuthConfig;
}

/** 状态栏用的监控数据：最新快照 + 最近若干次采样画图 */
export interface MonitorState {
  snapshot: MonitorSnapshot | null;
  /** 最近的网速采样，字节/秒 */
  net: { rx: number; tx: number }[];
  /** 最近的延迟采样，毫秒；测不出的点记 0 */
  ping: number[];
  /** 选中的网卡；null 表示所有网卡求和 */
  iface: string | null;
}

export const NET_SAMPLES = 30;
export const PING_SAMPLES = 40;
const MONITOR_INTERVAL = 2000;

export class MonitorStore extends Store<MonitorState> {
  constructor() {
    super({ snapshot: null, net: [], ping: [], iface: null });
  }

  push(snapshot: MonitorSnapshot): void {
    this.set((s) => {
      const iface = s.iface && snapshot.net.some((n) => n.iface === s.iface) ? s.iface : null;
      const picked = iface ? snapshot.net.filter((n) => n.iface === iface) : snapshot.net;
      const rx = picked.reduce((a, n) => a + n.rxPerSec, 0);
      const tx = picked.reduce((a, n) => a + n.txPerSec, 0);
      return {
        snapshot,
        iface,
        net: snapshot.net.length ? [...s.net, { rx, tx }].slice(-NET_SAMPLES) : s.net,
        ping: [...s.ping, snapshot.latencyMs ?? 0].slice(-PING_SAMPLES),
      };
    });
  }

  setIface(iface: string | null): void {
    // 换网卡后旧曲线没意义，清掉重画
    this.set((s) => ({ ...s, iface, net: [] }));
  }

  reset(): void {
    this.set((s) => ({ ...s, snapshot: null, net: [], ping: [] }));
  }
}

interface Entry {
  info: SessionInfo;
  options: OpenSessionOptions;
  term: Terminal;
  fit: FitAddon;
  /** xterm 只能 open 一次，挂载点由会话自己持有，React 只负责放进 / 移出 DOM */
  container: HTMLDivElement;
  session: SshSession | null;
  started: boolean;
  inputListeners: IDisposable[];
  monitor: MonitorStore;
  stopMonitor: (() => void) | null;
  files: FileBrowser | null;
  /** 收到过 OSC 7 之后就不再用标题猜目录 */
  cwdFromOsc: boolean;
}

/** 不带密码没连上时向用户要密码；返回 null 表示取消 */
export type PasswordPrompt = (target: ConnectTarget) => Promise<string | null>;

export interface TerminalLook {
  theme: ITheme;
  fontSize: number;
}

const encoder = new TextEncoder();
const FONT_FAMILY = '"SF Mono", Menlo, Monaco, Consolas, "Cascadia Mono", "Liberation Mono", monospace';

/**
 * 持有所有标签页、终端实例和连接状态，不依赖具体后端。
 * 标签列表通过 subscribe/getSnapshot 接给 React；监控数据放在每个会话自己的 MonitorStore 里，
 * 刷新时只有订阅它的状态栏重绘。
 */
export class SessionManager {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private snapshot: WorkspaceSnapshot = { tabs: [], activeId: null };
  private seq = 0;
  private look: TerminalLook;
  private passwordPrompt: PasswordPrompt = async () => null;

  constructor(
    private readonly backend: SshBackend,
    look: TerminalLook,
  ) {
    this.look = look;
  }

  /** 界面挂上密码框；没挂时服务器要密码就当作取消 */
  setPasswordPrompt(prompt: PasswordPrompt): void {
    this.passwordPrompt = prompt;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): WorkspaceSnapshot => this.snapshot;

  // ---------- 标签 ----------

  openNewTab(): string {
    const id = `t${++this.seq}`;
    this.snapshot = { tabs: [...this.snapshot.tabs, { id, session: null }], activeId: id };
    this.emit();
    return id;
  }

  /** 新建会话标签。replaceTabId 指向一个“新标签页”时原地替换它，否则追加到末尾 */
  openSession(options: OpenSessionOptions, replaceTabId?: string | null): string {
    const id = `s${++this.seq}`;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: FONT_FAMILY,
      fontSize: this.look.fontSize,
      lineHeight: 1.1,
      scrollback: 5000,
      allowTransparency: true,
      theme: this.look.theme,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const container = document.createElement('div');
    container.className = 'term-host';

    const info: SessionInfo = {
      id,
      serverId: options.serverId,
      name: options.name,
      host: options.host,
      port: options.port,
      user: options.user,
      status: 'connecting',
      fingerprint: null,
      error: null,
      exitCode: null,
      cols: term.cols,
      rows: term.rows,
      cwd: null,
    };
    const entry: Entry = {
      info,
      options,
      term,
      fit,
      container,
      session: null,
      started: false,
      inputListeners: [],
      monitor: new MonitorStore(),
      stopMonitor: null,
      files: null,
      cwdFromOsc: false,
    };
    this.entries.set(id, entry);

    term.parser.registerOscHandler(7, (data) => {
      const path = parseOsc7(data);
      if (path) {
        entry.cwdFromOsc = true;
        this.setCwd(id, path);
      }
      return true;
    });
    term.onTitleChange((title) => {
      if (entry.cwdFromOsc) return;
      const guess = cwdFromTitle(title, entry.files?.store.get().home ?? null);
      if (guess) this.setCwd(id, guess);
    });
    term.onResize(({ cols, rows }) => this.update(id, { cols, rows }));

    const tab: TabInfo = { id, session: info };
    const index = replaceTabId ? this.snapshot.tabs.findIndex((t) => t.id === replaceTabId && t.session === null) : -1;
    const tabs = index >= 0 ? this.snapshot.tabs.map((t, i) => (i === index ? tab : t)) : [...this.snapshot.tabs, tab];
    this.snapshot = { tabs, activeId: id };
    this.emit();
    return id;
  }

  activate(id: string): void {
    if (this.snapshot.activeId === id || !this.snapshot.tabs.some((t) => t.id === id)) return;
    this.snapshot = { ...this.snapshot, activeId: id };
    this.emit();
  }

  closeTab(id: string): void {
    const entry = this.entries.get(id);
    if (entry) {
      entry.stopMonitor?.();
      entry.session?.close();
      entry.term.dispose();
      entry.container.remove();
      this.entries.delete(id);
    }
    const index = this.snapshot.tabs.findIndex((t) => t.id === id);
    if (index < 0) return;
    const tabs = this.snapshot.tabs.filter((t) => t.id !== id);
    let activeId = this.snapshot.activeId;
    if (activeId === id) activeId = tabs[Math.min(index, tabs.length - 1)]?.id ?? null;
    this.snapshot = { tabs, activeId };
    this.emit();
    // 始终保留至少一个标签
    if (tabs.length === 0) this.openNewTab();
  }

  // ---------- 终端挂载 ----------

  attach(id: string, host: HTMLElement): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    host.appendChild(entry.container);
    if (!entry.term.element) entry.term.open(entry.container);
    this.fit(id);
    if (!entry.started) {
      entry.started = true;
      void this.connect(entry);
    }
    entry.term.focus();
  }

  detach(id: string): void {
    this.entries.get(id)?.container.remove();
  }

  fit(id: string): void {
    const entry = this.entries.get(id);
    // 不在 DOM 里或尺寸为 0 时 fit 会算出 NaN
    if (entry?.container.isConnected && entry.container.clientWidth > 0 && entry.container.clientHeight > 0) {
      entry.fit.fit();
    }
  }

  focus(id: string): void {
    this.entries.get(id)?.term.focus();
  }

  getMonitor(id: string | null): MonitorStore | null {
    return id ? (this.entries.get(id)?.monitor ?? null) : null;
  }

  getFiles(id: string | null): FileBrowser | null {
    return id ? (this.entries.get(id)?.files ?? null) : null;
  }

  // ---------- 外观 ----------

  applyLook(look: TerminalLook): void {
    this.look = look;
    for (const entry of this.entries.values()) {
      entry.term.options.theme = look.theme;
      entry.term.options.fontSize = look.fontSize;
    }
    if (this.snapshot.activeId) this.fit(this.snapshot.activeId);
  }

  // ---------- 命令 ----------

  /** 发到指定会话；没连上时返回 false */
  sendCommand(id: string, cmd: string): boolean {
    const entry = this.entries.get(id);
    if (!entry?.session || entry.info.status !== 'connected') return false;
    entry.session.write(encoder.encode(`${cmd}\r`));
    pushHistory(cmd, entry.info.name);
    return true;
  }

  /** 发到所有已连接的会话，返回发送数量 */
  sendToAll(cmd: string): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.session && entry.info.status === 'connected') {
        entry.session.write(encoder.encode(`${cmd}\r`));
        count++;
      }
    }
    if (count > 0) pushHistory(cmd, count === 1 ? this.onlyConnectedName() : `全部会话（${count}）`);
    return count;
  }

  connectedCount(): number {
    let n = 0;
    for (const e of this.entries.values()) if (e.info.status === 'connected') n++;
    return n;
  }

  private onlyConnectedName(): string {
    for (const e of this.entries.values()) if (e.info.status === 'connected') return e.info.name;
    return '';
  }

  reconnect(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.info.status === 'connecting' || entry.info.status === 'connected') return;
    entry.term.write('\r\n\x1b[90m[正在重新连接…]\x1b[0m\r\n');
    entry.monitor.reset();
    this.update(id, { status: 'connecting', error: null, exitCode: null, fingerprint: null });
    void this.connect(entry);
  }

  // ---------- 内部 ----------

  private async connect(entry: Entry): Promise<void> {
    const { term, info } = entry;
    const opts: ConnectOptions = {
      host: entry.options.host,
      port: entry.options.port,
      user: entry.options.user,
      auth: entry.options.auth,
      cols: term.cols,
      rows: term.rows,
    };
    try {
      const session = await this.backend.connect(opts, {
        onData: (data) => {
          if (this.entries.has(info.id)) term.write(data);
        },
        onExit: (code) => {
          if (!this.entries.has(info.id)) return;
          this.teardown(entry);
          this.update(info.id, { status: 'closed', exitCode: code });
          term.write(`\r\n\x1b[90m[会话已结束${code === null ? '' : `，退出码 ${code}`}]\x1b[0m\r\n`);
        },
      });
      if (!this.entries.has(info.id)) {
        // 等待握手期间标签已被关掉
        session.close();
        return;
      }
      entry.session = session;
      entry.inputListeners = [
        term.onData((text) => session.write(encoder.encode(text))),
        term.onBinary((text) => session.write(Uint8Array.from(text, (c) => c.charCodeAt(0)))),
        term.onResize(({ cols, rows }) => session.resize(cols, rows)),
      ];
      // 握手期间窗口可能变过
      if (term.cols !== opts.cols || term.rows !== opts.rows) session.resize(term.cols, term.rows);
      entry.stopMonitor = session.watchMonitor((s) => entry.monitor.push(s), MONITOR_INTERVAL);
      entry.files = new FileBrowser(session);
      void entry.files.init();
      this.update(info.id, { status: 'connected', fingerprint: session.hostKeyFingerprint, error: null });
    } catch (err) {
      if (!this.entries.has(info.id)) return;
      const message = errorMessage(err);
      if (isAuthFailure(message) && isBlankPassword(entry.options.auth)) {
        void this.askPassword(entry);
        return;
      }
      this.update(info.id, { status: 'error', error: message });
      term.write(`\r\n\x1b[31m连接失败：${message}\x1b[0m\r\n`);
    }
  }

  /** 不带密码没连上，说明服务器要密码：问用户要，拿到后重连。问的时候标签保持“连接中” */
  private async askPassword(entry: Entry): Promise<void> {
    const { term, info } = entry;
    const password = await this.passwordPrompt(info).catch(() => null);
    if (!this.entries.has(info.id)) return;
    if (password === null) {
      this.update(info.id, { status: 'closed', error: '连接已取消' });
      term.write('\r\n\x1b[90m[连接已取消]\x1b[0m\r\n');
      return;
    }
    entry.options = { ...entry.options, auth: { type: 'password', password } };
    void this.connect(entry);
  }

  private teardown(entry: Entry): void {
    for (const l of entry.inputListeners) l.dispose();
    entry.inputListeners = [];
    entry.stopMonitor?.();
    entry.stopMonitor = null;
    entry.session = null;
    entry.files = null;
  }

  private setCwd(id: string, path: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const cwd = normalizePath(path);
    if (entry.info.cwd !== cwd) this.update(id, { cwd });
  }

  private update(id: string, patch: Partial<SessionInfo>): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.info = { ...entry.info, ...patch };
    this.snapshot = {
      ...this.snapshot,
      tabs: this.snapshot.tabs.map((t) => (t.id === id ? { id, session: entry.info } : t)),
    };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** OSC 7 的内容形如 file://host/path，取出 path */
function parseOsc7(data: string): string | null {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(data.trim());
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

/** 很多 shell 默认把标题设成 user@host: /path，从里面猜当前目录 */
function cwdFromTitle(title: string, home: string | null): string | null {
  const m = /(?:^|:\s*)(~(?:\/[^\s]*)?|\/[^\s]*)\s*$/.exec(title.trim());
  const raw = m?.[1];
  if (!raw) return null;
  if (raw.startsWith('~')) {
    if (!home) return null;
    return home + raw.slice(1);
  }
  return raw;
}

/** Tauri 的 invoke 失败时 reject 的是字符串，其他后端可能是 Error */
function errorMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
