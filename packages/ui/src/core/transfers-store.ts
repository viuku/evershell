import { newId } from './storage';
import { Store } from './store';
import type { TransferProgress } from '../types';

export type TransferStatus = 'running' | 'done' | 'error';

export interface TransferItem {
  id: string;
  dir: 'up' | 'down';
  name: string;
  /** 形如 “本机 → /opt/app/releases” */
  route: string;
  done: number;
  total: number;
  status: TransferStatus;
  error: string | null;
  /** 最近一段时间的速率，字节/秒 */
  speed: number;
  startedAt: number;
  updatedAt: number;
}

/** 上传下载队列。只在内存里，重启后清空 */
export const transfersStore = new Store<TransferItem[]>([]);

function patch(id: string, p: Partial<TransferItem>): void {
  transfersStore.set((list) => list.map((t) => (t.id === id ? { ...t, ...p } : t)));
}

/** 包一层：登记队列项，把进度回调接到 store 上 */
export async function trackTransfer<T>(
  dir: 'up' | 'down',
  name: string,
  route: string,
  total: number,
  run: (onProgress: (p: TransferProgress) => void) => Promise<T>,
): Promise<T> {
  const id = newId('xfr');
  const now = Date.now();
  transfersStore.set((list) => [
    { id, dir, name, route, done: 0, total, status: 'running', error: null, speed: 0, startedAt: now, updatedAt: now },
    ...list,
  ]);
  let lastAt = now;
  let lastDone = 0;
  let speed = 0;
  try {
    const result = await run((p) => {
      const t = Date.now();
      const dt = t - lastAt;
      // 速率用 300ms 以上的窗口平滑一下，免得数字抖
      if (dt >= 300) {
        speed = ((p.done - lastDone) * 1000) / dt;
        lastAt = t;
        lastDone = p.done;
      }
      patch(id, { done: p.done, total: p.total || total, speed, updatedAt: t });
    });
    transfersStore.set((list) =>
      list.map((t) => (t.id === id ? { ...t, done: t.total, status: 'done', speed: 0, updatedAt: Date.now() } : t)),
    );
    return result;
  } catch (err) {
    patch(id, { status: 'error', error: err instanceof Error ? err.message : String(err), updatedAt: Date.now() });
    throw err;
  }
}

export function clearFinishedTransfers(): void {
  transfersStore.set((list) => list.filter((t) => t.status === 'running'));
}
