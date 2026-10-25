import { describe, expect, it } from 'vitest';
import { parseEverShell } from '../evershell';
import { parseFinalShell } from '../finalshell';
import { parseMobaXterm } from '../mobaxterm';
import { parseOpenSsh } from '../openssh';
import { decodeSessionName, parsePuTTY } from '../putty';
import { parseSecureCRT } from '../securecrt';
import { decodeText, parseIni, stripCommonRoot } from '../text';
import type { ImportResult, ImportedServer } from '../types';
import { parseXshell } from '../xshell';
import { loadDir, loadFile, textFile } from './fixtures';

const byName = (r: ImportResult, name: string): ImportedServer => {
  const s = r.servers.find((x) => x.name === name);
  if (!s) throw new Error(`没有 ${name}：${r.servers.map((x) => x.name).join(', ')}`);
  return s;
};

/** 连接所在文件夹的路径，形如 生产/华东 */
const pathOf = (r: ImportResult, s: ImportedServer): string => {
  const parts: string[] = [];
  for (let id = s.parentId; id; ) {
    const f = r.folders.find((x) => x.id === id)!;
    parts.unshift(f.name);
    id = f.parentId;
  }
  return parts.join('/');
};

describe('text helpers', () => {
  it('decodes BOM-less UTF-16LE, UTF-8 and GBK', () => {
    const utf16 = Buffer.from('Host=例子\r\n', 'utf16le');
    expect(decodeText(new Uint8Array(utf16))).toBe('Host=例子\r\n');
    expect(decodeText(new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), utf16])))).toBe('Host=例子\r\n');
    expect(decodeText(new TextEncoder().encode('\ufeffabc'))).toBe('abc');
    // GBK 编码的“生产”
    expect(decodeText(Uint8Array.from([0xc9, 0xfa, 0xb2, 0xfa]))).toBe('生产');
  });

  it('strips the selected root folder only when every path shares it', () => {
    const files = [textFile('Sessions/a.xsh', ''), textFile('Sessions/prod/b.xsh', '')];
    expect(stripCommonRoot(files).map((f) => f.path)).toEqual(['a.xsh', 'prod/b.xsh']);
    expect(stripCommonRoot([textFile('a.xsh', ''), textFile('b.xsh', '')]).map((f) => f.path)).toEqual(['a.xsh', 'b.xsh']);
  });

  it('parses ini with ; comments and = in values', () => {
    const s = parseIni('; c\n[A]\nk=v=w\n[B]\nx = 1\n');
    expect(s.map((x) => x.name)).toEqual(['', 'A', 'B']);
    expect(s[1]!.entries.get('k')).toBe('v=w');
    expect(s[2]!.entries.get('x')).toBe('1');
  });
});

describe('FinalShell', () => {
  const r = parseFinalShell(loadDir('finalshell/conn'));

  it('builds folders from parent_id and decrypts passwords', () => {
    expect(r.folders.map((f) => f.name).sort()).toEqual(['华东', '生产']);
    const web = byName(r, 'web-01');
    expect(pathOf(r, web)).toBe('生产/华东');
    expect(web).toMatchObject({ host: '192.0.2.10', port: 22, user: 'root', note: '前端节点', auth: 'password', password: 'Fake-Pass-1234!' });
    const db = byName(r, 'db-01');
    expect(pathOf(r, db)).toBe('生产');
    expect(db).toMatchObject({ port: 2222, user: 'dbadmin', password: '假密码-abc', advanced: { encoding: 'GBK' } });
  });

  it('marks key auth and keeps the key id in the note', () => {
    const bastion = byName(r, 'bastion');
    expect(bastion.auth).toBe('key');
    expect(bastion.password).toBeNull();
    expect(bastion.note).toContain('k9k9k9k9k9k9k9k9');
    expect(bastion.parentId).toBeNull();
  });

  it('reports non-SSH and broken files without failing the import', () => {
    expect(r.servers).toHaveLength(4);
    expect(r.issues.map((i) => i.file).sort()).toEqual(['d4e5f60718293041_connect_config.json', 'e5f6071829304152_connect_config.json']);
    expect(r.issues.find((i) => i.file.startsWith('d4'))!.message).toContain('conection_type=2');
    expect(r.issues.find((i) => i.file.startsWith('e5'))!.message).toContain('JSON');
  });

  it('puts orphans at root and warns about undecryptable passwords', () => {
    const orphan = byName(r, 'orphan');
    expect(orphan.parentId).toBeNull();
    expect(orphan.password).toBeNull();
    expect(r.warnings.some((w) => w.includes('orphan') && w.includes('解密失败'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('上级文件夹不在'))).toBe(true);
  });

  it('ignores config.json and complains when nothing is json', () => {
    const extra = parseFinalShell([...loadDir('finalshell/conn'), textFile('config.json', '{"secret_key_list":[],"version":1}')]);
    expect(extra.servers).toHaveLength(4);
    expect(extra.folders).toHaveLength(2);
    expect(parseFinalShell([textFile('readme.txt', 'x')]).issues[0]!.message).toContain('JSON');
  });
});

describe('Xshell', () => {
  const r = parseXshell(loadDir('xshell/Sessions'));

  it('reads host/port/user and keeps sub folders', () => {
    const web = byName(r, 'web-1');
    expect(web).toMatchObject({ host: '192.0.2.10', port: 22, user: 'deploy', note: '前端节点', password: null });
    expect(pathOf(r, web)).toBe('生产');
    const db = byName(r, 'db-1');
    expect(db).toMatchObject({ host: '198.51.100.20', port: 2222, user: 'dbadmin', auth: 'key' });
    expect(db.note).toContain('db-key');
    expect(db.parentId).toBeNull();
  });

  it('skips telnet and warns about saved passwords', () => {
    expect(r.servers).toHaveLength(2);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.message).toContain('TELNET');
    expect(r.warnings.some((w) => w.includes('1 个会话保存了密码'))).toBe(true);
  });

  it('accepts a UTF-16 file and rejects non-session files', () => {
    const utf16 = new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('[CONNECTION]\r\nHost=203.0.113.9\r\nPort=22\r\nProtocol=SSH\r\n', 'utf16le')]));
    const one = parseXshell([{ path: 'x.xsh', bytes: utf16 }]);
    expect(one.servers[0]).toMatchObject({ name: 'x', host: '203.0.113.9' });
    expect(parseXshell([textFile('a.xsh', '[TERMINAL]\nCodePage=65001\n')]).issues[0]!.message).toContain('[CONNECTION]');
    expect(parseXshell([textFile('a.txt', '')]).issues[0]!.message).toContain('.xsh');
  });
});

describe('MobaXterm', () => {
  const r = parseMobaXterm([loadFile('mobaxterm/sessions.mxtsessions')]);

  it('maps bookmarks sections to folders and reads SSH sessions', () => {
    expect(r.servers).toHaveLength(3);
    const web = byName(r, 'web-01');
    expect(web).toMatchObject({ host: '192.0.2.10', port: 22, user: 'deploy', parentId: null });
    const db = byName(r, 'db-01');
    expect(pathOf(r, db)).toBe('Azure/PRE');
    expect(db).toMatchObject({ host: '198.51.100.20', port: 2222, user: 'dbadmin' });
  });

  it('spots a private key path and skips non-SSH types', () => {
    const bastion = byName(r, 'bastion');
    expect(bastion.auth).toBe('key');
    expect(bastion.keyLabel).toBe('id_ed25519');
    expect(bastion.note).toContain('C:\\Users\\me\\.ssh\\id_ed25519');
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.file).toContain('old-switch');
    expect(r.issues[0]!.message).toContain('98');
  });

  it('complains when there is no bookmarks section', () => {
    expect(parseMobaXterm([textFile('MobaXterm.ini', '[Misc]\nx=1\n')]).issues[0]!.message).toContain('[Bookmarks]');
    expect(parseMobaXterm([textFile('a.txt', '')]).issues[0]!.message).toContain('.mxtsessions');
  });
});

describe('PuTTY', () => {
  const r = parsePuTTY([loadFile('putty/putty-sessions.reg')]);

  it('decodes session names', () => {
    expect(decodeSessionName('prod%20web')).toBe('prod web');
    expect(decodeSessionName('%E8%B7%B3%E6%9D%BF')).toBe('跳板');
    expect(decodeSessionName('plain')).toBe('plain');
  });

  it('reads the UTF-16 .reg export and skips Default Settings / non-ssh', () => {
    expect(r.servers.map((s) => s.name).sort()).toEqual(['db/01', 'prod web', '跳板']);
    expect(byName(r, 'prod web')).toMatchObject({ host: '192.0.2.10', port: 22, user: 'deploy', auth: 'password' });
    const db = byName(r, 'db/01');
    expect(db).toMatchObject({ host: '198.51.100.20', port: 2222, user: 'dbadmin', auth: 'key', keyLabel: 'db.ppk' });
    expect(db.note).toContain('C:\\Users\\me\\keys\\db.ppk');
    expect(byName(r, '跳板').note).toContain('proxy.example.com:3000');
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.message).toContain('serial');
  });

  it('reads unix-style session files and rejects other text', () => {
    const u = parsePuTTY([loadFile('putty/sessions/staging%20api')]);
    expect(u.servers[0]).toMatchObject({ name: 'staging api', host: '203.0.113.7', user: 'ci', auth: 'key', keyLabel: 'staging.ppk' });
    expect(parsePuTTY([textFile('notes.txt', 'hello')]).issues[0]!.message).toContain('不是 PuTTY');
    expect(parsePuTTY([textFile('x.reg', 'Windows Registry Editor Version 5.00\r\n[HKEY_CURRENT_USER\\Software\\Other]\r\n')]).issues[0]!.message).toContain('没有');
  });
});

describe('SecureCRT', () => {
  const r = parseSecureCRT(loadDir('securecrt/Sessions'));

  it('reads hex ports, multi-line descriptions and sub folders', () => {
    const web = byName(r, 'web-1');
    expect(web).toMatchObject({ host: '192.0.2.10', port: 22, user: 'deploy', auth: 'password', note: '前端节点 / 周末不要重启' });
    expect(pathOf(r, web)).toBe('生产');
    const bastion = byName(r, 'bastion');
    expect(bastion).toMatchObject({ host: 'bastion.example.com', port: 2222, user: 'ops', auth: 'key', keyLabel: 'id_ed25519' });
    expect(bastion.note).toContain('corp-jump');
    expect(bastion.note).toContain('/Users/me/.ssh/id_ed25519');
  });

  it('skips Default.ini, __FolderData__.ini and telnet', () => {
    expect(r.servers).toHaveLength(2);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]!.file).toContain('router.ini');
    expect(r.issues[0]!.message).toContain('Telnet');
  });

  it('rejects ini files without Protocol Name', () => {
    expect(parseSecureCRT([textFile('x.ini', '[Bookmarks]\nSubRep=\n')]).issues[0]!.message).toContain('Protocol Name');
    expect(parseSecureCRT([textFile('Default.ini', 'S:"Protocol Name"=SSH2\n')]).issues[0]!.message).toContain('未找到');
  });
});

describe('OpenSSH config', () => {
  const r = parseOpenSsh([loadFile('openssh/config')]);

  it('creates one connection per concrete alias', () => {
    expect(r.servers.map((s) => s.name)).toEqual(['web', 'db', 'db-alt', 'quoted host', 'bastion']);
    expect(byName(r, 'web')).toMatchObject({ host: '192.0.2.10', port: 22, user: 'deploy', auth: 'key', keyLabel: 'id_ed25519' });
    const db = byName(r, 'db');
    expect(db).toMatchObject({ host: '198.51.100.20', port: 2222, user: 'dbadmin', auth: 'key', keyLabel: 'db_ed25519' });
    expect(db.note).toContain('IdentityFile：~/.ssh/db_ed25519, ~/.ssh/db_rsa, ~/.ssh/id_ed25519');
    expect(db.note).toContain('ProxyJump：ops@bastion.example.com:22');
    expect(byName(r, 'quoted host').host).toBe('203.0.113.9');
  });

  it('applies first-match-wins including Host * defaults', () => {
    const bastion = byName(r, 'bastion');
    expect(bastion.user).toBe('fallback');
    expect(bastion.note).toContain('ProxyCommand');
  });

  it('warns about wildcards, Match and Include', () => {
    expect(r.warnings.some((w) => w.includes('*.example.com'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('Match'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('Include ~/.ssh/conf.d/*'))).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it('handles negation and empty files', () => {
    const neg = parseOpenSsh([textFile('config', 'Host a b !b\n  Port 2200\nHost b\n  HostName 192.0.2.2\n')]);
    expect(byName(neg, 'a').port).toBe(2200);
    expect(byName(neg, 'b').port).toBe(22);
    expect(parseOpenSsh([textFile('config', '# nothing\n')]).issues[0]!.message).toContain('不是 ssh config');
    expect(parseOpenSsh([textFile('config', 'Host *\n  User x\n')]).issues[0]!.message).toContain('通配符');
  });
});

describe('EverShell export file', () => {
  const r = parseEverShell([loadFile('evershell/evershell-connections-sample.json')]);

  it('restores folders, settings, forwards and jump references', () => {
    const web = byName(r, 'web-01');
    expect(pathOf(r, web)).toBe('生产/华东');
    expect(web.forwards).toHaveLength(1);
    expect(web.advanced?.jumpServerId).toBe(byName(r, 'bastion').id);
    expect(byName(r, 'db-01')).toMatchObject({ auth: 'key', keyLabel: 'db_ed25519', advanced: { encoding: 'GBK' } });
    expect(byName(r, 'bastion').advanced).toMatchObject({ proxy: 'socks5', proxyHost: 'proxy.example.com', keepAliveSecs: 60 });
    expect(r.issues).toHaveLength(0);
  });

  it('rejects foreign json and flags newer versions', () => {
    expect(parseEverShell([textFile('x.json', '{"a":1}')]).issues[0]!.message).toContain('format');
    expect(parseEverShell([textFile('x.json', '{')]).issues[0]!.message).toContain('JSON');
    const newer = parseEverShell([textFile('x.json', JSON.stringify({ format: 'evershell-connections', version: 9, folders: [], servers: [{ name: 'a', host: '192.0.2.1' }] }))]);
    expect(newer.servers).toHaveLength(1);
    expect(newer.warnings[0]).toContain('v9');
  });
});
