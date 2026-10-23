import { asToEditor, type EditDocInit, type Eol, type MessagePort, type ToEditor, type ToMain } from './remote-edit';
import { Store } from './store';

// 编辑窗口这一头：开着哪些文件、各自的保存状态。文字本身在编辑器组件里（CodeMirror 的文档），
// 这里只在打开、重新载入时暂存一下，等组件取走。

/** loading 是重新载入中 */
export type SaveStatus = 'idle' | 'saving' | 'loading' | 'saved' | 'error';

export interface EditorTab {
  id: string;
  sessionId: string;
  host: string;
  path: string;
  name: string;
  eol: Eol;
  /** 和服务器上的版本不一样了 */
  dirty: boolean;
  status: SaveStatus;
  /** 最近一次保存或载入失败的原因 */
  error: string | null;
  /** 最近一次保存成功的时间 */
  savedAt: number | null;
  /** 正在上传或载入时的进度，0～1；还没开始传（先要比对服务器上的版本）时为 null */
  progress: number | null;
  /** 保存时发现服务器上的文件变了，等用户决定；remoteMtime 为 null 是服务器上找不到这个文件了 */
  conflict: { remoteMtime: number | null } | null;
  /** 文字被整个换掉（打开、重新载入）一次加一，组件据此重建编辑器内容 */
  loadSeq: number;
}

export interface EditorDocsState {
  tabs: EditorTab[];
  activeId: string | null;
}

export class EditorDocs {
  readonly store = new Store<EditorDocsState>({ tabs: [], activeId: null });
  /** 打开、重新载入送来的文字，组件取走后删掉 */
  private readonly incoming = new Map<string, string>();
  private unlisten: (() => void) | null = null;

  constructor(
    private readonly port: MessagePort,
    /** 有没有没保存的文件变了（桌面端要告诉 Rust，关主窗口时先问） */
    private readonly onDirtyChange?: (dirty: boolean) => void,
  ) {}

  /** 开始收消息，并告诉主窗口可以发了 */
  start(): void {
    this.unlisten ??= this.port.listen((raw) => {
      const msg = asToEditor(raw);
      if (msg) this.handle(msg);
    });
    this.post({ type: 'ready' });
  }

  stop(): void {
    this.unlisten?.();
    this.unlisten = null;
  }

  private post(msg: ToMain): void {
    this.port.post(msg);
  }

  private patchTab(id: string, p: Partial<EditorTab>): void {
    this.store.set((s) => ({ ...s, tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...p } : t)) }));
  }

  private tab(id: string): EditorTab | undefined {
    return this.store.get().tabs.find((t) => t.id === id);
  }

  private handle(msg: ToEditor): void {
    switch (msg.type) {
      case 'hello':
        this.post({ type: 'ready' });
        return;
      case 'open':
        return this.add(msg.doc);
      case 'focus':
        if (this.tab(msg.id)) this.activate(msg.id);
        return;
      case 'progress':
        return this.patchTab(msg.id, { progress: msg.total > 0 ? msg.done / msg.total : 1 });
      case 'saved':
        return this.patchTab(msg.id, { status: 'saved', savedAt: msg.at, error: null, conflict: null, progress: null });
      case 'failed':
        return this.patchTab(msg.id, { status: 'error', error: msg.error, progress: null });
      case 'conflict':
        return this.patchTab(msg.id, { status: 'idle', conflict: { remoteMtime: msg.remoteMtime }, progress: null });
      case 'reloaded': {
        const t = this.tab(msg.id);
        if (!t) return;
        this.incoming.set(msg.id, msg.text);
        this.patchTab(msg.id, {
          eol: msg.eol,
          status: 'idle',
          error: null,
          conflict: null,
          savedAt: null,
          progress: null,
          dirty: false,
          loadSeq: t.loadSeq + 1,
        });
        this.reportDirty();
        return;
      }
    }
  }

  private add(doc: EditDocInit): void {
    if (this.tab(doc.id)) return this.activate(doc.id);
    this.incoming.set(doc.id, doc.text);
    const tab: EditorTab = {
      id: doc.id,
      sessionId: doc.sessionId,
      host: doc.host,
      path: doc.path,
      name: doc.name,
      eol: doc.eol,
      dirty: false,
      status: 'idle',
      error: null,
      savedAt: null,
      progress: null,
      conflict: null,
      loadSeq: 1,
    };
    this.store.set((s) => ({ tabs: [...s.tabs, tab], activeId: doc.id }));
  }

  /** 组件取走送来的文字（只能取一次） */
  takeText(id: string): string | null {
    const text = this.incoming.get(id);
    this.incoming.delete(id);
    return text ?? null;
  }

  activate(id: string): void {
    if (this.store.get().activeId !== id) this.store.set((s) => ({ ...s, activeId: id }));
  }

  setDirty(id: string, dirty: boolean): void {
    const t = this.tab(id);
    if (!t || t.dirty === dirty) return;
    // 又改了的话，“已保存”的提示就不对了
    this.patchTab(id, dirty ? { dirty, status: t.status === 'saved' ? 'idle' : t.status } : { dirty });
    this.reportDirty();
  }

  anyDirty(): boolean {
    return this.store.get().tabs.some((t) => t.dirty);
  }

  dirtyTabs(): EditorTab[] {
    return this.store.get().tabs.filter((t) => t.dirty);
  }

  private reportDirty(): void {
    this.onDirtyChange?.(this.anyDirty());
  }

  /** force：服务器上的文件变了，用户选了仍然保存 */
  save(id: string, text: string, force = false): void {
    const t = this.tab(id);
    if (!t || t.status === 'saving' || t.status === 'loading') return;
    this.patchTab(id, { status: 'saving', error: null, conflict: null, progress: null });
    this.post({ type: 'save', id, text, force });
  }

  reload(id: string): void {
    const t = this.tab(id);
    if (!t || t.status === 'saving' || t.status === 'loading') return;
    this.patchTab(id, { status: 'loading', error: null, conflict: null, progress: null });
    this.post({ type: 'reload', id });
  }

  dismissConflict(id: string): void {
    this.patchTab(id, { conflict: null });
  }

  /** 关掉一个文件（没保存的要不要先问，由界面决定） */
  close(id: string): void {
    const s = this.store.get();
    const i = s.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    const tabs = s.tabs.filter((t) => t.id !== id);
    // 关掉的是当前的，就切到右边那个，没有就左边
    const activeId = s.activeId === id ? (tabs[i] ?? tabs[i - 1] ?? null)?.id ?? null : s.activeId;
    this.incoming.delete(id);
    this.store.set({ tabs, activeId });
    this.post({ type: 'close', id });
    this.reportDirty();
  }

  /** 编辑器整个关掉（浮动窗口用；桌面端编辑窗口没了由 Rust 通知主窗口） */
  closeAll(notify: boolean): void {
    for (const t of this.store.get().tabs) this.post({ type: 'close', id: t.id });
    this.incoming.clear();
    this.store.set({ tabs: [], activeId: null });
    if (notify) this.post({ type: 'gone' });
    this.reportDirty();
  }
}
