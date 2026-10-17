import type { ImportFile } from './types';

// 读文件和解析文本的小工具：编码探测、路径拆分、INI 解析。

function looksLikeUtf16le(bytes: Uint8Array): boolean {
  // 没有 BOM 的 UTF-16LE：ASCII 文本每个奇数位都是 0
  const n = Math.min(bytes.length, 512) & ~1;
  if (n < 4) return false;
  let zeros = 0;
  for (let i = 1; i < n; i += 2) if (bytes[i] === 0) zeros++;
  return zeros > (n / 2) * 0.6;
}

/** 按 BOM / 启发式判断编码：UTF-8、UTF-16、GBK（中文 Windows 上的旧文件） */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (looksLikeUtf16le(bytes)) return new TextDecoder('utf-16le').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    try {
      return new TextDecoder('gbk').decode(bytes);
    } catch {
      return new TextDecoder('utf-8').decode(bytes);
    }
  }
}

export function encodeUtf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** 同时接受 / 和 \，去掉空段和 . */
export function splitPath(path: string): string[] {
  return path.split(/[\\/]+/).filter((p) => p && p !== '.');
}

export function fileName(path: string): string {
  return splitPath(path).pop() ?? path;
}

export function stripExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

export function extOf(path: string): string {
  const name = fileName(path);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/**
 * 选整个文件夹时每个路径都以所选文件夹名开头，去掉这一层，
 * 剩下的目录层级才是来源软件自己的文件夹结构。
 */
export function stripCommonRoot(files: ImportFile[]): ImportFile[] {
  const parts = files.map((f) => splitPath(f.path));
  if (parts.length === 0 || parts.some((p) => p.length < 2)) return files;
  const root = parts[0]![0];
  if (!parts.every((p) => p[0] === root)) return files;
  return files.map((f, i) => ({ ...f, path: parts[i]!.slice(1).join('/') }));
}

/** 路径里除文件名之外的目录段 */
export function dirParts(path: string): string[] {
  return splitPath(path).slice(0, -1);
}

export interface IniSection {
  name: string;
  /** 保留原始大小写；用 iniGet 做不区分大小写的查找 */
  entries: Map<string, string>;
}

/** 通用 INI：[段] 和 键=值；只有 ; 开头算注释（MobaXterm 的值以 # 开头，不能把 # 当注释） */
export function parseIni(text: string): IniSection[] {
  const sections: IniSection[] = [];
  let cur: IniSection = { name: '', entries: new Map() };
  sections.push(cur);
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';')) continue;
    if (line.startsWith('[') && line.endsWith(']')) {
      cur = { name: line.slice(1, -1).trim(), entries: new Map() };
      sections.push(cur);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    cur.entries.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return sections;
}

export function iniGet(section: IniSection | undefined, key: string): string | undefined {
  if (!section) return undefined;
  const direct = section.entries.get(key);
  if (direct !== undefined) return direct;
  const lower = key.toLowerCase();
  for (const [k, v] of section.entries) if (k.toLowerCase() === lower) return v;
  return undefined;
}

export function iniSection(sections: IniSection[], name: string): IniSection | undefined {
  const lower = name.toLowerCase();
  return sections.find((s) => s.name.toLowerCase() === lower);
}

/** 端口字符串 → 1–65535 的整数，不合法返回 null */
export function parsePort(value: string | number | undefined | null): number | null {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : null;
}
