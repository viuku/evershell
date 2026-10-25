import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GROUP,
  addGroup,
  addSnippet,
  currentGroup,
  defaultSnippetName,
  groupNameError,
  groupsStore,
  listGroups,
  removeGroup,
  removeSnippet,
  renameGroup,
  snippetsStore,
  tidyCommand,
  updateSnippet,
  withGroupAdded,
  withGroupRemoved,
  withGroupRenamed,
  withSnippetAdded,
  withSnippetUpdated,
  type Snippet,
  type SnippetData,
} from '../snippets-store';

const snip = (id: string, group: string, cmd = `echo ${id}`): Snippet => ({ id, name: id, cmd, group, updatedAt: 1 });

describe('listGroups', () => {
  it('老数据没有分类清单：按命令里出现的顺序列出', () => {
    expect(listGroups([], [snip('a', '常用'), snip('b', 'Docker'), snip('c', '常用')])).toEqual(['常用', 'Docker']);
  });

  it('清单在前，命令里引用到、清单里没有的补在后面', () => {
    const list = [snip('a', 'Docker'), snip('b', '部署'), snip('c', '防火墙')];
    expect(listGroups(['常用', 'Docker'], list)).toEqual(['常用', 'Docker', '部署', '防火墙']);
  });

  it('空分类照样列出', () => {
    expect(listGroups(['常用', '空的'], [snip('a', '常用')])).toEqual(['常用', '空的']);
  });
});

describe('currentGroup', () => {
  it('选中的还在就用它，不在了退回第一个', () => {
    expect(currentGroup(['a', 'b'], 'b')).toBe('b');
    expect(currentGroup(['a', 'b'], 'x')).toBe('a');
    expect(currentGroup(['a', 'b'], null)).toBe('a');
    expect(currentGroup([], 'x')).toBeNull();
  });
});

describe('groupNameError', () => {
  it('空名字和重名不行', () => {
    expect(groupNameError('  ', ['常用'])).toBe('请输入分类名称');
    expect(groupNameError(' 常用 ', ['常用'])).toBe('已有分类「常用」');
    expect(groupNameError('Docker', ['常用'])).toBeNull();
  });

  it('改名时保持原名不算重名', () => {
    expect(groupNameError('常用', ['常用', 'Docker'], '常用')).toBeNull();
    expect(groupNameError('Docker', ['常用', 'Docker'], '常用')).toBe('已有分类「Docker」');
  });
});

describe('分类的增删改（纯函数）', () => {
  const data: SnippetData = {
    groups: ['常用', 'Docker', '空的'],
    snippets: [snip('a', '常用'), snip('b', 'Docker'), snip('c', '常用')],
  };

  it('新建分类加在最后，重名的不加', () => {
    expect(withGroupAdded(data, ' 部署 ').groups).toEqual(['常用', 'Docker', '空的', '部署']);
    expect(withGroupAdded(data, 'Docker')).toBe(data);
    expect(withGroupAdded(data, '')).toBe(data);
  });

  it('改名：原位替换，引用它的命令一起改，别的不动', () => {
    const next = withGroupRenamed(data, '常用', '日常', 99);
    expect(next.groups).toEqual(['日常', 'Docker', '空的']);
    expect(next.snippets.map((s) => [s.id, s.group, s.updatedAt])).toEqual([
      ['a', '日常', 99],
      ['b', 'Docker', 1],
      ['c', '日常', 99],
    ]);
  });

  it('改成已有的名字、改成空、改不存在的分类：不变', () => {
    expect(withGroupRenamed(data, '常用', 'Docker', 99)).toBe(data);
    expect(withGroupRenamed(data, '常用', ' ', 99)).toBe(data);
    expect(withGroupRenamed(data, '没有', '新名字', 99)).toBe(data);
  });

  it('删除分类连同里面的命令', () => {
    const next = withGroupRemoved(data, '常用');
    expect(next.groups).toEqual(['Docker', '空的']);
    expect(next.snippets.map((s) => s.id)).toEqual(['b']);
  });

  it('新建命令：没指定分类放进第一个，全删光了放进默认分类并补进清单', () => {
    expect(withSnippetAdded(data, { name: 'x', cmd: 'ls', group: '' }, 'n', 5).snippets.at(-1)?.group).toBe('常用');
    const empty = withSnippetAdded({ groups: [], snippets: [] }, { name: 'x', cmd: 'ls', group: '' }, 'n', 5);
    expect(empty.groups).toEqual([DEFAULT_GROUP]);
    expect(empty.snippets).toEqual([{ id: 'n', name: 'x', cmd: 'ls', group: DEFAULT_GROUP, updatedAt: 5 }]);
  });

  it('没填名称用命令第一行', () => {
    expect(defaultSnippetName('  cd /opt/app\ngit pull\n')).toBe('cd /opt/app');
    expect(withSnippetAdded(data, { name: ' ', cmd: 'df -h', group: '常用' }, 'n', 5).snippets.at(-1)).toMatchObject({
      name: 'df -h',
      cmd: 'df -h',
    });
  });

  it('不自动回车：勾上才存这一项，取消勾选时去掉', () => {
    const added = withSnippetAdded(data, { name: '杀进程', cmd: 'kill -9', group: '常用', noEnter: true }, 'n', 5);
    expect(added.snippets.at(-1)).toEqual({ id: 'n', name: '杀进程', cmd: 'kill -9', group: '常用', updatedAt: 5, noEnter: true });
    const plain = withSnippetAdded(data, { name: 'x', cmd: 'ls', group: '常用', noEnter: false }, 'm', 5);
    expect(plain.snippets.at(-1)).not.toHaveProperty('noEnter');
    const off = withSnippetUpdated(added, 'n', { name: '杀进程', cmd: 'kill -9 1234', group: '常用' }, 6);
    expect(off.snippets.find((s) => s.id === 'n')).toEqual({ id: 'n', name: '杀进程', cmd: 'kill -9 1234', group: '常用', updatedAt: 6 });
  });

  it('空格按输入的原样保存，不加也不删，和回不回车无关', () => {
    for (const noEnter of [true, false]) {
      const typed = withSnippetAdded(data, { name: 'a', cmd: 'kill -9 ', group: '常用', noEnter }, 'a', 5);
      expect(typed.snippets.at(-1)?.cmd).toBe('kill -9 ');
      const bare = withSnippetAdded(data, { name: 'b', cmd: 'kill -9', group: '常用', noEnter }, 'b', 5);
      expect(bare.snippets.at(-1)?.cmd).toBe('kill -9');
    }
    // 取消勾选再保存，末尾的空格还在
    const on = withSnippetAdded(data, { name: 'c', cmd: 'grep ', group: '常用', noEnter: true }, 'c', 5);
    expect(withSnippetUpdated(on, 'c', { name: 'c', cmd: 'grep ', group: '常用' }, 6).snippets.at(-1)?.cmd).toBe('grep ');
  });
});

describe('tidyCommand', () => {
  it('换行统一成 \\n，只去掉开头和末尾多出来的空行', () => {
    expect(tidyCommand('\r\ncd /srv\r\ngit pull\r\n')).toBe('cd /srv\ngit pull');
    expect(tidyCommand('\n  \ndocker exec -it \n  \n')).toBe('docker exec -it ');
  });

  it('开头、末尾和中间的空格原样保留', () => {
    expect(tidyCommand('  df -h  ')).toBe('  df -h  ');
    expect(tidyCommand('kill -9 ')).toBe('kill -9 ');
    expect(tidyCommand('kill -9')).toBe('kill -9');
    expect(tidyCommand('if true; then\n  echo hi\nfi')).toBe('if true; then\n  echo hi\nfi');
  });
});

describe('读写存储', () => {
  beforeEach(() => {
    // 测试环境没有浏览器存储，两个 store 只在内存里
    groupsStore.set([]);
    snippetsStore.set([snip('a', '常用'), snip('b', 'Docker')]);
  });

  it('老用户第一次改动后，靠命令引用出来的分类写进清单；删光里面的命令分类还在', () => {
    removeSnippet('b');
    expect(groupsStore.get()).toEqual(['常用', 'Docker']);
    expect(snippetsStore.get().map((s) => s.id)).toEqual(['a']);
  });

  it('新建、改名、删除分类', () => {
    addGroup('部署');
    expect(groupsStore.get()).toEqual(['常用', 'Docker', '部署']);
    renameGroup('Docker', '容器');
    expect(groupsStore.get()).toEqual(['常用', '容器', '部署']);
    expect(snippetsStore.get().find((s) => s.id === 'b')?.group).toBe('容器');
    removeGroup('常用');
    expect(groupsStore.get()).toEqual(['容器', '部署']);
    expect(snippetsStore.get().map((s) => s.id)).toEqual(['b']);
  });

  it('分类全删光后新建命令进默认分类', () => {
    removeGroup('常用');
    removeGroup('Docker');
    expect(groupsStore.get()).toEqual([]);
    const s = addSnippet({ name: '磁盘', cmd: 'df -h', group: '' });
    expect(s.group).toBe(DEFAULT_GROUP);
    expect(groupsStore.get()).toEqual([DEFAULT_GROUP]);
  });

  it('编辑命令换分类，原分类留着', () => {
    updateSnippet('b', { name: '容器状态', cmd: 'docker ps', group: '常用' });
    expect(snippetsStore.get().find((s) => s.id === 'b')).toMatchObject({ name: '容器状态', group: '常用' });
    expect(listGroups(groupsStore.get(), snippetsStore.get())).toEqual(['常用', 'Docker']);
  });
});
