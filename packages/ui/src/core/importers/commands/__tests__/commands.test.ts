import { describe, expect, it } from 'vitest';
import { DEFAULT_GROUP, type Snippet } from '../../../snippets-store';
import { loadDir, loadFile, textFile } from '../../__tests__/fixtures';
import { parseElectermCommands } from '../electerm';
import { parseFinalShellCommands } from '../finalshell';
import { decodeSendString, parseSecureCrtCommands } from '../securecrt';
import { findDuplicateCommands, mergeCommands } from '../merge';
import { firstFoundCommands, scanLocalCommands } from '../sources';
import type { CommandImportResult } from '../types';

const brief = (r: CommandImportResult) => r.commands.map((c) => `${c.group}|${c.name}|${c.cmd}|${c.noEnter ? '不回车' : '回车'}`);

describe('FinalShell', () => {
  const r = parseFinalShellCommands([loadFile('finalshell/config.json')]);

  it('分类和命令按 order 排，跳过删掉的和空命令', () => {
    expect(r.groups).toEqual(['常用', 'Docker', DEFAULT_GROUP, '空分类']);
    expect(brief(r)).toEqual([
      '常用|查看磁盘|df -h|回车',
      '常用|发布|cd /srv/app\ngit pull\nsystemctl restart app|回车',
      '常用|uptime|uptime|回车',
      'Docker|容器状态|docker ps|回车',
      'Docker|进容器|docker exec -it |不回车',
      `${DEFAULT_GROUP}|没分类名|whoami|回车`,
    ]);
    expect(r.issues).toEqual([{ file: 'config.json', message: '「空命令」的命令内容为空' }]);
  });

  it('只读 quick_commands：假密码、假私钥不出现在结果里', () => {
    const text = JSON.stringify(r);
    expect(text).not.toContain('FAKE');
    expect(text).not.toContain('假私钥');
  });

  it('选整个 FinalShell 文件夹也能找到 config.json，conn 里的连接文件不当命令', () => {
    expect(brief(parseFinalShellCommands(loadDir('finalshell')))).toEqual(brief(r));
  });

  it('文件里没有快捷命令时给出提示', () => {
    const none = parseFinalShellCommands([textFile('config.json', '{"theme":"default"}')]);
    expect(none.commands).toEqual([]);
    expect(none.issues).toEqual([{ file: '', message: '未找到快捷命令，请选择 FinalShell 的 config.json' }]);
  });
});

describe('SecureCRT 按钮栏', () => {
  const r = parseSecureCrtCommands([loadFile('securecrt/ButtonBarV5.ini')]);

  it('按钮栏变分类，末尾带回车的自动回车，文字里的逗号保留', () => {
    expect(r.groups).toEqual(['Default', '运维', 'Docker']);
    expect(brief(r)).toEqual([
      '运维|查看磁盘|df -h|回车',
      '运维|杀进程|kill -9 |不回车',
      '运维|发布|cd /srv/app\ngit pull\nsystemctl restart app|回车',
      '运维|带逗号|echo a,b|回车',
      '运维|enable|ena\n\\pFAKE_ENABLE_PASSWORD|回车',
      'Docker|容器状态|docker ps|回车',
    ]);
  });

  it('做不到的写法原样留着、记下原因；不是发送文字的按钮跳过', () => {
    expect(r.commands.find((c) => c.name === 'enable')?.unsupported).toBe('使用了 SecureCRT 专有语法：\\p');
    expect(r.commands.filter((c) => c.unsupported)).toHaveLength(1);
    expect(r.issues).toEqual([{ file: 'ButtonBarV5.ini', message: '「Highlight on/off」不是发送文字的按钮，未导入' }]);
  });

  it('转义：一个或两个反斜杠都认，\\\\ 是反斜杠，八进制算做不到', () => {
    expect(decodeSendString('ls\\r')).toEqual({ text: 'ls\n', special: [] });
    expect(decodeSendString('ls\\\\r')).toEqual({ text: 'ls\n', special: [] });
    expect(decodeSendString('a\\tb\\\\x')).toEqual({ text: 'a\tb\\x', special: [] });
    expect(decodeSendString('\\033[2J')).toEqual({ text: '\\033[2J', special: ['\\ooo'] });
  });

  it('文件里没有按钮栏时给出提示', () => {
    expect(parseSecureCrtCommands([textFile('Global.ini', 'S:"Foo"=bar\n')]).issues[0]?.message).toContain('ButtonBarV5.ini');
  });
});

describe('Electerm 导出文件', () => {
  const r = parseElectermCommands([loadFile('electerm/electerm-quickCommands-2026-10-25-10-00-00.json')]);

  it('第一个标签是分类，多步拼成多行，inputOnly 是不自动回车，老格式也认', () => {
    expect(brief(r)).toEqual([
      '常用|查看磁盘|df -h|回车',
      '部署|发布|cd /srv/app\ngit pull\nsystemctl restart app|回车',
      `${DEFAULT_GROUP}|杀进程|kill -9 |不回车`,
      `${DEFAULT_GROUP}|老格式|uptime|回车`,
      '常用|登录后等提示|su -|回车',
      '常用|贴剪贴板|echo {{clipboard}}|回车',
    ]);
    expect(r.warnings).toEqual(['部分命令带有多个标签，已放入第一个标签对应的分类']);
  });

  it('等待、输入框步骤和模板做不到，记下原因', () => {
    const odd = Object.fromEntries(r.commands.filter((c) => c.unsupported).map((c) => [c.name, c.unsupported]));
    expect(odd).toEqual({
      登录后等提示: '使用了 Electerm 专有功能：等待步骤、输入框步骤',
      贴剪贴板: '使用了 Electerm 专有功能：{{clipboard}} 等模板',
    });
  });

  it('不是 Electerm 的文件给出提示', () => {
    expect(parseElectermCommands([textFile('a.json', '{"quick_commands":[]}')]).issues[0]?.message).toContain('Electerm');
  });
});

describe('合并', () => {
  const r = parseFinalShellCommands([loadFile('finalshell/config.json')]);
  const all = new Set(r.commands.map((c) => c.id));
  const existing: Snippet[] = [
    { id: 'a', name: '磁盘', cmd: 'df -h', group: '常用', updatedAt: 1 },
    { id: 'b', name: '容器状态', cmd: 'docker ps -a', group: 'Docker', updatedAt: 1 },
  ];
  let seq = 0;
  const newId = () => `n${++seq}`;

  it('同分类同内容算重复，名字不同也算；名字一样内容不同不算', () => {
    const dup = findDuplicateCommands(existing, r, { kind: 'keep' });
    expect(r.commands.filter((c) => dup.has(c.id)).map((c) => c.name)).toEqual(['查看磁盘']);
    expect(findDuplicateCommands(existing, r, { kind: 'one', name: '从 FinalShell 导入' }).size).toBe(0);
  });

  it('保留原分类：同名的并进去，新分类按来源顺序加在后面，没勾命令的分类不建', () => {
    const out = mergeCommands({ groups: ['常用', 'Docker'], snippets: existing }, r, { selected: all, mode: { kind: 'keep' }, now: 9, newId });
    expect(out.data.groups).toEqual(['常用', 'Docker', DEFAULT_GROUP]);
    expect(out.newGroups).toEqual([DEFAULT_GROUP]);
    expect(out.added).toBe(6);
    expect(out.noEnter).toBe(1);
    expect(out.data.snippets.find((s) => s.name === '进容器')).toMatchObject({ cmd: 'docker exec -it ', group: 'Docker', noEnter: true, updatedAt: 9 });
    expect(out.data.snippets.find((s) => s.name === '查看磁盘')).not.toHaveProperty('noEnter');
  });

  it('都放进一个新分类；只导入勾选的', () => {
    const picked = new Set(r.commands.filter((c) => c.name !== '发布').map((c) => c.id));
    const out = mergeCommands({ groups: ['常用'], snippets: [] }, r, { selected: picked, mode: { kind: 'one', name: '从 FinalShell 导入' }, now: 9, newId });
    expect(out.data.groups).toEqual(['常用', '从 FinalShell 导入']);
    expect(out.data.snippets.map((s) => s.group)).toEqual(Array(5).fill('从 FinalShell 导入'));
  });

  it('什么都没勾就什么都不变', () => {
    const before = { groups: ['常用'], snippets: existing };
    const out = mergeCommands(before, r, { selected: new Set(), mode: { kind: 'one', name: 'x' }, now: 9, newId });
    expect(out.data).toEqual(before);
    expect(out.newGroups).toEqual([]);
  });
});

describe('一键导入的查找结果', () => {
  it('找到、空的、读不了分开；不认识的来源忽略', () => {
    const scan = scanLocalCommands([
      { source: 'finalshell', location: '~/Library/FinalShell/config.json', files: [loadFile('finalshell/config.json')], error: null },
      { source: 'termius', location: '~/x', files: [textFile('a', 'b')], error: null },
    ]);
    const fs = scan.get('finalshell');
    expect(fs?.state === 'found' && fs.result.commands.length).toBe(6);
    expect(firstFoundCommands(scan)).toBe('finalshell');
    expect([...scan.keys()]).toEqual(['finalshell']);

    const empty = scanLocalCommands([{ source: 'finalshell', location: 'l', files: [textFile('config.json', '{"quick_commands":[]}')], error: null }]);
    expect(empty.get('finalshell')).toEqual({ state: 'empty', location: 'l' });
    expect(scanLocalCommands([{ source: 'finalshell', location: 'l', files: [], error: '无读取权限' }]).get('finalshell')).toMatchObject({ state: 'error' });
    expect(firstFoundCommands(empty)).toBeNull();
  });
});
