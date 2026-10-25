import { decodeText, extOf, fileName } from '../text';
import type { ImportFile } from '../types';
import { CommandResultBuilder, type CommandImportResult } from './types';

// Electerm：只读它自己导出的 electerm-quickCommands-<时间>.json（快捷命令设置里的导出按钮），
// 原始数据库和带密码的书签放在一起，不去碰。导出文件是一个数组，每项
//   { id 或 _id, name, commands: [{ command, enter?, delay, type? }], inputOnly, labels: [...], shortcut }
// 老格式没有 commands，只有一个 command 字符串。依据是 Electerm 源码（2026-10-25 的 master）：
// quick-command-transport-mod.jsx（导出）、default-quick-commands.js（字段）、quick-command-steps.js（步骤和回车）。

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 按键、等待文字、弹框输入这几种步骤 EverShell 做不到 */
const STEP_TYPES: Record<string, string> = { key: '按键', wait: '等待', prompt: '输入框' };
const TEMPLATE = /\{\{\s*(clipboard|time|date)\s*\}\}/;

export function parseElectermCommands(files: ImportFile[]): CommandImportResult {
  const b = new CommandResultBuilder('electerm');
  let found = false;

  for (const f of files) {
    if (extOf(f.path) !== 'json') continue;
    const file = fileName(f.path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeText(f.bytes));
    } catch {
      b.issue(file, 'JSON 解析失败');
      continue;
    }
    if (!Array.isArray(parsed) || !parsed.some((r) => isRec(r) && ('commands' in r || 'command' in r))) continue;
    found = true;

    for (const rec of parsed.filter(isRec)) {
      const steps = Array.isArray(rec.commands) && rec.commands.length > 0 ? rec.commands.filter(isRec) : rec.command ? [{ command: rec.command }] : [];
      // 步骤自己没写 enter 时看整条命令的 inputOnly，和 Electerm 一样
      const enterOf = (s: Rec) => (typeof s.enter === 'boolean' ? s.enter : rec.inputOnly !== true);
      const odd = new Set<string>();
      const lines: string[] = [];
      steps.forEach((s, i) => {
        const type = str(s.type);
        if (STEP_TYPES[type]) {
          odd.add(`有${STEP_TYPES[type]}步骤`);
          return;
        }
        if (i < steps.length - 1 && !enterOf(s)) odd.add('中间有不回车的步骤');
        lines.push(str(s.command));
      });
      const cmd = lines.join('\n');
      if (TEMPLATE.test(cmd)) odd.add('用了 {{clipboard}} 这类模板');
      const last = steps[steps.length - 1];

      const labels = Array.isArray(rec.labels) ? rec.labels.filter((l): l is string => typeof l === 'string' && l.trim() !== '') : [];
      if (labels.length > 1) b.warn('有的命令带了好几个标签，放进了第一个标签的分类');
      b.add(
        {
          group: labels[0] ?? '',
          name: str(rec.name),
          cmd,
          noEnter: last ? !enterOf(last) : false,
          unsupported: odd.size > 0 ? `用了 Electerm 专用的功能：${[...odd].join('、')}` : undefined,
        },
        file,
      );
    }
  }

  if (!found) b.issue('', '没有找到快捷命令，请选择从 Electerm 导出的 electerm-quickCommands-….json');
  return b.result;
}
