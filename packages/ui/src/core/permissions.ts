import type { FileEntry } from '../types';

// 权限位在 drwxr-xr-x 这种写法、数字（755）和勾选框之间互转。
// SUID、SGID、粘滞位落在三组的执行位上：有执行权限时写 s / s / t，没有时写 S / S / T。

const SPECIAL = [0o4000, 0o2000, 0o1000] as const;
const SPECIAL_CHAR = ['s', 's', 't'] as const;

/** 'drwxr-sr-x' → 0o2755；认不出来（服务器给的 ---------- 以外的怪格式）返回 null */
export function parsePerm(perm: string): number | null {
  if (perm.length !== 10) return null;
  let mode = 0;
  for (let g = 0; g < 3; g++) {
    const [r, w, x] = perm.slice(1 + g * 3, 4 + g * 3);
    const shift = 6 - g * 3;
    if (r === 'r') mode |= 4 << shift;
    else if (r !== '-') return null;
    if (w === 'w') mode |= 2 << shift;
    else if (w !== '-') return null;
    const sp = SPECIAL_CHAR[g]!;
    if (x === 'x') mode |= 1 << shift;
    else if (x === sp) mode |= (1 << shift) | SPECIAL[g]!;
    else if (x === sp.toUpperCase()) mode |= SPECIAL[g]!;
    else if (x !== '-') return null;
  }
  return mode;
}

/** 0o2755 + 文件夹 → 'drwxr-sr-x' */
export function formatPerm(mode: number, kind: FileEntry['kind']): string {
  let out = kind === 'dir' ? 'd' : kind === 'link' ? 'l' : '-';
  for (let g = 0; g < 3; g++) {
    const shift = 6 - g * 3;
    out += mode & (4 << shift) ? 'r' : '-';
    out += mode & (2 << shift) ? 'w' : '-';
    const exec = (mode & (1 << shift)) !== 0;
    const sp = SPECIAL_CHAR[g]!;
    out += mode & SPECIAL[g]! ? (exec ? sp : sp.toUpperCase()) : exec ? 'x' : '-';
  }
  return out;
}

/** 0o755 → '755'；有特殊位时写四位：0o2755 → '2755' */
export function toOctal(mode: number): string {
  const low = (mode & 0o777).toString(8).padStart(3, '0');
  return mode & 0o7000 ? `${(mode >> 9) & 7}${low}` : low;
}

/** '755'、'0755'、'2755' → 数字；不是三四位八进制数时返回 null */
export function parseOctal(text: string): number | null {
  return /^[0-7]{3,4}$/.test(text.trim()) ? parseInt(text.trim(), 8) : null;
}

/** 常用权限，文件权限对话框里一键套用 */
export const PERM_PRESETS: readonly { mode: number; tip: string }[] = [
  { mode: 0o644, tip: '所有者可读写，其他用户只读' },
  { mode: 0o755, tip: '所有者可读写执行，其他用户可读和执行' },
  { mode: 0o600, tip: '仅所有者可读写' },
  { mode: 0o700, tip: '仅所有者可读写执行' },
];
