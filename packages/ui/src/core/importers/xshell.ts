import { decodeText, dirParts, extOf, fileName, iniGet, iniSection, parseIni, parsePort, stripCommonRoot, stripExt } from './text';
import { ResultBuilder, type ImportFile, type ImportResult } from './types';

// Xshell：每个会话一个 .xsh（INI），放在 文档\NetSarang Computer\<版本>\Xshell\Sessions 下，子目录就是文件夹。
// 字段依据 xpipe 项目 issue 里贴出的 .xsh 样例：[CONNECTION] Host / Port / Protocol，
// [CONNECTION:AUTHENTICATION] UserName / Password / UserKey。密码的加密与 Windows 账户绑定，不导入。

export function parseXshell(files: ImportFile[]): ImportResult {
  const b = new ResultBuilder('xshell');
  const sessions = stripCommonRoot(files.filter((f) => extOf(f.path) === 'xsh'));
  if (sessions.length === 0) {
    b.issue('', '没有找到 .xsh 会话文件');
    return b.result;
  }

  let savedPasswords = 0;
  for (const f of sessions) {
    const sections = parseIni(decodeText(f.bytes));
    const conn = iniSection(sections, 'CONNECTION');
    if (!conn) {
      b.issue(f.path, '没有 [CONNECTION] 段，不是 Xshell 会话文件');
      continue;
    }
    const proto = (iniGet(conn, 'Protocol') ?? '').trim();
    if (proto && !/^ssh/i.test(proto)) {
      b.issue(f.path, `协议不是 SSH（${proto}）`);
      continue;
    }
    const host = (iniGet(conn, 'Host') ?? '').trim();
    if (!host) {
      b.issue(f.path, '缺少 Host');
      continue;
    }
    const auth = iniSection(sections, 'CONNECTION:AUTHENTICATION');
    const userKey = (iniGet(auth, 'UserKey') ?? '').trim();
    if ((iniGet(auth, 'Password') ?? '').trim()) savedPasswords++;

    const notes: string[] = [];
    const desc = (iniGet(conn, 'Description') ?? '').trim();
    if (desc) notes.push(desc);
    if (userKey) notes.push(`Xshell 用户密钥：${userKey}（私钥请重新选择）`);

    b.addServer({
      parentId: b.folderFor(dirParts(f.path)),
      name: stripExt(fileName(f.path)),
      host,
      port: parsePort(iniGet(conn, 'Port')) ?? 22,
      user: (iniGet(auth, 'UserName') ?? '').trim(),
      note: notes.join('；'),
      proto: 'ssh',
      auth: userKey ? 'key' : 'password',
      keyLabel: null,
      password: null,
    });
  }
  if (savedPasswords > 0) b.warn(`${savedPasswords} 个会话保存了密码，但 Xshell 的密码加密与 Windows 账户绑定，无法导入，连接时再输入`);
  return b.result;
}
