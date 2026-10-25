import { DEFAULT_GROUP, defaultSnippetName } from '../../snippets-store';
import type { ImportFile, ImportIssue } from '../types';

// 导入快捷命令：各来源解析器输出的统一结构。和导入连接一样，解析器都是纯函数，不碰 store。
// 规格见 docs/specs/command-import.md。

export type CommandSource = 'finalshell' | 'securecrt' | 'electerm';

export interface ImportedCommand {
  /** 本次导入里的临时编号，预览勾选用 */
  id: string;
  /** 分类名；来源的分类能嵌套时拼成「上级 / 下级」 */
  group: string;
  name: string;
  /** 换行统一成 \n */
  cmd: string;
  noEnter: boolean;
  /** 有来源专用、EverShell 做不到的写法时写原因；预览里标出来、默认不勾，命令原样保留 */
  unsupported?: string;
}

export interface CommandImportResult {
  source: CommandSource;
  /** 来源里的分类顺序 */
  groups: string[];
  commands: ImportedCommand[];
  /** 没导入的记录 */
  issues: ImportIssue[];
  /** 不影响导入的提醒，如命令里有来源专用的写法 */
  warnings: string[];
}

export type CommandParser = (files: ImportFile[]) => CommandImportResult;

export interface CommandInput {
  group: string;
  name: string;
  cmd: string;
  noEnter: boolean;
  unsupported?: string;
}

/** 攒结果用：分类按第一次出现的顺序记下，命令分配临时编号 */
export class CommandResultBuilder {
  readonly result: CommandImportResult;
  private seq = 0;

  constructor(source: CommandSource) {
    this.result = { source, groups: [], commands: [], issues: [], warnings: [] };
  }

  /** 记下一个分类（空分类也记，预览里不显示没有命令的分类）；返回整理后的名字 */
  group(name: string): string {
    const n = name.trim() || DEFAULT_GROUP;
    if (!this.result.groups.includes(n)) this.result.groups.push(n);
    return n;
  }

  /** 加一条命令；命令是空的记成问题，返回 null */
  add(input: CommandInput, file: string): ImportedCommand | null {
    const cmd = input.cmd.replace(/\r\n?/g, '\n');
    const name = input.name.trim();
    if (!cmd.trim()) {
      this.issue(file, `「${name || '未命名'}」的命令内容为空`);
      return null;
    }
    const c: ImportedCommand = {
      id: `c${++this.seq}`,
      group: this.group(input.group),
      name: name || defaultSnippetName(cmd),
      cmd,
      noEnter: input.noEnter,
      ...(input.unsupported ? { unsupported: input.unsupported } : {}),
    };
    this.result.commands.push(c);
    return c;
  }

  issue(file: string, message: string): void {
    this.result.issues.push({ file, message });
  }

  warn(message: string): void {
    if (!this.result.warnings.includes(message)) this.result.warnings.push(message);
  }
}
