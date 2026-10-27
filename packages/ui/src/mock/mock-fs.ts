import type { FileEntry, PermScope } from '../types';
import { basename, joinPath, normalizePath, parentPath } from '../core/paths';
import { formatPerm } from '../core/permissions';

// 内存里的假文件树，给 Mock 后端的 SFTP 和假 shell 共用

export interface MockFile {
  kind: 'file' | 'link';
  size: number;
  mtime: number;
  perm: string;
  owner: string;
  content: string | null;
}

export interface MockDir {
  kind: 'dir';
  mtime: number;
  perm: string;
  owner: string;
  children: Map<string, MockNode>;
}

export type MockNode = MockFile | MockDir;

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);

/** 假服务器上用户组照常见的 Linux：syslog 在 adm 组，其余和用户同名 */
function groupOf(owner: string): string {
  return owner === 'syslog' ? 'adm' : owner;
}

function dir(owner: string, children: Record<string, MockNode> = {}, perm = 'drwxr-xr-x', ageDays = 30): MockDir {
  return { kind: 'dir', mtime: now - ageDays * DAY, perm, owner, children: new Map(Object.entries(children)) };
}

function file(size: number, owner: string, perm = '-rw-r--r--', ageDays = 10, content: string | null = null): MockFile {
  return { kind: 'file', size, mtime: now - ageDays * DAY, perm, owner, content };
}

/** 有内容的文本文件，大小按内容算 */
function text(content: string, owner: string, perm = '-rw-r--r--', ageDays = 10): MockFile {
  return file(new TextEncoder().encode(content).length, owner, perm, ageDays, content);
}

const NGINX_CONF = `user www-data;
worker_processes auto;
pid /run/nginx.pid;
include /etc/nginx/modules-enabled/*.conf;

events {
    worker_connections 768;
}

http {
    sendfile on;
    tcp_nopush on;
    types_hash_max_size 2048;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    # 日志
    access_log /var/log/nginx/access.log;
    error_log /var/log/nginx/error.log;

    gzip on;

    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
`;

const COMPOSE = `services:
  web:
    image: nginx:1.27
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./conf.d:/etc/nginx/conf.d:ro
    restart: unless-stopped
`;

/** 看后缀像二进制文件的，假内容里放 0 字节 */
const BINARY_EXT = /\.(gz|tgz|tar|zip|xz|bz2|png|jpe?g|gif|webp|ico|pdf|bin|so|deb|rpm|db|sqlite)$/i;

function link(owner: string): MockFile {
  return { kind: 'link', size: 0, mtime: now - 3 * DAY, perm: 'lrwxrwxrwx', owner, content: null };
}

export function homeTemplate(user: string): MockDir {
  return dir(
    user,
    {
      '.ssh': dir(user, { authorized_keys: file(412, user, '-rw-------', 20) }, 'drwx------', 14),
      app: dir(user, { 'index.js': file(2140, user, '-rw-r--r--', 3), 'package.json': file(680, user) }, 'drwxr-xr-x', 3),
      '.bashrc': file(3771, user, '-rw-r--r--', 45, '# ~/.bashrc\nexport PATH="$HOME/bin:$PATH"\nalias ll="ls -alF"\n'),
      '.profile': file(807, user, '-rw-r--r--', 45),
      'deploy.sh': file(1433, user, '-rwxr-xr-x', 3, '#!/bin/sh\nset -e\ndocker compose pull && docker compose up -d\n'),
      'notes.md': file(2260, user, '-rw-r--r--', 8, '# 运维笔记\n\n- 每周一检查磁盘\n- 日志在 /var/log/nginx\n'),
    },
    'drwxr-xr-x',
    1,
  );
}

export function createMockRoot(): MockDir {
  return dir('root', {
    bin: dir('root', {}, 'drwxr-xr-x', 45),
    boot: dir('root', {}, 'drwxr-xr-x', 45),
    data: dir('root', { backups: dir('root'), uploads: dir('www-data') }, 'drwxr-xr-x', 6),
    etc: dir('root', {
      nginx: dir('root', { 'nginx.conf': text(NGINX_CONF, 'root', '-rw-r--r--', 9), 'conf.d': dir('root') }, 'drwxr-xr-x', 9),
      ssh: dir('root', { sshd_config: file(3300, 'root', '-rw-r--r--', 27) }, 'drwxr-xr-x', 27),
      systemd: dir('root', {}, 'drwxr-xr-x', 45),
      crontab: file(1042, 'root', '-rw-r--r--', 32),
      fstab: file(612, 'root', '-rw-r--r--', 45),
      hostname: file(12, 'root', '-rw-r--r--', 45, 'prod-web-01\n'),
      hosts: file(221, 'root', '-rw-r--r--', 29, '127.0.0.1 localhost\n10.0.1.12 prod-web-01\n'),
    }),
    home: dir('root', {}, 'drwxr-xr-x', 45),
    opt: dir('root', {
      app: dir(
        'deploy',
        {
          releases: dir('deploy', {}, 'drwxr-xr-x', 3),
          shared: dir('deploy', {}, 'drwxr-xr-x', 42),
          current: link('deploy'),
          'docker-compose.yml': text(COMPOSE, 'deploy', '-rw-r--r--', 3),
          '.env.production': file(1130, 'deploy', '-rw-------', 15),
        },
        'drwxr-xr-x',
        3,
      ),
    }),
    root: dir('root', {}, 'drwx------', 5),
    usr: dir('root', {}, 'drwxr-xr-x', 45),
    var: dir('root', {
      lib: dir('root', { docker: dir('root', {}, 'drwx--x---', 6) }),
      log: dir(
        'root',
        {
          nginx: dir(
            'root',
            {
              'access.log': file(50_640_000, 'www-data', '-rw-r-----', 0),
              'error.log': file(217_000, 'www-data', '-rw-r-----', 0),
              'access.log.1.gz': file(6_400_000, 'www-data', '-rw-r-----', 1),
            },
            'drwxr-xr-x',
            0,
          ),
          journal: dir('root', {}, 'drwxr-sr-x', 45),
          apt: dir('root', {}, 'drwxr-xr-x', 7),
          syslog: file(2_200_000, 'syslog', '-rw-r-----', 0),
          'syslog.1': file(8_800_000, 'syslog', '-rw-r-----', 1),
          'auth.log': file(393_000, 'syslog', '-rw-r-----', 0),
          'kern.log': file(98_000, 'syslog', '-rw-r-----', 1),
          'dpkg.log': file(1_250_000, 'root', '-rw-r--r--', 7),
        },
        'drwxrwxr-x',
        0,
      ),
      www: dir('www-data', { html: dir('www-data', { 'index.html': file(612, 'www-data') }) }, 'drwxr-xr-x', 41),
    }),
  });
}

export class MockFs {
  readonly root: MockDir;

  constructor() {
    this.root = createMockRoot();
  }

  resolve(path: string): MockNode | null {
    const p = normalizePath(path);
    if (p === '/') return this.root;
    let cur: MockNode = this.root;
    for (const seg of p.split('/').slice(1)) {
      if (cur.kind !== 'dir') return null;
      const next = cur.children.get(seg);
      if (!next) return null;
      cur = next;
    }
    return cur;
  }

  dirOf(path: string): MockDir {
    const node = this.resolve(path);
    if (!node) throw new Error(`没有这个目录：${path}`);
    if (node.kind !== 'dir') throw new Error(`不是目录：${path}`);
    return node;
  }

  list(path: string): FileEntry[] {
    const d = this.dirOf(path);
    return [...d.children.entries()].map(([name, n]) => ({
      name,
      kind: n.kind,
      size: n.kind === 'dir' ? 4096 : n.size,
      mtime: n.mtime,
      perm: n.perm,
      owner: n.owner,
      group: groupOf(n.owner),
    }));
  }

  ensureHome(user: string): string {
    const home = user === 'root' ? '/root' : `/home/${user}`;
    if (!this.resolve(home)) {
      const parent = this.dirOf(parentPath(home) ?? '/');
      parent.children.set(basename(home), homeTemplate(user));
    }
    return home;
  }

  mkdir(path: string, owner: string): void {
    const parent = this.dirOf(parentPath(path) ?? '/');
    const name = basename(path);
    if (parent.children.has(name)) throw new Error(`已存在：${name}`);
    parent.children.set(name, dir(owner, {}, 'drwxr-xr-x', 0));
    parent.mtime = Math.floor(Date.now() / 1000);
  }

  remove(path: string): void {
    const parent = this.dirOf(parentPath(path) ?? '/');
    const name = basename(path);
    if (!parent.children.delete(name)) throw new Error(`没有这个文件：${name}`);
  }

  rename(from: string, to: string): void {
    const src = this.dirOf(parentPath(from) ?? '/');
    const node = src.children.get(basename(from));
    if (!node) throw new Error(`没有这个文件：${basename(from)}`);
    const dst = this.dirOf(parentPath(to) ?? '/');
    if (dst.children.has(basename(to))) throw new Error(`已存在：${basename(to)}`);
    src.children.delete(basename(from));
    dst.children.set(basename(to), node);
  }

  /** 上传：已有的文件保留权限和所有者（和真服务器上的上传一样）；content 是文本内容，二进制给 null */
  writeFile(path: string, size: number, owner: string, content: string | null = null): void {
    const parent = this.dirOf(parentPath(path) ?? '/');
    const old = parent.children.get(basename(path));
    const keep = old && old.kind === 'file' ? old : null;
    const next = file(size, keep?.owner ?? owner, keep?.perm ?? '-rw-r--r--', 0, content);
    // 真服务器的修改时间是秒，同一秒里连存两次也要能看出变了
    next.mtime = Math.max(Math.floor(Date.now() / 1000), (keep?.mtime ?? 0) + 1);
    parent.children.set(basename(path), next);
    parent.mtime = Math.floor(Date.now() / 1000);
  }

  /** touch：已有的只更新修改时间，没有就建一个空文件 */
  touch(path: string, owner: string): void {
    const node = this.resolve(path);
    if (node) node.mtime = Math.max(Math.floor(Date.now() / 1000), node.mtime + 1);
    else this.writeFile(path, 0, owner, '');
  }

  stat(path: string): FileEntry {
    const node = this.resolve(path);
    if (!node) throw new Error('文件不存在');
    const name = basename(path);
    return {
      name,
      kind: node.kind,
      size: node.kind === 'dir' ? 4096 : node.size,
      mtime: node.mtime,
      perm: node.perm,
      owner: node.owner,
      group: groupOf(node.owner),
    };
  }

  /** 改权限，范围同真服务器（core/sftp.rs 的 chmod）：递归时不碰符号链接 */
  chmod(path: string, mode: number, scope: PermScope): void {
    const node = this.resolve(path);
    if (!node) throw new Error('文件不存在');
    const set = (n: MockNode) => {
      n.perm = formatPerm(mode, n.kind);
    };
    if (scope === 'self' || node.kind !== 'dir') return set(node);
    const walk = (d: MockDir) => {
      for (const child of d.children.values()) {
        if (child.kind === 'dir') {
          walk(child);
          if (scope !== 'files') set(child);
        } else if (child.kind === 'file' && scope !== 'dirs') set(child);
      }
    };
    walk(node);
    if (scope !== 'files') set(node);
  }

  /** 文件夹里全部文件加起来多大，模拟下载文件夹时算进度用 */
  treeSize(path: string): number {
    const node = this.resolve(path);
    if (!node) throw new Error('文件不存在');
    if (node.kind !== 'dir') return node.size;
    let total = 0;
    for (const [name] of node.children) total += this.treeSize(joinPath(path, name));
    return total;
  }

  /** 编辑器读文件：有内容给内容，没有就编几行；看着像二进制的给带 0 字节的 */
  readBytes(path: string): Uint8Array {
    const node = this.resolve(path);
    if (!node) throw new Error('文件不存在');
    if (node.kind === 'dir') throw new Error('该路径是目录');
    if (node.content != null) return new TextEncoder().encode(node.content);
    if (BINARY_EXT.test(path)) return new Uint8Array(Math.min(node.size, 4096)).map((_, i) => i % 7);
    return new TextEncoder().encode(`# ${basename(path)}\n# 预览用的假内容，真服务器上是文件本来的内容\n`);
  }

  readFile(path: string): string {
    const node = this.resolve(path);
    if (!node) throw new Error(`cat: ${path}: No such file or directory`);
    if (node.kind === 'dir') throw new Error(`cat: ${path}: Is a directory`);
    return node.content ?? `[二进制内容，${node.size} 字节]\n`;
  }
}
