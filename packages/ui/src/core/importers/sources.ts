import { parseEverShell } from './evershell';
import { parseFinalShell } from './finalshell';
import { parseMobaXterm } from './mobaxterm';
import { parseOpenSsh } from './openssh';
import { parsePuTTY } from './putty';
import { parseSecureCRT } from './securecrt';
import type { ImportSource, Parser } from './types';
import { parseXshell } from './xshell';

// 各来源的说明文案和解析器。路径和操作步骤都查过公开资料，具体依据写在各解析器文件头部。

export interface SourceInfo {
  id: ImportSource;
  label: string;
  /** 选来源那一步的一句话 */
  blurb: string;
  /** 配置文件在哪、要选什么 */
  mac: string;
  windows: string;
  pick: string;
  /** 文件选择器限制的扩展名；空表示不限 */
  extensions: string[];
  /** 这个来源通常要选整个文件夹 */
  directory: boolean;
  parse: Parser;
  /** 新建导入文件夹的默认名 */
  folderName: string;
}

export const SOURCES: SourceInfo[] = [
  {
    id: 'finalshell',
    label: 'FinalShell',
    blurb: '选择 conn 文件夹，连接、分组和密码一起导入',
    mac: '~/Library/FinalShell/conn（访达里按 ⇧⌘G 输入路径）',
    windows: '%LOCALAPPDATA%\\finalshell\\conn，即 C:\\Users\\<用户名>\\AppData\\Local\\finalshell\\conn；旧版本在 FinalShell 安装目录下的 conn',
    pick: '选择整个 conn 文件夹。里面的 *_connect_config.json 是连接，其余 JSON 记录是分组；保存的密码会一起导入，加密保存在本机。',
    extensions: ['json'],
    directory: true,
    parse: parseFinalShell,
    folderName: '从 FinalShell 导入',
  },
  {
    id: 'xshell',
    label: 'Xshell',
    blurb: '选择 Sessions 文件夹里的 .xsh 会话文件，子文件夹保留',
    mac: 'Xshell 没有 macOS 版本',
    windows: '文档\\NetSarang Computer\\<版本号>\\Xshell\\Sessions（Xshell 的「工具 → 选项」里可以看到会话目录）',
    pick: '选择 Sessions 文件夹，子文件夹会成为连接文件夹；也可以只多选几个 .xsh 文件。只导入 SSH 会话；密码与 Windows 账户绑定，无法导入。',
    extensions: ['xsh'],
    directory: true,
    parse: parseXshell,
    folderName: '从 Xshell 导入',
  },
  {
    id: 'mobaxterm',
    label: 'MobaXterm',
    blurb: '选择导出的 .mxtsessions 文件或 MobaXterm.ini，只导入 SSH 会话',
    mac: 'MobaXterm 没有 macOS 版本',
    windows:
      '在左侧 Sessions 面板右键「User sessions」→ 导出全部会话，得到 .mxtsessions 文件；或直接选 MobaXterm.ini（安装版在 %APPDATA%\\MobaXterm\\，便携版和 MobaXterm.exe 同目录）',
    pick: '选 .mxtsessions 或 MobaXterm.ini。文件夹层级保留；只导入 SSH 会话，密码不导入。',
    extensions: ['mxtsessions', 'ini'],
    directory: false,
    parse: parseMobaXterm,
    folderName: '从 MobaXterm 导入',
  },
  {
    id: 'putty',
    label: 'PuTTY',
    blurb: '选择注册表导出的 .reg 文件，只导入 SSH 会话',
    mac: 'Homebrew 版 PuTTY 的会话在 ~/.putty/sessions/（或 ~/.config/putty/sessions/）下，每个会话一个文件，直接多选这些文件',
    windows: '在命令提示符运行 reg export HKCU\\Software\\SimonTatham\\PuTTY\\Sessions putty-sessions.reg，然后选生成的 .reg 文件',
    pick: '选 .reg 文件（或 Unix 版的会话文件）。只导入协议为 SSH 的会话；PuTTY 不保存密码，私钥路径记在备注里。',
    extensions: [],
    directory: false,
    parse: parsePuTTY,
    folderName: '从 PuTTY 导入',
  },
  {
    id: 'securecrt',
    label: 'SecureCRT',
    blurb: '选择 Config/Sessions 文件夹里的 .ini 会话文件，子文件夹保留',
    mac: '~/Library/Application Support/VanDyke/SecureCRT/Config/Sessions',
    windows: '%APPDATA%\\VanDyke\\Config\\Sessions（旧版本在 Application Data\\VanDyke\\SecureCRT\\Config\\Sessions；以「全局选项 → 配置路径」显示的配置文件夹为准）',
    pick: '选择 Sessions 文件夹，子文件夹会成为连接文件夹。只导入 SSH 会话；密码加密保存，不导入。',
    extensions: ['ini'],
    directory: true,
    parse: parseSecureCRT,
    folderName: '从 SecureCRT 导入',
  },
  {
    id: 'openssh',
    label: 'OpenSSH（~/.ssh/config）',
    blurb: '导入 config 里的 Host 条目，带通配符的跳过',
    mac: '~/.ssh/config（访达里按 ⇧⌘G 输入 ~/.ssh；文件没有扩展名，选择时可能要切到「所有文件」）',
    windows: 'C:\\Users\\<用户名>\\.ssh\\config',
    pick: '选 config 文件。HostName、Port、User、IdentityFile、ProxyJump 会读取；带通配符的 Host 和 Match 块跳过，Include 不展开。',
    extensions: [],
    directory: false,
    parse: parseOpenSsh,
    folderName: '从 OpenSSH 导入',
  },
  {
    id: 'evershell',
    label: 'EverShell 导出文件',
    blurb: '导回之前用「导出」保存的 .json 文件',
    mac: '之前导出时保存的位置，默认在「下载」文件夹',
    windows: '之前导出时保存的位置，默认在「下载」文件夹',
    pick: '选 evershell-connections-*.json。文件夹层级和连接设置原样恢复；导出文件不含密码和私钥。',
    extensions: ['json'],
    directory: false,
    parse: parseEverShell,
    folderName: '从 EverShell 导入',
  },
];

export function sourceInfo(id: ImportSource): SourceInfo {
  return SOURCES.find((s) => s.id === id)!;
}
