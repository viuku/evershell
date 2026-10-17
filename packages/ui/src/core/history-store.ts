import { PersistentStore, newId } from './storage';

/** 命令栏和快捷命令发出的命令记录 */
export interface HistoryEntry {
  id: string;
  at: number;
  cmd: string;
  /** 发到了哪个会话（名称）；批量发送时是“全部会话” */
  target: string;
}

const MAX = 300;

export const historyStore = new PersistentStore<HistoryEntry[]>('evershell.history.v1', [], (raw, fb) =>
  Array.isArray(raw) ? raw.filter((h) => h && typeof h.cmd === 'string' && typeof h.at === 'number') : fb,
);

export function pushHistory(cmd: string, target: string): void {
  historyStore.set((list) => [{ id: newId('his'), at: Date.now(), cmd, target }, ...list].slice(0, MAX));
}

export function clearHistory(): void {
  historyStore.set([]);
}

/** 命令栏“历史 ▾”用：去重后的最近命令 */
export function recentCommands(list: HistoryEntry[], limit = 15): string[] {
  const out: string[] = [];
  for (const h of list) {
    if (!out.includes(h.cmd)) out.push(h.cmd);
    if (out.length >= limit) break;
  }
  return out;
}
