import { decodeText, dirParts, extOf, fileName, stripCommonRoot, stripExt } from './text';
import { ResultBuilder, type ImportFile, type ImportResult } from './types';

// SecureCRT：配置目录 Config/Sessions 下每个会话一个 .ini，子目录就是文件夹；__FolderData__.ini 和 Default.ini 不是会话。
// 行格式依据 VanDyke 官方脚本示例里的注释：S:"Protocol Name"=SSH2（字符串）、D:"[SSH2] Port"=00000016（8 位十六进制整数）；
// Z: 是多行字符串（先写行数，再逐行缩进一格），Description 用的就是它。密码加密保存，不导入。

interface CrtValue {
  type: 'S' | 'D' | 'Z' | 'B';
  text: string;
  lines: string[];
}

function parseCrtIni(text: string): Map<string, CrtValue> {
  const out = new Map<string, CrtValue>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([SDZB]):"([^"]+)"=(.*)$/.exec(lines[i]!.replace(/\r$/, ''));
    if (!m) continue;
    const type = m[1] as CrtValue['type'];
    const value: CrtValue = { type, text: m[3]!.trim(), lines: [] };
    if (type === 'Z') {
      let n = parseInt(value.text, 16);
      while (n-- > 0 && i + 1 < lines.length && /^\s/.test(lines[i + 1]!)) value.lines.push(lines[++i]!.replace(/^\s/, '').replace(/\r$/, ''));
    }
    out.set(m[2]!.toLowerCase(), value);
  }
  return out;
}

export function parseSecureCRT(files: ImportFile[]): ImportResult {
  const b = new ResultBuilder('securecrt');
  const sessions = stripCommonRoot(files.filter((f) => extOf(f.path) === 'ini' && !/^(__FolderData__|Default)\.ini$/i.test(fileName(f.path))));
  if (sessions.length === 0) {
    b.issue('', '没有找到会话 .ini 文件');
    return b.result;
  }

  for (const f of sessions) {
    const v = parseCrtIni(decodeText(f.bytes));
    const str = (k: string) => v.get(k.toLowerCase())?.text ?? '';
    const proto = str('Protocol Name');
    if (!proto) {
      b.issue(f.path, '没有 Protocol Name，不是 SecureCRT 会话文件');
      continue;
    }
    if (!/^ssh[12]?$/i.test(proto)) {
      b.issue(f.path, `协议不是 SSH（${proto}）`);
      continue;
    }
    const host = str('Hostname');
    if (!host) {
      b.issue(f.path, '缺少 Hostname');
      continue;
    }
    const portHex = str(`[${proto.toUpperCase()}] Port`) || str('[SSH2] Port');
    const port = /^[0-9a-f]{1,8}$/i.test(portHex) ? parseInt(portHex, 16) : 0;

    const notes: string[] = [];
    const desc = v.get('description')?.lines.map((l) => l.trim()).filter(Boolean) ?? [];
    if (desc.length > 0) notes.push(desc.join(' / '));
    const identity = str('Identity Filename V2');
    if (identity) notes.push(`私钥：${identity}`);
    const firewall = str('Firewall Name');
    if (firewall && !/^none$/i.test(firewall)) notes.push(`SecureCRT 防火墙 / 跳板：${firewall}`);

    b.addServer({
      parentId: b.folderFor(dirParts(f.path)),
      name: stripExt(fileName(f.path)),
      host,
      port: port > 0 && port <= 65535 ? port : 22,
      user: str('Username'),
      note: notes.join('；'),
      proto: 'ssh',
      auth: identity ? 'key' : 'password',
      keyLabel: identity ? fileName(identity.replace(/::.*$/, '')) : null,
      password: null,
    });
  }
  return b.result;
}
