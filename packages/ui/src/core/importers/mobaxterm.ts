import { decodeText, extOf, fileName, iniGet, parseIni, parsePort, splitPath } from './text';
import { ResultBuilder, type ImportFile, type ImportResult } from './types';

// MobaXterm：.mxtsessions 导出文件和 MobaXterm.ini 的 [Bookmarks] 段是同一种格式。
// 每个 [Bookmarks_N] 段是一个文件夹：SubRep=路径（反斜杠分隔，空为根），ImgNum=图标；
// 其余行是 名称=#类型#图标%主机%端口%用户名%…，109 = SSH（依据 Devolutions 论坛贴出的导出样例和 mobaxterm-mcp 的解析器）。
// 第三个 % 字段之后的含义没有公开说明，只有像私钥路径的字段会记到备注里。

const SSH_TYPE = 109;

export function parseMobaXterm(files: ImportFile[]): ImportResult {
  const b = new ResultBuilder('mobaxterm');
  const candidates = files.filter((f) => ['mxtsessions', 'ini'].includes(extOf(f.path)));
  if (candidates.length === 0) {
    b.issue('', '未找到 .mxtsessions 或 MobaXterm.ini');
    return b.result;
  }

  let found = false;
  for (const f of candidates) {
    const sections = parseIni(decodeText(f.bytes));
    if (sections.some((s) => /^passwords$/i.test(s.name))) b.warn('MobaXterm 的密码单独加密保存，未导入，请在连接时输入');
    for (const sec of sections) {
      if (!/^bookmarks(_\d+)?$/i.test(sec.name)) continue;
      found = true;
      const parentId = b.folderFor(splitPath(iniGet(sec, 'SubRep') ?? ''));
      for (const [key, value] of sec.entries) {
        if (/^(SubRep|ImgNum)$/i.test(key)) continue;
        const where = `${fileName(f.path)} › ${key}`;
        const m = /^#(\d+)#\d*%?([^#]*)/.exec(value);
        if (!m) {
          b.issue(where, '无法识别的会话格式');
          continue;
        }
        const type = Number(m[1]);
        if (type !== SSH_TYPE) {
          b.issue(where, `不是 SSH 会话（类型 ${type}）`);
          continue;
        }
        const fields = m[2]!.split('%');
        const host = (fields[0] ?? '').trim();
        if (!host) {
          b.issue(where, '缺少主机');
          continue;
        }
        const keyPath = fields.slice(3).find((v) => /[\\/]/.test(v) && /\.(ppk|pem|key)$|id_(rsa|ed25519|ecdsa|dsa)$/i.test(v.trim()));
        b.addServer({
          parentId,
          name: key.trim(),
          host,
          port: parsePort(fields[1]) ?? 22,
          user: (fields[2] ?? '').trim(),
          note: keyPath ? `私钥：${keyPath.trim()}` : '',
          proto: 'ssh',
          auth: keyPath ? 'key' : 'password',
          keyLabel: keyPath ? fileName(keyPath.trim()) : null,
          password: null,
        });
      }
    }
  }
  if (!found) b.issue('', '未找到 [Bookmarks] 段');
  return b.result;
}
