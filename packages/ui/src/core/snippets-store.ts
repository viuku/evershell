import { PersistentStore, newId } from './storage';

export interface Snippet {
  id: string;
  name: string;
  cmd: string;
  group: string;
  updatedAt: number;
}

/** 第一次使用时给几条常用命令，方便上手；用户可以随意删改 */
function defaults(): Snippet[] {
  const now = Date.now();
  return [
    { id: newId('snp'), name: '查看磁盘', cmd: 'df -h', group: '常用', updatedAt: now },
    { id: newId('snp'), name: '内存占用前 10', cmd: 'ps aux --sort=-%mem | head -11', group: '常用', updatedAt: now },
    { id: newId('snp'), name: '容器状态', cmd: 'docker ps', group: 'Docker', updatedAt: now },
  ];
}

export const snippetsStore = new PersistentStore<Snippet[]>('evershell.snippets.v1', defaults(), (raw, fb) =>
  Array.isArray(raw) ? raw.filter((s) => s && typeof s.id === 'string' && typeof s.cmd === 'string') : fb,
);

export function addSnippet(input: Pick<Snippet, 'name' | 'cmd' | 'group'>): void {
  snippetsStore.set((list) => [...list, { id: newId('snp'), ...input, updatedAt: Date.now() }]);
}

export function updateSnippet(id: string, input: Pick<Snippet, 'name' | 'cmd' | 'group'>): void {
  snippetsStore.set((list) => list.map((s) => (s.id === id ? { ...s, ...input, updatedAt: Date.now() } : s)));
}

export function removeSnippet(id: string): void {
  snippetsStore.set((list) => list.filter((s) => s.id !== id));
}

export function snippetGroups(list: Snippet[]): string[] {
  const seen = new Set<string>();
  for (const s of list) if (s.group) seen.add(s.group);
  return [...seen];
}
