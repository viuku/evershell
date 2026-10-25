import { decodeText, extOf, fileName } from '../text';
import type { ImportFile } from '../types';
import { CommandResultBuilder, type CommandImportResult } from './types';

// FinalShell：快捷命令在 config.json（和 conn 文件夹同一个目录）顶层的 quick_commands 里，
// 是分类数组：{ id, name, order, delete_time, commands: [{ id, name, command, append_cr, order, delete_time, … }] }。
// 字段名依据所有者机器上的 FinalShell 4.6.5（2026-10-25 只看了字段名和数量，没看内容）。
// config.json 里还有 FinalShell 自己的密码和私钥列表，这里只读 quick_commands，别的不碰。

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** 按 order 排，order 一样的保持文件里的顺序 */
function byOrder(list: Rec[]): Rec[] {
  return list.map((r, i) => ({ r, i })).sort((a, b) => num(a.r.order) - num(b.r.order) || a.i - b.i).map((x) => x.r);
}

/** delete_time 大于 0 的是删掉的（所有者的数据里没有，按字段名推测） */
const deleted = (r: Rec) => num(r.delete_time) > 0;

export function parseFinalShellCommands(files: ImportFile[]): CommandImportResult {
  const b = new CommandResultBuilder('finalshell');
  let found = false;

  for (const f of files) {
    if (extOf(f.path) !== 'json') continue;
    const name = fileName(f.path);
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeText(f.bytes));
    } catch {
      if (name === 'config.json') b.issue(name, 'JSON 解析失败');
      continue;
    }
    if (!isRec(parsed) || !Array.isArray(parsed.quick_commands)) continue;
    found = true;

    for (const g of byOrder(parsed.quick_commands.filter(isRec))) {
      if (deleted(g)) continue;
      const group = b.group(str(g.name));
      const cmds = Array.isArray(g.commands) ? g.commands.filter(isRec) : [];
      for (const c of byOrder(cmds)) {
        if (deleted(c)) continue;
        // 只有明确写了 append_cr: false 才是不自动回车，缺这一项的当作自动回车
        b.add({ group, name: str(c.name), cmd: str(c.command), noEnter: c.append_cr === false }, name);
      }
    }
  }

  if (!found) b.issue('', '没有找到快捷命令，请选择 FinalShell 的 config.json');
  return b.result;
}
