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

/** 每次 set 都写回 localStorage 的 Store；normalize 用来校验、迁移旧数据 */
export class PersistentStore<T> extends Store<T> {
  constructor(
    private readonly key: string,
    fallback: T,
    normalize?: (raw: unknown, fallback: T) => T,
  ) {
    const raw = readJson<unknown>(key, undefined);
    super(raw === undefined ? fallback : normalize ? normalize(raw, fallback) : (raw as T));
  }

  override set(next: T | ((prev: T) => T)): void {
    super.set(next);
    writeJson(this.key, this.get());
  }
}

export function newId(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}
