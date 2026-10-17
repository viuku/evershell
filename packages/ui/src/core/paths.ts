// 远程路径的字符串操作，统一用 POSIX 规则

export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

export function joinPath(dir: string, name: string): string {
  return normalizePath(`${dir}/${name}`);
}

export function parentPath(path: string): string | null {
  const p = normalizePath(path);
  if (p === '/') return null;
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

export function basename(path: string): string {
  const p = normalizePath(path);
  if (p === '/') return '/';
  return p.slice(p.lastIndexOf('/') + 1);
}

/** 从根到 path 自身的每一级：/a/b → ['/', '/a', '/a/b'] */
export function ancestors(path: string): string[] {
  const p = normalizePath(path);
  const out = ['/'];
  if (p === '/') return out;
  let cur = '';
  for (const seg of p.split('/').slice(1)) {
    cur += `/${seg}`;
    out.push(cur);
  }
  return out;
}

/** 文件名合法性：不能为空、不能含 /，不能是 . 或 .. */
export function isValidName(name: string): boolean {
  return name !== '' && name !== '.' && name !== '..' && !name.includes('/');
}
