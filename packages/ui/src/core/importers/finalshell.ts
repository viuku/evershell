import { decryptFinalShellPassword } from './finalshell-crypto';
import { decodeText, extOf, fileName, parsePort } from './text';
import { linkFolders, ResultBuilder, type ImportFile, type ImportResult } from './types';

// FinalShell：conn/ 目录下每个连接一个 <id>_connect_config.json，文件夹是同目录下没有 host 的 JSON 记录，
// 都靠 parent_id 挂到上级。字段名依据 FinalshellDecoderX 和 openfinalshell 的导入实现：
// name / host / port / user_name / password / description / parent_id / secret_key_id /
// authentication_type / terminal_encoding / conection_type（原软件就是这个拼写，100 = SSH）。

type Rec = Record<string, unknown>;

const SSH_TYPE = 100;
const ENCODINGS: Record<string, string> = { 'utf-8': 'UTF-8', utf8: 'UTF-8', gbk: 'GBK', gb2312: 'GBK', gb18030: 'GBK', big5: 'Big5' };

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);

export function parseFinalShell(files: ImportFile[]): ImportResult {
  const b = new ResultBuilder('finalshell');
  const folders: { id: string; name: string; parentId: string | null }[] = [];
  const conns: { rec: Rec; file: string }[] = [];
  let sawJson = false;

  for (const f of files) {
    if (extOf(f.path) !== 'json') continue;
    sawJson = true;
    const name = fileName(f.path);
    const isConn = /_connect_config\.json$/i.test(name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeText(f.bytes));
    } catch {
      if (isConn) b.issue(name, 'JSON 解析失败');
      continue;
    }
    for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
      if (!r || typeof r !== 'object') continue;
      const rec = r as Rec;
      if (isConn || typeof rec.host === 'string') conns.push({ rec, file: name });
      else if (typeof rec.id === 'string' && typeof rec.name === 'string' && rec.port === undefined) {
        folders.push({ id: rec.id, name: rec.name, parentId: str(rec.parent_id) || null });
      }
      // config.json、knownhosts.json 这类不是连接记录，忽略
    }
  }

  if (!sawJson) {
    b.issue('', '未找到 JSON 文件，请选择 FinalShell 的 conn 文件夹');
    return b.result;
  }

  const folderIds = linkFolders(b, folders);

  for (const { rec, file } of conns) {
    const type = num(rec.conection_type ?? rec.connection_type);
    if (type !== null && type !== SSH_TYPE) {
      b.issue(file, `不是 SSH 连接（conection_type=${type}）`);
      continue;
    }
    const host = str(rec.host)?.trim();
    if (!host) {
      b.issue(file, '缺少 host');
      continue;
    }
    const name = str(rec.name)?.trim() || host;
    const parentRaw = str(rec.parent_id);
    let parentId: string | null = null;
    if (parentRaw) {
      const mapped = folderIds.get(parentRaw);
      if (mapped) parentId = mapped;
      else b.warn('部分连接的上级文件夹不在所选目录中，已放入根目录');
    }

    const notes: string[] = [];
    const desc = str(rec.description)?.trim();
    if (desc) notes.push(desc);
    const keyId = str(rec.secret_key_id)?.trim();
    if (keyId) notes.push(`FinalShell 密钥 ID：${keyId}（请重新选择私钥）`);
    const auth = keyId && (num(rec.authentication_type) === 2 || !rec.password) ? 'key' : 'password';

    let password: string | null = null;
    const encrypted = str(rec.password)?.trim();
    if (encrypted) {
      try {
        password = decryptFinalShellPassword(encrypted);
      } catch {
        b.warn(`「${name}」的密码解密失败，请在连接时输入`);
      }
    }

    const encoding = ENCODINGS[(str(rec.terminal_encoding) ?? '').toLowerCase()];
    b.addServer({
      parentId,
      name,
      host,
      port: parsePort(str(rec.port)) ?? 22,
      user: str(rec.user_name)?.trim() ?? '',
      note: notes.join('；'),
      proto: 'ssh',
      auth,
      keyLabel: null,
      password,
      advanced: encoding ? { encoding } : undefined,
    });
  }

  return b.result;
}
