import { PersistentStore, newId } from './storage';

export interface Snippet {
  id: string;
  name: string;
  cmd: string;
  /** 所在分类的名字；改名时一起改，见 renameGroup */
  group: string;
  updatedAt: number;
  /** 点了只把文字放进终端、不按回车（要补参数的命令）。没有这项就是自动回车，规格见 docs/specs/command-import.md */
  noEnter?: true;
}

export type SnippetInput = Pick<Snippet, 'name' | 'cmd' | 'group'> & { noEnter?: boolean };

/** 分类全删光以后，新建的命令放进这里 */
export const DEFAULT_GROUP = '默认分类';

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
  Array.isArray(raw)
    ? raw
        .filter((s) => s && typeof s.id === 'string' && typeof s.cmd === 'string')
        // 缺分类的记录放进默认分类，不然哪个分类下都看不到它
        .map((s) => (typeof s.group === 'string' && s.group.trim() ? s : { ...s, group: DEFAULT_GROUP }))
        .map(({ noEnter, ...s }) => (noEnter === true ? { ...s, noEnter } : s))
    : fb,
);

/**
 * 分类清单，顺序就是显示顺序。命令里的 group 仍是分类名，这份清单只多记了“有哪些分类、什么顺序”，
 * 所以空分类也能留着。老数据没有这个键，读的时候和命令里引用到的分类合并（listGroups），
 * 第一次改动时把合并结果写下来（materialize）。规格见 docs/specs/command-groups.md。
 */
export const groupsStore = new PersistentStore<string[]>('evershell.snippet-groups.v1', [], (raw, fb) =>
  Array.isArray(raw) ? unique(raw.filter((g): g is string => typeof g === 'string' && g.trim() !== '')) : fb,
);

function unique(names: string[]): string[] {
  return [...new Set(names)];
}

// ---------- 纯函数：给定清单和命令算出新的一份，方便测试 ----------

export interface SnippetData {
  groups: string[];
  snippets: Snippet[];
}

/** 显示的分类：清单里的按清单顺序，命令里引用到、清单里没有的按出现顺序补在后面 */
export function listGroups(saved: string[], snippets: Snippet[]): string[] {
  return unique([...saved, ...snippets.map((s) => s.group).filter(Boolean)]);
}

/** 选中的分类已经不在了（被删、被改名）就退回第一个 */
export function currentGroup(groups: string[], selected: string | null): string | null {
  return selected !== null && groups.includes(selected) ? selected : (groups[0] ?? null);
}

/** 分类名能不能用，能用返回 null；except 是改名前的名字，原样保留不算重名 */
export function groupNameError(name: string, groups: string[], except?: string): string | null {
  const n = name.trim();
  if (!n) return '请输入分类名称';
  if (n !== except && groups.includes(n)) return `分类「${n}」已存在`;
  return null;
}

/** 没填名称时用命令的第一行代替 */
export function defaultSnippetName(cmd: string): string {
  return (cmd.trim().split('\n')[0] ?? '').trim().slice(0, 30);
}

/** 新建命令时没指定分类：放进第一个分类，一个分类都没有就放进默认分类 */
export function resolveGroup(group: string, groups: string[]): string {
  return group.trim() || groups[0] || DEFAULT_GROUP;
}

function withGroup(groups: string[], name: string): string[] {
  return groups.includes(name) ? groups : [...groups, name];
}

export function withGroupAdded(data: SnippetData, name: string): SnippetData {
  const n = name.trim();
  if (groupNameError(n, data.groups)) return data;
  return { ...data, groups: [...data.groups, n] };
}

/** 改名：清单里原位替换，引用它的命令一起改 */
export function withGroupRenamed(data: SnippetData, from: string, to: string, now: number): SnippetData {
  const n = to.trim();
  if (n === from || !data.groups.includes(from) || groupNameError(n, data.groups, from)) return data;
  return {
    groups: data.groups.map((g) => (g === from ? n : g)),
    snippets: data.snippets.map((s) => (s.group === from ? { ...s, group: n, updatedAt: now } : s)),
  };
}

/** 删除分类，里面的命令一起删 */
export function withGroupRemoved(data: SnippetData, name: string): SnippetData {
  return {
    groups: data.groups.filter((g) => g !== name),
    snippets: data.snippets.filter((s) => s.group !== name),
  };
}

/**
 * 存之前整理命令：换行统一成 \n，只去掉开头和末尾多出来的空行。空格按用户输入的原样保存，
 * 不加也不删，和回不回车无关（所有者 2026-10-26 定）
 */
export function tidyCommand(cmd: string): string {
  return cmd
    .replace(/\r\n?/g, '\n')
    .replace(/^([ \t]*\n)+/, '')
    .replace(/(\n[ \t]*)+$/, '');
}

/** 名称、命令、分类、回车方式；id 和 updatedAt 由调用方给 */
function snippetFields(input: SnippetInput, groups: string[]): Omit<Snippet, 'id' | 'updatedAt'> {
  const noEnter = input.noEnter === true;
  return {
    name: input.name.trim() || defaultSnippetName(input.cmd),
    cmd: tidyCommand(input.cmd),
    group: resolveGroup(input.group, groups),
    ...(noEnter ? { noEnter } : {}),
  };
}

export function withSnippetAdded(data: SnippetData, input: SnippetInput, id: string, now: number): SnippetData {
  const snippet: Snippet = { id, ...snippetFields(input, data.groups), updatedAt: now };
  return { groups: withGroup(data.groups, snippet.group), snippets: [...data.snippets, snippet] };
}

export function withSnippetUpdated(data: SnippetData, id: string, input: SnippetInput, now: number): SnippetData {
  const fields = snippetFields(input, data.groups);
  return {
    groups: withGroup(data.groups, fields.group),
    snippets: data.snippets.map((s) => {
      if (s.id !== id) return s;
      // 取消勾选时要去掉旧记录上的 noEnter，所以不能直接在 s 上合并
      const { noEnter: _old, ...rest } = s;
      return { ...rest, ...fields, updatedAt: now };
    }),
  };
}

// ---------- 读写存储 ----------

/** 当前的数据，分类已和命令里引用到的合并 */
function current(): SnippetData {
  const snippets = snippetsStore.get();
  return { groups: listGroups(groupsStore.get(), snippets), snippets };
}

/**
 * 写回两份存储。分类清单每次都把合并后的整份写下来：老数据第一次改动后，
 * 只靠命令引用出来的分类也进了清单，删光里面的命令分类还在
 */
function commit(next: SnippetData): void {
  groupsStore.set(next.groups);
  snippetsStore.set(next.snippets);
}

/** 新建命令，返回新记录（分类可能被换成了第一个分类或默认分类） */
export function addSnippet(input: SnippetInput): Snippet {
  const id = newId('snp');
  const next = withSnippetAdded(current(), input, id, Date.now());
  commit(next);
  return next.snippets[next.snippets.length - 1]!;
}

export function updateSnippet(id: string, input: SnippetInput): void {
  commit(withSnippetUpdated(current(), id, input, Date.now()));
}

export function removeSnippet(id: string): void {
  const data = current();
  commit({ ...data, snippets: data.snippets.filter((s) => s.id !== id) });
}

/** 新建分类；名字不能用时什么都不做（界面先用 groupNameError 检查） */
export function addGroup(name: string): void {
  commit(withGroupAdded(current(), name));
}

export function renameGroup(from: string, to: string): void {
  commit(withGroupRenamed(current(), from, to, Date.now()));
}

export function removeGroup(name: string): void {
  commit(withGroupRemoved(current(), name));
}

/** 导入快捷命令用：读出当前数据，合并好再整份写回（components/panels/CommandImportDialog.tsx） */
export { current as currentSnippetData, commit as commitSnippetData };
