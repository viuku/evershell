import type { FileEntry } from '../types';
import { basename, normalizePath, parentPath } from '../core/paths';

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

function dir(owner: string, children: Record<string, MockNode> = {}, perm = 'drwxr-xr-x', ageDays = 30): MockDir {
  return { kind: 'dir', mtime: now - ageDays * DAY, perm, owner, children: new Map(Object.entries(children)) };
}

function file(size: number, owner: string, perm = '-rw-r--r--', ageDays = 10, content: string | null = null): MockFile {
  return { kind: 'file', size, mtime: now - ageDays * DAY, perm, owner, content };
}

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
      nginx: dir('root', { 'nginx.conf': file(1490, 'root', '-rw-r--r--', 9), 'conf.d': dir('root') }, 'drwxr-xr-x', 9),
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
          'docker-compose.yml': file(2870, 'deploy', '-rw-r--r--', 3),
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

  writeFile(path: string, size: number, owner: string): void {
    const parent = this.dirOf(parentPath(path) ?? '/');
    parent.children.set(basename(path), file(size, owner, '-rw-r--r--', 0));
    parent.mtime = Math.floor(Date.now() / 1000);
  }

  readFile(path: string): string {
    const node = this.resolve(path);
    if (!node) throw new Error(`cat: ${path}: No such file or directory`);
    if (node.kind === 'dir') throw new Error(`cat: ${path}: Is a directory`);
    return node.content ?? `[二进制内容，${node.size} 字节]\n`;
  }
}
