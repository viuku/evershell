import { describe, expect, it } from 'vitest';
import type { FileEntry, SshSession, TransferProgress } from '../../types';
import { EditorDocs } from '../editor-docs';
import { decodeText, EDIT_MAX_BYTES, encodeText, localChannelPair, RemoteEdit } from '../remote-edit';

const enc = (s: string) => new TextEncoder().encode(s);
/** 等消息在两头之间来回几趟 */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('decodeText', () => {
  it('普通文本', () => {
    expect(decodeText(enc('user www-data;\nworker_processes auto;\n'))).toEqual({
      text: 'user www-data;\nworker_processes auto;\n',
      eol: '\n',
      bom: false,
    });
  });

  it('Windows 换行统一成 \\n，记下来保存时换回去', () => {
    const d = decodeText(enc('a\r\nb\r\nc'));
    expect(d).toEqual({ text: 'a\nb\nc', eol: '\r\n', bom: false });
    expect(new TextDecoder().decode(encodeText(d!.text, d!.eol, d!.bom))).toBe('a\r\nb\r\nc');
  });

  it('换行混着的按多数算', () => {
    expect(decodeText(enc('a\nb\nc\r\nd'))?.eol).toBe('\n');
    expect(decodeText(enc('a\r\nb\r\nc\nd'))?.eol).toBe('\r\n');
  });

  it('BOM 去掉，保存时加回去', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...enc('中文')]);
    const d = decodeText(bytes);
    expect(d).toEqual({ text: '中文', eol: '\n', bom: true });
    expect([...encodeText(d!.text, d!.eol, d!.bom)]).toEqual([...bytes]);
  });

  it('有 0 字节或不是 UTF-8 的不当文本', () => {
    expect(decodeText(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))).toBeNull();
    expect(decodeText(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]))).toBeNull(); // GBK 的“你好”
  });

  it('空文件能打开', () => {
    expect(decodeText(new Uint8Array())).toEqual({ text: '', eol: '\n', bom: false });
  });
});

/** 只实现编辑器用到的几个方法 */
class FakeSession {
  files = new Map<string, { data: Uint8Array; mtime: number }>();
  uploads: string[] = [];
  clock = 1000;

  put(path: string, text: string | Uint8Array): void {
    this.files.set(path, { data: typeof text === 'string' ? enc(text) : text, mtime: ++this.clock });
  }

  stat = async (path: string): Promise<FileEntry> => {
    const f = this.files.get(path);
    if (!f) throw new Error('文件不存在');
    return { name: path.split('/').pop()!, kind: 'file', size: f.data.length, mtime: f.mtime, perm: '-rw-r--r--', owner: 'root' };
  };

  readFile = async (path: string, max: number, onProgress?: (p: TransferProgress) => void): Promise<Uint8Array> => {
    const f = this.files.get(path);
    if (!f) throw new Error('文件不存在');
    if (f.data.length > max) throw new Error('超过了上限');
    onProgress?.({ done: 0, total: f.data.length });
    onProgress?.({ done: f.data.length, total: f.data.length });
    return f.data;
  };

  /** 上传卡在一半，测进度用 */
  hold: Promise<void> | null = null;

  upload = async (path: string, data: Blob, onProgress?: (p: TransferProgress) => void): Promise<void> => {
    onProgress?.({ done: Math.floor(data.size / 2), total: data.size });
    if (this.hold) await this.hold;
    onProgress?.({ done: data.size, total: data.size });
    const text = await data.text();
    this.uploads.push(text);
    this.put(path, text);
  };

  asSession(): SshSession {
    return this as unknown as SshSession;
  }
}

function setup() {
  const fake = new FakeSession();
  const [mainPort, editorPort] = localChannelPair();
  let shown = 0;
  const saved: string[] = [];
  let connected = true;
  const main = new RemoteEdit(
    mainPort,
    (sid) => (sid === 's1' && connected ? { session: fake.asSession(), host: 'root@web-01' } : null),
    () => {
      shown++;
    },
    (_sid, path) => saved.push(path),
  );
  main.start();
  const dirty: boolean[] = [];
  const docs = new EditorDocs(editorPort, (d) => dirty.push(d));
  return {
    fake,
    main,
    docs,
    saved,
    dirty,
    shown: () => shown,
    disconnect: () => {
      connected = false;
    },
  };
}

describe('RemoteEdit 和 EditorDocs', () => {
  it('打开：编辑窗口准备好之前的消息先攒着', async () => {
    const t = setup();
    t.fake.put('/etc/nginx/nginx.conf', 'a\r\nb\r\n');
    expect(await t.main.open('s1', '/etc/nginx/nginx.conf')).toEqual({ kind: 'opened' });
    expect(t.shown()).toBe(1);
    await settle();
    expect(t.docs.store.get().tabs).toEqual([]);

    t.docs.start();
    await settle();
    const [tab] = t.docs.store.get().tabs;
    expect(tab).toMatchObject({ name: 'nginx.conf', path: '/etc/nginx/nginx.conf', host: 'root@web-01', eol: '\r\n', loadSeq: 1 });
    expect(t.docs.store.get().activeId).toBe(tab!.id);
    expect(t.docs.takeText(tab!.id)).toBe('a\nb\n');
    expect(t.docs.takeText(tab!.id)).toBeNull();
  });

  it('打开、保存、重新载入都报进度', async () => {
    const t = setup();
    t.docs.start();
    t.fake.put('/f', 'abcdefgh');
    const seen: number[] = [];
    await t.main.open('s1', '/f', (p) => seen.push(p.done));
    expect(seen).toEqual([0, 8]);
    await settle();
    const id = t.docs.store.get().activeId!;

    let release!: () => void;
    t.fake.hold = new Promise((r) => (release = r));
    t.docs.save(id, '12345678');
    expect(t.docs.store.get().tabs[0]).toMatchObject({ status: 'saving', progress: null });
    for (let i = 0; i < 5; i++) await settle();
    expect(t.docs.store.get().tabs[0]!.progress).toBe(0.5);
    release();
    for (let i = 0; i < 5; i++) await settle();
    expect(t.docs.store.get().tabs[0]).toMatchObject({ status: 'saved', progress: null });

    t.fake.hold = null;
    t.docs.reload(id);
    expect(t.docs.store.get().tabs[0]!.status).toBe('loading');
    for (let i = 0; i < 5; i++) await settle();
    expect(t.docs.store.get().tabs[0]).toMatchObject({ status: 'idle', progress: null, loadSeq: 2 });
  });

  it('同一个文件再打开只是切过去', async () => {
    const t = setup();
    t.docs.start();
    t.fake.put('/a', 'x');
    t.fake.put('/b', 'y');
    await t.main.open('s1', '/a');
    await t.main.open('s1', '/b');
    await settle();
    const [a] = t.docs.store.get().tabs;
    await t.main.open('s1', '//a');
    await settle();
    expect(t.docs.store.get().tabs).toHaveLength(2);
    expect(t.docs.store.get().activeId).toBe(a!.id);
    expect(t.main.openCount).toBe(2);
  });

  it('太大、不是文本的不打开', async () => {
    const t = setup();
    t.fake.put('/big', new Uint8Array(EDIT_MAX_BYTES + 1).fill(97));
    t.fake.put('/bin', new Uint8Array([1, 0, 2]));
    expect(await t.main.open('s1', '/big')).toEqual({ kind: 'too-large', size: EDIT_MAX_BYTES + 1 });
    expect(await t.main.open('s1', '/bin')).toEqual({ kind: 'not-text' });
    expect(t.main.openCount).toBe(0);
    await expect(t.main.open('s2', '/big')).rejects.toThrow('会话未连接');
  });

  it('保存：换行符换回去，上传后状态变成已保存', async () => {
    const t = setup();
    t.docs.start();
    t.fake.put('/etc/hosts', 'a\r\n');
    await t.main.open('s1', '/etc/hosts');
    await settle();
    const id = t.docs.store.get().activeId!;
    t.docs.setDirty(id, true);
    expect(t.dirty.at(-1)).toBe(true);
    t.docs.save(id, 'a\nb\n');
    expect(t.docs.store.get().tabs[0]!.status).toBe('saving');
    await settle();
    await settle();
    expect(t.fake.uploads).toEqual(['a\r\nb\r\n']);
    expect(t.docs.store.get().tabs[0]).toMatchObject({ status: 'saved', error: null });
    expect(t.saved).toEqual(['/etc/hosts']);

    // 刚存过再存不算冲突（记下了新的修改时间）
    t.docs.save(id, 'c\n');
    await settle();
    await settle();
    expect(t.fake.uploads).toHaveLength(2);
  });

  it('服务器上的文件被别人改过：先问，仍然保存才覆盖', async () => {
    const t = setup();
    t.docs.start();
    t.fake.put('/f', 'old');
    await t.main.open('s1', '/f');
    await settle();
    const id = t.docs.store.get().activeId!;
    t.fake.put('/f', 'someone else');
    t.docs.save(id, 'mine');
    await settle();
    await settle();
    expect(t.fake.uploads).toEqual([]);
    expect(t.docs.store.get().tabs[0]!.conflict).toEqual({ remoteMtime: t.fake.clock });

    t.docs.save(id, 'mine', true);
    await settle();
    await settle();
    expect(t.fake.uploads).toEqual(['mine']);
    expect(t.docs.store.get().tabs[0]).toMatchObject({ status: 'saved', conflict: null });
  });

  it('服务器上的文件没了也算冲突', async () => {
    const t = setup();
    t.docs.start();
    t.fake.put('/f', 'old');
    await t.main.open('s1', '/f');
    await settle();
    t.fake.files.delete('/f');
    t.docs.save(t.docs.store.get().activeId!, 'x');
    await settle();
    await settle();
    expect(t.docs.store.get().tabs[0]!.conflict).toEqual({ remoteMtime: null });
  });

  it('重新载入换掉文字', async () => {
    const t = setup();
    t.docs.start();
    t.fake.put('/f', 'one');
    await t.main.open('s1', '/f');
    await settle();
    const id = t.docs.store.get().activeId!;
    t.docs.takeText(id);
    t.docs.setDirty(id, true);
    t.fake.put('/f', 'two\r\n');
    t.docs.reload(id);
    await settle();
    await settle();
    expect(t.docs.store.get().tabs[0]).toMatchObject({ loadSeq: 2, dirty: false, eol: '\r\n' });
    expect(t.docs.takeText(id)).toBe('two\n');
    expect(t.dirty.at(-1)).toBe(false);
  });

  it('会话断开时保存失败，说清原因', async () => {
    const t = setup();
    t.docs.start();
    t.fake.put('/f', 'x');
    await t.main.open('s1', '/f');
    await settle();
    t.disconnect();
    t.docs.save(t.docs.store.get().activeId!, 'y');
    await settle();
    expect(t.docs.store.get().tabs[0]).toMatchObject({ status: 'error', error: '会话已断开，请重新连接后再保存' });
  });

  it('关掉文件、编辑器整个关掉，主窗口都忘掉它们', async () => {
    const t = setup();
    t.docs.start();
    t.fake.put('/a', 'x');
    t.fake.put('/b', 'y');
    await t.main.open('s1', '/a');
    await t.main.open('s1', '/b');
    await settle();
    const [a, b] = t.docs.store.get().tabs;
    t.docs.close(b!.id);
    expect(t.docs.store.get().activeId).toBe(a!.id);
    await settle();
    expect(t.main.openCount).toBe(1);

    t.docs.closeAll(true);
    await settle();
    expect(t.main.openCount).toBe(0);
    // 编辑器没了以后再打开，要等它重新说 ready 才发
    await t.main.open('s1', '/a');
    await settle();
    expect(t.docs.store.get().tabs).toEqual([]);
  });
});
