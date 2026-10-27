import { PersistentStore } from './storage';

/** 新标签页“快速连接”的数据：最近连过的服务器 id 和时间 */
export interface RecentEntry {
  serverId: string;
  at: number;
}

const MAX = 20;
/** 本机最多留几条；云同步合并远端记录时照这个数裁剪 */
export const RECENTS_MAX = MAX;

export const recentsStore = new PersistentStore<RecentEntry[]>('evershell.recents.v1', [], (raw, fb) =>
  Array.isArray(raw) ? raw.filter((r) => r && typeof r.serverId === 'string' && typeof r.at === 'number') : fb,
);

export function pushRecent(serverId: string): void {
  recentsStore.set((list) => [{ serverId, at: Date.now() }, ...list.filter((r) => r.serverId !== serverId)].slice(0, MAX));
}

export function clearRecents(): void {
  recentsStore.set([]);
}
