import type { WindowLink } from '../types';

// 桌面端的独立连接管理器窗口（docs/specs/manager-window.md）。
// 连接列表两个窗口各自读写（core/storage.ts 负责同步），这里只传“打开导入”“连这几台”两件事。

/** 主窗口发给连接管理器 */
export type ToManager = { type: 'hello' } | { type: 'import' };

/** 连接管理器发给主窗口；gone 是管理器窗口没了（Rust 发） */
export type FromManager = { type: 'ready' } | { type: 'connect'; ids: string[] } | { type: 'gone' };

const TO_MANAGER = new Set(['hello', 'import']);
const FROM_MANAGER = new Set(['ready', 'connect', 'gone']);

function typeOf(raw: unknown): string | null {
  return raw && typeof raw === 'object' && typeof (raw as { type?: unknown }).type === 'string'
    ? (raw as { type: string }).type
    : null;
}

export function asToManager(raw: unknown): ToManager | null {
  const t = typeOf(raw);
  return t && TO_MANAGER.has(t) ? (raw as ToManager) : null;
}

export function asFromManager(raw: unknown): FromManager | null {
  const t = typeOf(raw);
  if (!t || !FROM_MANAGER.has(t)) return null;
  if (t === 'connect') {
    const ids = (raw as { ids?: unknown }).ids;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) return null;
  }
  return raw as FromManager;
}

/**
 * 主窗口这一头：打开管理器窗口；管理器还没加载好时发的消息先攒着，等它说 ready 再发；
 * 要连的服务器排队，一台连完（或放弃）再连下一台，要密码的依次弹框
 */
export class ManagerLink {
  private ready = false;
  private outbox: ToManager[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly link: WindowLink,
    private readonly connect: (serverId: string) => Promise<void>,
  ) {}

  /** 开始收消息，返回停止函数。放在 useEffect 里 */
  start(): () => void {
    const off = this.link.listen((raw) => {
      const msg = asFromManager(raw);
      if (msg) this.handle(msg);
    });
    this.link.post({ type: 'hello' } satisfies ToManager);
    return off;
  }

  /** 打开（或切到）管理器窗口；importing：直接进导入；background 见 WindowLink.open */
  async open(importing = false, background?: string): Promise<void> {
    if (importing) this.send({ type: 'import' });
    await this.link.open(background);
  }

  private send(msg: ToManager): void {
    if (this.ready) this.link.post(msg);
    else this.outbox.push(msg);
  }

  private handle(msg: FromManager): void {
    switch (msg.type) {
      case 'ready': {
        this.ready = true;
        const queued = this.outbox;
        this.outbox = [];
        for (const m of queued) this.link.post(m);
        return;
      }
      case 'gone':
        this.ready = false;
        this.outbox = [];
        return;
      case 'connect':
        for (const id of msg.ids) {
          this.queue = this.queue.then(() => this.connect(id)).catch(() => {});
        }
        return;
    }
  }

  /** 等排着的连接都处理完（测试用） */
  idle(): Promise<void> {
    return this.queue;
  }
}
