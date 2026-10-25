import { tidyCommand, type Snippet, type SnippetData } from '../../snippets-store';
import type { CommandImportResult, ImportedCommand } from './types';

// 把导入的快捷命令并进现有数据：纯函数，给定现有数据和勾选算出新的一份，界面只负责写回存储。

/** keep：保留原来的分类，同名的并进已有分类；one：都放进一个新分类 */
export type GroupMode = { kind: 'keep' } | { kind: 'one'; name: string };

export function targetGroup(c: ImportedCommand, mode: GroupMode): string {
  return mode.kind === 'one' ? mode.name : c.group;
}

/** 比较重复用：分类 + 存下来的命令文字 */
const keyOf = (group: string, cmd: string) => `${group}\u0000${tidyCommand(cmd)}`;

/**
 * 放到的分类里已经有内容一样的命令，返回这些导入命令的 id。
 * 比的是存下来的样子（换行统一、去掉首尾的空行，空格原样比），名字不同也算重复，名字一样内容不同不算
 */
export function findDuplicateCommands(existing: Snippet[], result: CommandImportResult, mode: GroupMode): Set<string> {
  const have = new Set(existing.map((s) => keyOf(s.group, s.cmd)));
  return new Set(result.commands.filter((c) => have.has(keyOf(targetGroup(c, mode), c.cmd))).map((c) => c.id));
}

export interface CommandMergeOutcome {
  data: SnippetData;
  added: number;
  /** 新建的分类，按加进去的顺序 */
  newGroups: string[];
  noEnter: number;
}

/** 只导入 selected 里的命令；分类加在现有清单后面，按来源里的顺序 */
export function mergeCommands(
  data: SnippetData,
  result: CommandImportResult,
  opts: { selected: ReadonlySet<string>; mode: GroupMode; now: number; newId: () => string },
): CommandMergeOutcome {
  const picked = result.commands.filter((c) => opts.selected.has(c.id));
  const groups = [...data.groups];
  const newGroups: string[] = [];
  const addGroup = (g: string) => {
    if (groups.includes(g)) return;
    groups.push(g);
    newGroups.push(g);
  };
  // 先按来源的分类顺序建分类，再放命令：命令在来源里的顺序和分类顺序不一定一致
  if (opts.mode.kind === 'one') {
    if (picked.length > 0) addGroup(opts.mode.name);
  } else {
    for (const g of result.groups) if (picked.some((c) => c.group === g)) addGroup(g);
  }

  const snippets: Snippet[] = picked.map((c) => ({
    id: opts.newId(),
    name: c.name,
    cmd: tidyCommand(c.cmd),
    group: targetGroup(c, opts.mode),
    updatedAt: opts.now,
    ...(c.noEnter ? { noEnter: true as const } : {}),
  }));
  return {
    data: { groups, snippets: [...data.snippets, ...snippets] },
    added: snippets.length,
    newGroups,
    noEnter: snippets.filter((s) => s.noEnter).length,
  };
}
