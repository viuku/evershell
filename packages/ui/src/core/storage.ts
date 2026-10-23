import type { StorageSync } from '../types';
import { Store } from './store';

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 隐私模式或配额用尽时静默失败，界面照常工作
  }
}

export function readText(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeText(key: string, value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {}
}

// 桌面端有好几个窗口（主窗口、连接管理器、编辑器），各有一份内存里的数据、共用一份 localStorage。
// 一个窗口写了，要让其他窗口换成新内容，不然它们下次写会拿旧数据把这次的修改盖掉（docs/specs/manager-window.md）。

/** 已经建好的 PersistentStore，按键找 */
const stores = new Map<string, PersistentStore<unknown>>();
let sync: StorageSync | null = null;

/** 接上平台的跨窗口通知（桌面端在 main.tsx 里接），返回断开函数 */
export function connectStorageSync(s: StorageSync): () => void {
  sync = s;
  const off = s.subscribe(receive);
  return () => {
    off();
    if (sync === s) sync = null;
  };
}

function receive(key: string, json: string): void {
  stores.get(key)?.applyRemote(json);
}

// 浏览器开了两个页签时，靠它自带的 storage 事件同步（只在别的页签写了时触发）
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key && e.newValue != null) receive(e.key, e.newValue);
  });
}

/** 每次 set 都写回 localStorage 的 Store；normalize 用来校验、迁移旧数据 */
export class PersistentStore<T> extends Store<T> {
  /** 正在换成别的窗口写的内容：不写回、不再广播 */
  private remote = false;

  constructor(
    private readonly key: string,
    private readonly fallback: T,
    private readonly normalize?: (raw: unknown, fallback: T) => T,
  ) {
    const raw = readJson<unknown>(key, undefined);
    super(raw === undefined ? fallback : normalize ? normalize(raw, fallback) : (raw as T));
    stores.set(key, this as PersistentStore<unknown>);
  }

  override set(next: T | ((prev: T) => T)): void {
    super.set(next);
    if (this.remote) return;
    const json = JSON.stringify(this.get());
    writeText(this.key, json);
    sync?.publish(this.key, json);
  }

  /** 重新从 localStorage 读一遍（别的窗口刚写、通知还没到时用） */
  reload(): void {
    const json = readText(this.key);
    if (json != null) this.applyRemote(json);
  }

  /** 别的窗口写了这个键：换成它的内容 */
  applyRemote(json: string): void {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      return;
    }
    this.remote = true;
    try {
      super.set(this.normalize ? this.normalize(raw, this.fallback) : (raw as T));
    } finally {
      this.remote = false;
    }
  }
}

export function newId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}
