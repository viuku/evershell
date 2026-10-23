import { describe, expect, it } from 'vitest';
import { connectStorageSync, PersistentStore } from '../storage';

/** 一个假的“跨窗口通知”：记下发出去的，测试里手动投递别的窗口写的 */
function fakeSync() {
  const published: [string, string][] = [];
  let deliver: ((key: string, json: string) => void) | null = null;
  const off = connectStorageSync({
    publish: (key, json) => published.push([key, json]),
    subscribe: (handler) => {
      deliver = handler;
      return () => {
        deliver = null;
      };
    },
  });
  return { published, deliver: (key: string, json: string) => deliver?.(key, json), off };
}

describe('PersistentStore 跨窗口同步', () => {
  it('写了就广播键和新内容', () => {
    const sync = fakeSync();
    const store = new PersistentStore<number[]>('test.sync.a', []);
    store.set([1, 2]);
    expect(sync.published).toEqual([['test.sync.a', '[1,2]']]);
    sync.off();
  });

  it('别的窗口写的：换成新内容，不再广播回去', () => {
    const sync = fakeSync();
    const store = new PersistentStore<{ n: number }>('test.sync.b', { n: 0 });
    const seen: number[] = [];
    store.subscribe(() => seen.push(store.get().n));
    sync.deliver('test.sync.b', '{"n":5}');
    expect(store.get()).toEqual({ n: 5 });
    expect(seen).toEqual([5]);
    expect(sync.published).toEqual([]);
    // 之后自己再写，照常广播
    store.set({ n: 6 });
    expect(sync.published).toEqual([['test.sync.b', '{"n":6}']]);
    sync.off();
  });

  it('收到的内容照样校验；坏的、不认识的键不理', () => {
    const sync = fakeSync();
    const store = new PersistentStore<number>('test.sync.c', 1, (raw, fb) => (typeof raw === 'number' && raw > 0 ? raw : fb));
    sync.deliver('test.sync.c', '-3');
    expect(store.get()).toBe(1);
    sync.deliver('test.sync.c', 'not json');
    expect(store.get()).toBe(1);
    sync.deliver('test.sync.other', '7');
    expect(store.get()).toBe(1);
    sync.deliver('test.sync.c', '9');
    expect(store.get()).toBe(9);
    sync.off();
  });
});
