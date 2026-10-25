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
    blurb: '分类、命令和「不自动回车」一起导入',
    mac: '~/Library/FinalShell/config.json（访达里按 ⇧⌘G 输入路径）',
    windows: '%LOCALAPPDATA%\\finalshell\\config.json，和 conn 文件夹在同一个目录',
    pick: '选 config.json。只读里面的快捷命令，FinalShell 的其他设置和密码不读。',
    extensions: ['json'],
    // config.json 里还存着几千条历史命令，比一般的配置文件大
    maxBytes: 16 * 1024 * 1024,
    parse: parseFinalShellCommands,
  },
  {
    id: 'securecrt',
    label: 'SecureCRT',
    blurb: '按钮栏上发送文字的按钮，每个按钮栏变成一个分类',
    mac: '~/Library/Application Support/VanDyke/SecureCRT/Config/ButtonBarV5.ini',
    windows: '%APPDATA%\\VanDyke\\Config\\ButtonBarV5.ini；改过配置位置的，以「全局选项 → 配置路径」里写的为准',
    pick: '选 ButtonBarV5.ini。只导入发送文字的按钮；带暂停、粘贴剪贴板这类写法的，EverShell 做不到一样的效果，预览里默认不勾。',
    extensions: ['ini'],
    parse: parseSecureCrtCommands,
  },
  {
    id: 'electerm',
    label: 'Electerm',
    blurb: '选择从 Electerm 导出的快捷命令文件',
    mac: '在 Electerm 的设置 → 快捷命令里点导出，得到 electerm-quickCommands-日期.json',
    windows: '和 macOS 一样，在 Electerm 里导出',
    pick: '选导出的 .json 文件。标签变成分类，有几个标签的放进第一个；带按键、等待这类步骤的命令默认不勾。',
    extensions: ['json'],
    manualOnly: 'Electerm 的快捷命令要先导出成文件，再选这个文件',
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
