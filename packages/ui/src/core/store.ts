import { useSyncExternalStore } from 'react';

/** 极简外部状态容器，接给 React 的 useSyncExternalStore。 */
export class Store<T> {
  private readonly listeners = new Set<() => void>();

  constructor(private value: T) {}

  readonly get = (): T => this.value;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  set(next: T | ((prev: T) => T)): void {
    const value = typeof next === 'function' ? (next as (prev: T) => T)(this.value) : next;
    if (Object.is(value, this.value)) return;
    this.value = value;
    for (const listener of this.listeners) listener();
  }
}

export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

const EMPTY = new Store<null>(null);

/** 组件里 store 可能还不存在（例如没有活动会话）时用这个，避免条件调用 hook */
export function useMaybeStore<T>(store: Store<T> | null): T | null {
  return useSyncExternalStore(
    (store ?? EMPTY).subscribe,
    (store ?? EMPTY).get as () => T | null,
    (store ?? EMPTY).get as () => T | null,
  );
}
