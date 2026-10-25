import { parseCrtIni } from '../securecrt';
import { decodeText, extOf, fileName } from '../text';
import type { ImportFile } from '../types';
import { CommandResultBuilder, type CommandImportResult } from './types';

// SecureCRT 的按钮栏：所有按钮栏都在 Config/ButtonBarV5.ini（8.7 起）里，每个按钮栏是一个 Z: 多行字符串：
//   Z:"<按钮栏名>"=<按钮数，十六进制>
//    SEND,<文字>,<按钮名>,,,0,4,
// 依据只有 VanDyke 的一个官方样例（https://www.vandyke.com/support/tips/import-a-single-button-bar-into-securecrt.html），
// 没在真实文件上核对过：后面几个字段的含义、文字里的逗号怎么写都不清楚，所以从右往左拆，
// 样例里的反斜杠看不出是一个还是两个，两种都认。规格见 docs/specs/command-import.md。

/** 按钮名后面固定的几个字段（,,,0,4） */
const TAIL_FIELDS = 4;

/** 能照样做到的转义；其余的（暂停、粘贴剪贴板、本机 IP 之类）EverShell 做不到 */
const PLAIN: Record<string, string> = { r: '\n', n: '\n', t: '\t', '\\': '\\' };
const SPECIAL = new Set(['p', 'v', 'b', 'e', 'a', 'c', 'i', 'l', 'm', 'u']);

interface Decoded {
  text: string;
  /** 用到的做不到的写法，如 \p */
  special: string[];
}

/** 把按钮文字里的转义换成真的字符；做不到的写法原样留着 */
export function decodeSendString(raw: string): Decoded {
  let text = '';
  const special: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c !== '\\' || i + 1 >= raw.length) {
      text += c;
      continue;
    }
    let j = i + 1;
    // 样例里是 \\r：两个反斜杠后面跟着转义字母时，当作一个
    if (raw[j] === '\\' && j + 1 < raw.length && (raw[j + 1]! in PLAIN || SPECIAL.has(raw[j + 1]!)) && raw[j + 1] !== '\\') j++;
    const e = raw[j]!;
    if (e in PLAIN) {
      text += PLAIN[e];
    } else if (SPECIAL.has(e) || /[0-7]/.test(e)) {
      text += `\\${e}`;
      const tag = /[0-7]/.test(e) ? '\\ooo' : `\\${e}`;
      if (!special.includes(tag)) special.push(tag);
    } else {
      text += `\\${e}`;
    }
    i = j;
  }
  return { text, special };
}

export function parseSecureCrtCommands(files: ImportFile[]): CommandImportResult {
  const b = new CommandResultBuilder('securecrt');
  let found = false;

  for (const f of files) {
    if (extOf(f.path) !== 'ini') continue;
    const file = fileName(f.path);
    for (const bar of parseCrtIni(decodeText(f.bytes)).values()) {
      if (bar.type !== 'Z') continue;
      found = true;
      const group = b.group(bar.name);
      for (const line of bar.lines) {
        const parts = line.split(',');
        if (parts[parts.length - 1] === '') parts.pop();
        if (parts.length < 3 + TAIL_FIELDS) {
          b.issue(file, `「${bar.name}」里有一行看不懂：${line.slice(0, 40)}`);
          continue;
        }
        const label = parts[parts.length - 1 - TAIL_FIELDS]!.trim();
        if (parts[0] !== 'SEND') {
          b.issue(file, `「${label || parts[0]}」不是发送文字的按钮，没有导入`);
          continue;
        }
        const { text, special } = decodeSendString(parts.slice(1, parts.length - 1 - TAIL_FIELDS).join(','));
        // SecureCRT 不会自己补回车，文字末尾带着回车的才是“发送后回车”
        const enter = text.endsWith('\n');
        b.add(
          {
            group,
            name: label,
            cmd: enter ? text.slice(0, -1) : text,
            noEnter: !enter,
            unsupported: special.length > 0 ? `用了 SecureCRT 专用的写法 ${special.join('、')}` : undefined,
          },
          file,
        );
      }
    }
  }

  if (!found) b.issue('', '没有找到按钮栏，请选择 SecureCRT 配置文件夹里的 ButtonBarV5.ini');
  return b.result;
}
