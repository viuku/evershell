import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImportFile } from '../types';

// 读 __fixtures__ 里的样例，模拟浏览器选文件 / 选文件夹得到的 ImportFile 列表

const ROOT = fileURLToPath(new URL('../__fixtures__/', import.meta.url));

/** 选整个文件夹：路径带所选文件夹名，和 webkitRelativePath 一样 */
export function loadDir(rel: string): ImportFile[] {
  const out: ImportFile[] = [];
  const walk = (abs: string, prefix: string) => {
    for (const name of readdirSync(abs).sort()) {
      const p = join(abs, name);
      if (statSync(p).isDirectory()) walk(p, `${prefix}/${name}`);
      else out.push({ path: `${prefix}/${name}`, bytes: new Uint8Array(readFileSync(p)) });
    }
  };
  walk(join(ROOT, rel), basename(rel));
  return out;
}

/** 单选文件：路径只有文件名 */
export function loadFile(rel: string): ImportFile {
  return { path: basename(rel), bytes: new Uint8Array(readFileSync(join(ROOT, rel))) };
}

export function textFile(path: string, text: string): ImportFile {
  return { path, bytes: new TextEncoder().encode(text) };
}
