import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../../types';
import { findClashes, foldersToCreate, topCount, withoutTop, type UploadItem } from '../upload-items';

const file = (path: string): UploadItem => ({ path, file: new File(['x'], path.split('/').pop()!) });
const dir = (path: string): UploadItem => ({ path, file: null });
const entry = (name: string, kind: FileEntry['kind']): FileEntry => ({ name, kind, size: 0, mtime: 0, perm: '', owner: '' });

// 拖进来一个文件夹 dist（里面有子文件夹和空文件夹）和两个文件
const items = [
  dir('dist'),
  file('dist/index.html'),
  dir('dist/js'),
  file('dist/js/app.js'),
  dir('dist/empty'),
  file('syslog'),
  file('deploy.tar.gz'),
];

describe('findClashes', () => {
  it('只比最上一层，文件夹对文件夹算合并', () => {
    const there = [entry('dist', 'dir'), entry('syslog', 'file'), entry('app.js', 'file')];
    expect(findClashes(items, there)).toEqual([
      { name: 'dist', merge: true },
      { name: 'syslog', merge: false },
    ]);
  });

  it('文件夹对同名文件不算合并（会报错，不会悄悄混在一起）', () => {
    expect(findClashes(items, [entry('dist', 'file')])).toEqual([{ name: 'dist', merge: false }]);
  });

  it('没有重名时为空', () => {
    expect(findClashes(items, [entry('other', 'file')])).toEqual([]);
  });
});

describe('withoutTop / topCount', () => {
  it('跳过整个同名文件夹连同里面的内容', () => {
    const rest = withoutTop(items, ['dist']);
    expect(rest.map((i) => i.path)).toEqual(['syslog', 'deploy.tar.gz']);
    expect(topCount(items)).toBe(3);
    expect(topCount(rest)).toBe(2);
  });
});

describe('foldersToCreate', () => {
  it('浅的在前，空文件夹也建', () => {
    expect(foldersToCreate(items)).toEqual(['dist', 'dist/js', 'dist/empty']);
  });

  it('只给了文件时补上所在的每一级', () => {
    expect(foldersToCreate([file('a/b/c.txt')])).toEqual(['a', 'a/b']);
  });

  it('只选了文件时不用建', () => {
    expect(foldersToCreate([file('x.txt')])).toEqual([]);
  });
});
