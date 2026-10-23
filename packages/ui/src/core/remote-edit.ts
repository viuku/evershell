import type { FileEntry, SshSession, TransferProgress } from '../types';
import { basename, normalizePath, parentPath } from './paths';
import { newId } from './storage';
import { trackTransfer } from './transfers-store';

// 双击远程文件直接编辑（docs/specs/remote-edit.md）。
// 文件读写都在主窗口（RemoteEdit），编辑窗口（core/editor-docs.ts）只管文字；两边靠消息说话，
// 桌面端消息走 Tauri 事件跨窗口，网页端编辑器浮在主窗口里，用 localChannelPair 直接递。

/** 编辑器最多打开多大的文件 */
export const EDIT_MAX_BYTES = 5 * 1024 * 1024;

export type Eol = '\n' | '\r\n';

export interface DecodedText {
  /** 换行统一成 \n */
  text: string;
  eol: Eol;
  /** 文件开头有 UTF-8 BOM，保存时原样加回去 */
  bom: boolean;
}

/**
 * 能当文本打开就返回文字，不能就返回 null：前 8KB 里有 0 字节（图片、压缩包、程序），或者不是合法的 UTF-8。
 * 换行符按多数算：\r\n 比单独的 \n 多就当 Windows 换行，保存时换回去
 */
export function decodeText(bytes: Uint8Array): DecodedText | null {
  if (bytes.subarray(0, 8192).includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
  const bom = text.charCodeAt(0) === 0xfeff;
  if (bom) text = text.slice(1);
  const crlf = text.split('\r\n').length - 1;
  const lf = text.split('\n').length - 1 - crlf;
  return { text: crlf > 0 ? text.replace(/\r\n/g, '\n') : text, eol: crlf > lf ? '\r\n' : '\n', bom };
}

export function encodeText(text: string, eol: Eol, bom: boolean): Uint8Array {
  const body = eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text;
  return new TextEncoder().encode(bom ? `﻿${body}` : body);
}

// ---------- 两个窗口之间的消息 ----------

export interface EditDocInit {
  id: string;
  /** 打开它的会话标签 */
  sessionId: string;
  /** 给人看的服务器名，如 root@web-01 */
  host: string;
  path: string;
  name: string;
  text: string;
  eol: Eol;
}

/** 主窗口发给编辑窗口 */
export type ToEditor =
  /** 主窗口刚启动：编辑窗口如果已经开着，回一句 ready */
  | { type: 'hello' }
  | { type: 'open'; doc: EditDocInit }
  | { type: 'focus'; id: string }
  /** 保存（上传）或重新载入（下载）的进度 */
  | { type: 'progress'; id: string; done: number; total: number }
  | { type: 'saved'; id: string; at: number }
  | { type: 'failed'; id: string; error: string }
  /** 服务器上的文件在打开之后被改过；remoteMtime 为 null 表示服务器上已经找不到这个文件 */
  | { type: 'conflict'; id: string; remoteMtime: number | null }
  | { type: 'reloaded'; id: string; text: string; eol: Eol };

/** 编辑窗口发给主窗口；gone 是编辑窗口没了（桌面端由 Rust 发，浮动窗口关掉时自己发） */
export type ToMain =
  | { type: 'ready' }
  | { type: 'save'; id: string; text: string; force: boolean }
  | { type: 'reload'; id: string }
  | { type: 'close'; id: string }
  | { type: 'gone' };

const TO_EDITOR = new Set(['hello', 'open', 'focus', 'progress', 'saved', 'failed', 'conflict', 'reloaded']);
const TO_MAIN = new Set(['ready', 'save', 'reload', 'close', 'gone']);

function typeOf(raw: unknown): string | null {
  return raw && typeof raw === 'object' && typeof (raw as { type?: unknown }).type === 'string'
    ? (raw as { type: string }).type
    : null;
}

export function asToEditor(raw: unknown): ToEditor | null {
  const t = typeOf(raw);
  return t && TO_EDITOR.has(t) ? (raw as ToEditor) : null;
}

export function asToMain(raw: unknown): ToMain | null {
  const t = typeOf(raw);
  return t && TO_MAIN.has(t) ? (raw as ToMain) : null;
}

export interface MessagePort {
  post(message: unknown): void;
  listen(handler: (message: unknown) => void): () => void;
}

/** 同一个页面里的一对消息口（浮动编辑器、测试用），消息异步送达，和跨窗口时一样 */
export function localChannelPair(): [MessagePort, MessagePort] {
  const handlers: [Set<(m: unknown) => void>, Set<(m: unknown) => void>] = [new Set(), new Set()];
  const port = (me: 0 | 1): MessagePort => ({
    post: (message) => {
      queueMicrotask(() => {
        for (const h of handlers[me === 0 ? 1 : 0]) h(message);
      });
    },
    listen: (handler) => {
      handlers[me].add(handler);
      return () => handlers[me].delete(handler);
    },
  });
  return [port(0), port(1)];
}

// ---------- 主窗口这一头 ----------

export interface EditTarget {
  session: SshSession;
  /** 给人看的服务器名 */
  host: string;
}

export type OpenResult = { kind: 'opened' } | { kind: 'too-large'; size: number } | { kind: 'not-text' };

interface DocMeta {
  sessionId: string;
  path: string;
  name: string;
  /** 打开或上次保存后服务器上的修改时间和大小，保存前比对 */
  mtime: number;
  size: number;
  eol: Eol;
  bom: boolean;
}

/** 主窗口重新加载过，不认识这个文档了 */
const FORGOTTEN = '主窗口刚重新加载过，请从文件区重新打开这个文件';

function errorText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * 主窗口里管远程编辑的：读文件、存文件、比对服务器上的版本。
 * 编辑窗口还没准备好（刚打开、正在加载）时发的消息先攒着，等它说 ready 再一起发。
 */
export class RemoteEdit {
  private readonly docs = new Map<string, DocMeta>();
  /** 正在打开的 会话 + 路径，防止双击两下开出两个 */
  private readonly opening = new Set<string>();
  private outbox: ToEditor[] = [];
  private ready = false;

  constructor(
    private readonly port: MessagePort,
    /** 按会话标签找到连着的会话；没连上返回 null */
    private readonly resolve: (sessionId: string) => EditTarget | null,
    /** 把编辑器摆出来：桌面端打开编辑窗口，网页端显示浮动窗口 */
    private readonly show: () => void | Promise<void>,
    /** 存好了，文件区开着这个目录的话刷新一下 */
    private readonly onSaved?: (sessionId: string, path: string) => void,
  ) {}

  /** 开始收编辑窗口的消息，返回停止函数。放在 useEffect 里，StrictMode 下重复挂载也只有一份在听 */
  start(): () => void {
    const off = this.port.listen((raw) => {
      const msg = asToMain(raw);
      if (msg) void this.handle(msg);
    });
    this.port.post({ type: 'hello' } satisfies ToEditor);
    return off;
  }

  /** 正在编辑的文件数，测试和关会话时看 */
  get openCount(): number {
    return this.docs.size;
  }

  /** 读进来再交给编辑器；onProgress 报读文件的进度，文件区据此在那一行显示“打开中” */
  async open(sessionId: string, path: string, onProgress?: (p: TransferProgress) => void): Promise<OpenResult> {
    const target = this.resolve(sessionId);
    if (!target) throw new Error('会话没连上');
    const p = normalizePath(path);
    for (const [id, d] of this.docs) {
      if (d.sessionId === sessionId && d.path === p) {
        await this.show();
        this.send({ type: 'focus', id });
        return { kind: 'opened' };
      }
    }
    const key = `${sessionId}\n${p}`;
    if (this.opening.has(key)) return { kind: 'opened' };
    this.opening.add(key);
    try {
      const st = await target.session.stat(p);
      if (st.kind === 'dir') throw new Error('这是一个目录');
      if (st.size > EDIT_MAX_BYTES) return { kind: 'too-large', size: st.size };
      const name = basename(p);
      const bytes = await trackTransfer('down', name, `${parentPath(p) ?? '/'} → 编辑器`, st.size, (track) =>
        target.session.readFile(p, EDIT_MAX_BYTES, (x) => {
          track(x);
          onProgress?.(x);
        }),
      );
      const decoded = decodeText(bytes);
      if (!decoded) return { kind: 'not-text' };
      const id = newId('doc');
      this.docs.set(id, { sessionId, path: p, name, mtime: st.mtime, size: st.size, eol: decoded.eol, bom: decoded.bom });
      await this.show();
      this.send({ type: 'open', doc: { id, sessionId, host: target.host, path: p, name, text: decoded.text, eol: decoded.eol } });
      return { kind: 'opened' };
    } finally {
      this.opening.delete(key);
    }
  }

  /** 进度只在百分比变了时发，免得消息太多 */
  private readonly lastPct = new Map<string, number>();

  private progress(id: string, p: TransferProgress): void {
    const pct = p.total > 0 ? Math.floor((p.done / p.total) * 100) : 0;
    if (this.lastPct.get(id) === pct) return;
    this.lastPct.set(id, pct);
    this.send({ type: 'progress', id, done: p.done, total: p.total });
  }

  private send(msg: ToEditor): void {
    if (this.ready) this.port.post(msg);
    else this.outbox.push(msg);
  }

  private async handle(msg: ToMain): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        this.ready = true;
        const queued = this.outbox;
        this.outbox = [];
        for (const m of queued) this.port.post(m);
        return;
      }
      case 'gone':
        this.ready = false;
        this.outbox = [];
        this.docs.clear();
        return;
      case 'close':
        this.docs.delete(msg.id);
        return;
      case 'save':
        return this.save(msg.id, msg.text, msg.force);
      case 'reload':
        return this.reload(msg.id);
    }
  }

  private target(doc: DocMeta): EditTarget | null {
    return this.resolve(doc.sessionId);
  }

  private async save(id: string, text: string, force: boolean): Promise<void> {
    const doc = this.docs.get(id);
    if (!doc) {
      this.send({ type: 'failed', id, error: FORGOTTEN });
      return;
    }
    const target = this.target(doc);
    if (!target) {
      this.send({ type: 'failed', id, error: '会话已断开，重新连上后再保存' });
      return;
    }
    try {
      if (!force) {
        const st: FileEntry | null = await target.session.stat(doc.path).catch(() => null);
        if (!st || st.mtime !== doc.mtime || st.size !== doc.size) {
          this.send({ type: 'conflict', id, remoteMtime: st ? st.mtime : null });
          return;
        }
      }
      const bytes = encodeText(text, doc.eol, doc.bom);
      const dir = parentPath(doc.path) ?? '/';
      this.lastPct.delete(id);
      await trackTransfer('up', doc.name, `编辑器 → ${dir}`, bytes.length, (track) =>
        target.session.upload(doc.path, new Blob([bytes as BlobPart]), (p) => {
          track(p);
          this.progress(id, p);
        }),
      );
      const st = await target.session.stat(doc.path).catch(() => null);
      doc.mtime = st ? st.mtime : doc.mtime;
      doc.size = st ? st.size : bytes.length;
      this.send({ type: 'saved', id, at: Date.now() });
      this.onSaved?.(doc.sessionId, doc.path);
    } catch (err) {
      this.send({ type: 'failed', id, error: `保存失败：${errorText(err)}` });
    }
  }

  private async reload(id: string): Promise<void> {
    const doc = this.docs.get(id);
    if (!doc) {
      this.send({ type: 'failed', id, error: FORGOTTEN });
      return;
    }
    const target = this.target(doc);
    if (!target) {
      this.send({ type: 'failed', id, error: '会话已断开，重新连上后再载入' });
      return;
    }
    try {
      const st = await target.session.stat(doc.path);
      if (st.size > EDIT_MAX_BYTES) throw new Error('文件已经超过 5 MB，编辑器打不开了');
      const dir = parentPath(doc.path) ?? '/';
      this.lastPct.delete(id);
      const bytes = await trackTransfer('down', doc.name, `${dir} → 编辑器`, st.size, (track) =>
        target.session.readFile(doc.path, EDIT_MAX_BYTES, (p) => {
          track(p);
          this.progress(id, p);
        }),
      );
      const decoded = decodeText(bytes);
      if (!decoded) throw new Error('文件已经不是文本了');
      Object.assign(doc, { mtime: st.mtime, size: st.size, eol: decoded.eol, bom: decoded.bom });
      this.send({ type: 'reloaded', id, text: decoded.text, eol: decoded.eol });
    } catch (err) {
      this.send({ type: 'failed', id, error: `载入失败：${errorText(err)}` });
    }
  }
}
