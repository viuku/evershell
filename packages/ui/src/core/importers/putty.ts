import { decodeText, fileName, parsePort } from './text';
import { ResultBuilder, type ImportFile, type ImportResult } from './types';

// PuTTY：Windows 上会话在注册表 HKCU\Software\SimonTatham\PuTTY\Sessions\<名称> 下，
// 用 reg export 导出的 .reg 文件来导入；名称里字母数字和 +-.@_ 以外的字符都编码成 %XX（依据 PuTTY 文档和 .reg 导出样例）。
// Unix 版 PuTTY 的 ~/.putty/sessions/<名称> 是 键=值 文本，键名相同（依据 PuTTY 源码 unix/storage.c）。
// 只导入 Protocol 为 ssh 的会话；PuTTY 不保存密码。

type Values = Map<string, string>;

export function parsePuTTY(files: ImportFile[]): ImportResult {
  const b = new ResultBuilder('putty');
  if (files.length === 0) {
    b.issue('', '没有选择文件');
    return b.result;
  }
  for (const f of files) {
    const text = decodeText(f.bytes);
    const name = fileName(f.path);
    if (/^\s*(Windows Registry Editor|REGEDIT4)/i.test(text)) {
      let count = 0;
      for (const [session, values] of parseReg(text)) {
        addSession(b, `${name} › ${session}`, session, values);
        count++;
      }
      if (count === 0) b.issue(name, '文件里没有 PuTTY\\Sessions 下的会话');
    } else if (/^HostName=/m.test(text) || /^Protocol=/m.test(text)) {
      // Unix 版的单个会话文件，文件名就是会话名
      const values: Values = new Map();
      for (const line of text.split(/\r?\n/)) {
        const eq = line.indexOf('=');
        if (eq > 0) values.set(line.slice(0, eq), line.slice(eq + 1).replace(/\r$/, ''));
      }
      addSession(b, name, decodeSessionName(name), values);
    } else {
      b.issue(name, '不是 PuTTY 的 .reg 导出文件或会话文件');
    }
  }
  return b.result;
}

/** .reg 文本 → 会话名 → 键值 */
function parseReg(text: string): Map<string, Values> {
  const out = new Map<string, Values>();
  let current: Values | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      const path = line.slice(1, line.indexOf(']'));
      const m = /\\PuTTY\\Sessions\\([^\\]+)$/i.exec(path);
      current = null;
      if (m) {
        current = new Map();
        out.set(decodeSessionName(m[1]!), current);
      }
      continue;
    }
    if (!current) continue;
    const m = /^"((?:[^"\\]|\\.)*)"=(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.replace(/\\(.)/g, '$1');
    const value = m[2]!;
    const s = /^"((?:[^"\\]|\\.)*)"$/.exec(value);
    if (s) current.set(key, s[1]!.replace(/\\(.)/g, '$1'));
    else if (/^dword:/i.test(value)) current.set(key, String(parseInt(value.slice(6), 16)));
    // hex: 二进制值用不到
  }
  return out;
}

/** %XX → 字节 → UTF-8 */
export function decodeSessionName(raw: string): string {
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === '%' && /^[0-9a-f]{2}$/i.test(raw.slice(i + 1, i + 3))) {
      bytes.push(parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(...enc.encode(raw[i]!));
    }
  }
  return new TextDecoder('utf-8').decode(Uint8Array.from(bytes));
}

function addSession(b: ResultBuilder, where: string, session: string, v: Values): void {
  if (session === 'Default Settings') return;
  const proto = (v.get('Protocol') ?? 'ssh').toLowerCase();
  if (proto !== 'ssh') {
    b.issue(where, `协议不是 SSH（${proto}）`);
    return;
  }
  let host = (v.get('HostName') ?? '').trim();
  let user = (v.get('UserName') ?? '').trim();
  if (!host) {
    b.issue(where, '缺少 HostName');
    return;
  }
  // PuTTY 允许在主机栏写 user@host
  const at = host.lastIndexOf('@');
  if (at > 0) {
    if (!user) user = host.slice(0, at);
    host = host.slice(at + 1);
  }
  const notes: string[] = [];
  const keyFile = (v.get('PublicKeyFile') ?? '').trim();
  if (keyFile) notes.push(`私钥：${keyFile}`);
  const proxyHost = (v.get('ProxyHost') ?? '').trim();
  const proxyMethod = Number(v.get('ProxyMethod') ?? '0');
  if (proxyHost && proxyMethod > 0) notes.push(`PuTTY 代理：${proxyHost}${v.get('ProxyPort') ? `:${v.get('ProxyPort')}` : ''}`);
  b.addServer({
    name: session,
    host,
    port: parsePort(v.get('PortNumber')) ?? 22,
    user,
    note: notes.join('；'),
    proto: 'ssh',
    auth: keyFile ? 'key' : 'password',
    keyLabel: keyFile ? fileName(keyFile) : null,
    password: null,
  });
}
