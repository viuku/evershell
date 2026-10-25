import type { LocalConfigFiles } from '../../../types';
import type { LocalScan as ConnectionScan } from '../local';
import { parseElectermCommands } from './electerm';
import { parseFinalShellCommands } from './finalshell';
import { parseSecureCrtCommands } from './securecrt';
import type { CommandImportResult, CommandParser, CommandSource } from './types';

// 导入快捷命令的各来源：说明文案和解析器。路径和格式的依据写在各解析器文件头部。

export interface CommandSourceInfo {
  id: CommandSource;
  label: string;
  /** 选来源那一步的一句话 */
  blurb: string;
  mac: string;
  windows: string;
  /** 要选什么 */
  pick: string;
  /** 文件选择器限制的扩展名；空表示不限 */
  extensions: string[];
  /** 单个文件的上限，不写就用导入的默认上限（2 MB） */
  maxBytes?: number;
  /** 没有一键导入（要先在原软件里导出）时，来源页底部的说明 */
  manualOnly?: string;
  parse: CommandParser;
}

export const COMMAND_SOURCES: CommandSourceInfo[] = [
  {
    id: 'finalshell',
    label: 'FinalShell',
    blurb: '分类、命令和「不自动回车」设置一并导入',
    mac: '~/Library/FinalShell/config.json（可在访达中按 ⇧⌘G 输入路径）',
    windows: '%LOCALAPPDATA%\\finalshell\\config.json，与 conn 文件夹位于同一目录',
    pick: '选择 config.json。仅读取其中的快捷命令，不读取 FinalShell 的其他设置和密码。',
    extensions: ['json'],
    // config.json 里还存着几千条历史命令，比一般的配置文件大
    maxBytes: 16 * 1024 * 1024,
    parse: parseFinalShellCommands,
  },
  {
    id: 'securecrt',
    label: 'SecureCRT',
    blurb: '导入按钮栏中发送文字的按钮，每个按钮栏对应一个分类',
    mac: '~/Library/Application Support/VanDyke/SecureCRT/Config/ButtonBarV5.ini',
    windows: '%APPDATA%\\VanDyke\\Config\\ButtonBarV5.ini；如修改过配置位置，以「全局选项 → 配置路径」中的设置为准',
    pick: '选择 ButtonBarV5.ini。仅导入发送文字的按钮；包含暂停、粘贴剪贴板等语法的按钮，EverShell 无法实现相同效果，预览中默认不勾选。',
    extensions: ['ini'],
    parse: parseSecureCrtCommands,
  },
  {
    id: 'electerm',
    label: 'Electerm',
    blurb: '选择从 Electerm 导出的快捷命令文件',
    mac: '在 Electerm 的「设置 → 快捷命令」中单击导出，生成 electerm-quickCommands-日期.json',
    windows: '与 macOS 相同，在 Electerm 中导出',
    pick: '选择导出的 .json 文件。标签将转为分类，带有多个标签的命令放入第一个标签对应的分类；包含按键、等待等步骤的命令默认不勾选。',
    extensions: ['json'],
    manualOnly: 'Electerm 的快捷命令需先导出为文件，再选择该文件',
    parse: parseElectermCommands,
  },
];

export function commandSourceInfo(id: CommandSource): CommandSourceInfo {
  return COMMAND_SOURCES.find((s) => s.id === id)!;
}

/** 默认位置的查找结果，和导入连接的一样分四种；found 里带解析结果 */
export type CommandScan =
  | { state: 'found'; location: string; result: CommandImportResult }
  | Exclude<ConnectionScan, { state: 'found' }>;

/** 只收界面认识的来源；没出现的来源（网页端、本平台没有的软件）界面不提示 */
export function scanLocalCommands(list: LocalConfigFiles[]): Map<CommandSource, CommandScan> {
  const out = new Map<CommandSource, CommandScan>();
  for (const c of list) {
    const source = COMMAND_SOURCES.find((s) => s.id === c.source);
    if (!source || out.has(source.id)) continue;
    const { location } = c;
    if (c.error) {
      out.set(source.id, { state: 'error', location, message: c.error });
    } else if (c.files.length === 0) {
      out.set(source.id, { state: 'missing', location });
    } else {
      try {
        const result = source.parse(c.files);
        out.set(source.id, result.commands.length > 0 ? { state: 'found', location, result } : { state: 'empty', location });
      } catch (e) {
        out.set(source.id, { state: 'error', location, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return out;
}

/** 默认选中的来源：按来源列表的顺序，第一个找到命令的 */
export function firstFoundCommands(scan: Map<CommandSource, CommandScan>): CommandSource | null {
  return COMMAND_SOURCES.find((s) => scan.get(s.id)?.state === 'found')?.id ?? null;
}
