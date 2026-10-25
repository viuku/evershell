import { decodeText, fileName, parsePort } from './text';
import { ResultBuilder, type ImportFile, type ImportResult } from './types';

// OpenSSH ~/.ssh/config。依据 ssh_config(5)：关键字不分大小写，键值用空白或一个 = 分隔，含空格的值用双引号；
// Host 后可跟多个模式，* ? 通配、! 取反；Match 块按条件生效；Include 相对 ~/.ssh 展开、可带通配；
// 同一关键字以文件里第一次出现的值为准（所以通配 Host 块里的值也会落到具体主机上）。
// 带通配符的 Host 不单独生成连接，Match 块跳过，Include 只提醒不展开。

interface Block {
  /** null 表示文件开头的全局设置，总是匹配 */
  patterns: string[] | null;
  settings: Map<string, string[]>;
}

function tokenize(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '"') {
      quoted = !quoted;
      has = true;
    } else if (!quoted && c === '#') {
      break;
    } else if (!quoted && /\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/** 关键字和第一个参数之间允许 key=value 写法 */
function splitKeyword(line: string): [string, string[]] | null {
  const m = /^\s*([A-Za-z][A-Za-z0-9]*)\s*(?:=\s*|\s+)(.*)$/.exec(line);
  if (!m) return null;
  return [m[1]!.toLowerCase(), tokenize(m[2]!)];
}

const hasWildcard = (p: string) => /[*?]/.test(p);

function patternToRegExp(p: string): RegExp {
  return new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

/** ssh 的 Host 匹配：任一取反模式命中则整体不匹配，否则任一正向模式命中即匹配 */
function matches(block: Block, alias: string): boolean {
  if (block.patterns === null) return true;
  let ok = false;
  for (const p of block.patterns) {
    if (p.startsWith('!')) {
      if (patternToRegExp(p.slice(1)).test(alias)) return false;
    } else if (patternToRegExp(p).test(alias)) ok = true;
  }
  return ok;
}

export function parseOpenSsh(files: ImportFile[]): ImportResult {
  const b = new ResultBuilder('openssh');
  if (files.length === 0) {
    b.issue('', '未选择文件');
    return b.result;
  }

  for (const f of files) {
    const name = fileName(f.path);
    const blocks: Block[] = [{ patterns: null, settings: new Map() }];
    let skipping = false;
    let sawKeyword = false;

    for (const line of decodeText(f.bytes).split(/\r?\n/)) {
      const kv = splitKeyword(line);
      if (!kv) continue;
      const [key, args] = kv;
      sawKeyword = true;
      if (key === 'host') {
        skipping = false;
        blocks.push({ patterns: args, settings: new Map() });
        continue;
      }
      if (key === 'match') {
        skipping = true;
        b.warn(`${name}：Match 块（${args.join(' ')}）无法在导入时判断，已跳过`);
        continue;
      }
      if (key === 'include') {
        b.warn(`${name}：Include ${args.join(' ')} 未展开，请单独导入这些文件`);
        continue;
      }
      if (skipping) continue;
      const cur = blocks[blocks.length - 1]!;
      cur.settings.set(key, [...(cur.settings.get(key) ?? []), ...args]);
    }

    if (!sawKeyword) {
      b.issue(name, '不是 ssh config 文件');
      continue;
    }

    const aliases: string[] = [];
    for (const block of blocks) {
      for (const p of block.patterns ?? []) {
        if (p.startsWith('!') || hasWildcard(p)) {
          if (!p.startsWith('!')) b.warn(`${name}：Host ${p} 含通配符，未生成连接（其设置将应用于匹配的主机）`);
          continue;
        }
        if (!aliases.includes(p)) aliases.push(p);
      }
    }
    if (aliases.length === 0 && blocks.length > 1) b.issue(name, '所有 Host 均含通配符，没有可导入的主机');

    for (const alias of aliases) {
      // 第一次出现的值生效；IdentityFile 可以有多个，全部收集
      const first = (key: string): string | undefined => {
        for (const block of blocks) if (matches(block, alias) && block.settings.has(key)) return block.settings.get(key)![0];
        return undefined;
      };
      const identities: string[] = [];
      for (const block of blocks) if (matches(block, alias)) identities.push(...(block.settings.get('identityfile') ?? []));

      const notes: string[] = [];
      if (identities.length > 0) notes.push(`IdentityFile：${identities.join(', ')}`);
      const jump = first('proxyjump');
      if (jump && jump.toLowerCase() !== 'none') notes.push(`ProxyJump：${jump}`);
      const proxyCommand = first('proxycommand');
      if (proxyCommand) notes.push('包含 ProxyCommand，未导入');
      const useKey = identities.length > 0 && identities[0]!.toLowerCase() !== 'none';

      b.addServer({
        name: alias,
        host: first('hostname') ?? alias,
        port: parsePort(first('port')) ?? 22,
        user: first('user') ?? '',
        note: notes.join('；'),
        proto: 'ssh',
        auth: useKey ? 'key' : 'password',
        keyLabel: useKey ? fileName(identities[0]!) : null,
        password: null,
      });
    }
  }
  return b.result;
}
