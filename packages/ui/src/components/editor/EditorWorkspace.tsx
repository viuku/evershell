import { openSearchPanel } from '@codemirror/search';
import { EditorState, type Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useCallback, useEffect, useReducer, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';
import { guessLanguage, LANGUAGE_LABEL, type EditLanguage } from '../../core/edit-language';
import type { EditorDocs, EditorTab } from '../../core/editor-docs';
import { dragRegion, editorShortcutLabel, isEditorShortcut } from '../../core/platform';
import { useStore } from '../../core/store';
import type { EditorWindowHost } from '../../types';
import { useDialogs } from '../common/Dialogs';
import { CloseIcon, FileIcon } from '../common/Icons';
import { editorExtensions, loadLanguage } from './setup';

interface Props {
  docs: EditorDocs;
  /** 桌面端的独立编辑窗口：接上关窗口、退出时的询问，关文件的快捷键 */
  host?: EditorWindowHost;
  /** 最后一个文件关掉了，或者点了关闭（浮动窗口用） */
  onClosed(): void;
  /** 标签栏左边让出的宽度（Mac 的红绿灯） */
  inset?: number;
  /** 浮动模式加在标签栏上的拖动手柄（独立窗口不用传，有 host 就按住标签栏空白处拖窗口） */
  stripProps?: HTMLAttributes<HTMLDivElement>;
  /** 浮动模式在标签栏右边放一个关闭按钮 */
  closable?: boolean;
}

/** 一个文件在 CodeMirror 里的状态 */
interface Entry {
  state: EditorState | null;
  /** 最后一次和服务器一致的内容，用来判断有没有改过 */
  base: Text | null;
  /** 正在保存的内容，存好了变成 base */
  pending: Text | null;
  /** 已经装进来的是第几次载入（对应 EditorTab.loadSeq） */
  seq: number;
  savedAt: number | null;
  lang: EditLanguage;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function clock(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function remoteTime(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  const today = new Date().toDateString() === d.toDateString();
  return today ? clock(d.getTime()) : `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${clock(d.getTime())}`;
}

function statusOf(tab: EditorTab): { text: string; tone: 'muted' | 'warn' | 'ok' | 'error' } {
  const pct = tab.progress === null ? '…' : ` ${Math.floor(tab.progress * 100)}%`;
  if (tab.status === 'saving') return { text: `正在上传${pct}`, tone: 'muted' };
  if (tab.status === 'loading') return { text: `正在载入${pct}`, tone: 'muted' };
  if (tab.status === 'error' && tab.error) return { text: tab.error, tone: 'error' };
  if (tab.dirty) return { text: '未保存', tone: 'warn' };
  if (tab.status === 'saved' && tab.savedAt) return { text: `${clock(tab.savedAt)} 已保存到服务器`, tone: 'ok' };
  return { text: '与服务器上的版本一致', tone: 'muted' };
}

/** 等这个文件存完：存好了 true，失败或者服务器上的文件变了 false */
function waitSaved(docs: EditorDocs, id: string): Promise<boolean> {
  return new Promise((resolve) => {
    const check = () => {
      const t = docs.store.get().tabs.find((x) => x.id === id);
      if (!t) return finish(false);
      if (t.status === 'saved' && !t.dirty) return finish(true);
      if (t.status === 'error' || t.conflict) return finish(false);
    };
    const finish = (ok: boolean) => {
      off();
      resolve(ok);
    };
    const off = docs.store.subscribe(check);
    queueMicrotask(check);
  });
}

/** 编辑器：上面一排文件标签，中间 CodeMirror，下面状态行。独立窗口和浮动窗口共用 */
export function EditorWorkspace({ docs, host, onClosed, inset = 0, stripProps, closable }: Props) {
  const { tabs, activeId } = useStore(docs.store);
  const dialogs = useDialogs();
  const entries = useRef(new Map<string, Entry>());
  const viewRef = useRef<EditorView | null>(null);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const active = tabs.find((t) => t.id === activeId) ?? null;
  const entry = active ? entries.current.get(active.id) : undefined;

  const save = useCallback(
    (id: string, force = false) => {
      const e = entries.current.get(id);
      if (!e?.state) return;
      e.pending = e.state.doc;
      docs.save(id, e.state.doc.toString(), force);
    },
    [docs],
  );
  const saveRef = useRef(save);
  saveRef.current = save;

  // 打开、重新载入：按文件名加载语法，建一份新的编辑器状态（撤销记录从这里开始）
  useEffect(() => {
    const map = entries.current;
    for (const id of [...map.keys()]) if (!tabs.some((t) => t.id === id)) map.delete(id);
    for (const tab of tabs) {
      let e = map.get(tab.id);
      if (!e) {
        e = { state: null, base: null, pending: null, seq: 0, savedAt: null, lang: 'plain' };
        map.set(tab.id, e);
      }
      if (e.seq >= tab.loadSeq) continue;
      const text = docs.takeText(tab.id);
      if (text === null) continue;
      const seq = tab.loadSeq;
      e.seq = seq;
      const lang = guessLanguage(tab.path, text.slice(0, text.indexOf('\n') >>> 0));
      void loadLanguage(lang).then((ext) => {
        const cur = map.get(tab.id);
        if (!cur || cur.seq !== seq) return;
        const state = EditorState.create({ doc: text, extensions: editorExtensions(ext, () => saveRef.current(tab.id)) });
        Object.assign(cur, { state, base: state.doc, pending: null, lang });
        rerender();
      });
    }
  }, [tabs, docs]);

  // 存好了：存的那份变成“和服务器一致”的基准，存的时候又改了的话仍算没保存
  useEffect(() => {
    for (const tab of tabs) {
      const e = entries.current.get(tab.id);
      if (!e || e.savedAt === tab.savedAt) continue;
      e.savedAt = tab.savedAt;
      if (e.pending && e.state) {
        e.base = e.pending;
        e.pending = null;
        docs.setDirty(tab.id, !e.state.doc.eq(e.base));
      }
    }
  }, [tabs, docs]);

  // 保存时发现服务器上的文件变了：问一次
  const asked = useRef(new Set<string>());
  useEffect(() => {
    for (const tab of tabs) {
      if (!tab.conflict) continue;
      const key = `${tab.id}:${tab.conflict.remoteMtime}`;
      if (asked.current.has(key)) continue;
      asked.current.add(key);
      const { remoteMtime } = tab.conflict;
      void dialogs
        .choose({
          title: remoteMtime === null ? '服务器上的文件已不存在' : '服务器上的文件已被修改',
          message:
            remoteMtime === null
              ? `${tab.name} 可能已被删除或重命名。继续保存将在原路径重新创建该文件。`
              : `打开 ${tab.name} 后，服务器上的该文件于 ${remoteTime(remoteMtime)} 被修改。现在保存将覆盖该修改。`,
          actions: [
            { id: 'reload', label: '重新载入' },
            { id: 'cancel', label: '取消' },
            { id: 'force', label: '仍然保存', tone: 'danger' },
          ],
          cancel: 'cancel',
          aside: 'reload',
        })
        .then((r) => {
          asked.current.delete(key);
          if (r === 'force') save(tab.id, true);
          else if (r === 'reload') docs.reload(tab.id);
          else docs.dismissConflict(tab.id);
        });
    }
  }, [tabs, dialogs, docs, save]);

  /** 关一个文件；没保存的先问 */
  const closeTab = useCallback(
    async (id: string) => {
      const tab = docs.store.get().tabs.find((t) => t.id === id);
      if (!tab) return;
      if (tab.dirty) {
        const r = await dialogs.choose({
          title: `${tab.name} 尚未保存`,
          message: '如不保存直接关闭，本次修改将丢失。',
          actions: [
            { id: 'discard', label: '不保存' },
            { id: 'cancel', label: '取消' },
            { id: 'save', label: '保存', tone: 'primary' },
          ],
          cancel: 'cancel',
          aside: 'discard',
        });
        if (r === 'cancel') return;
        if (r === 'save') {
          save(id);
          if (!(await waitSaved(docs, id))) return;
        }
      }
      const last = docs.store.get().tabs.length === 1;
      docs.close(id);
      if (last) onClosed();
    },
    [docs, dialogs, save, onClosed],
  );

  /** 整个编辑器要关了：有没保存的先问，返回能不能关 */
  const confirmCloseAll = useCallback(async (): Promise<boolean> => {
    const dirty = docs.dirtyTabs();
    if (dirty.length === 0) return true;
    const names = dirty.map((t) => t.name).join('、');
    const r = await dialogs.choose({
      title: dirty.length === 1 ? `${names} 尚未保存` : `${dirty.length} 个文件尚未保存`,
      message: dirty.length === 1 ? '如不保存直接关闭，本次修改将丢失。' : `${names} 尚未保存。如不保存直接关闭，这些修改将丢失。`,
      actions: [
        { id: 'discard', label: '不保存' },
        { id: 'cancel', label: '取消' },
        { id: 'save', label: dirty.length === 1 ? '保存' : '全部保存', tone: 'primary' },
      ],
      cancel: 'cancel',
      aside: 'discard',
    });
    if (r === 'cancel') return false;
    if (r === 'save') {
      for (const t of dirty) save(t.id);
      const ok = await Promise.all(dirty.map((t) => waitSaved(docs, t.id)));
      return ok.every(Boolean);
    }
    return true;
  }, [docs, dialogs, save]);

  // 独立窗口：点关闭、主窗口要关时先问；“关闭”快捷键关当前文件
  useEffect(() => {
    if (!host) return;
    const offClose = host.onCloseRequested(async () => {
      const ok = await confirmCloseAll();
      if (ok) docs.closeAll(false);
      return ok;
    });
    const offQuit = host.onQuitRequested(() => {
      void confirmCloseAll().then((ok) => ok && host.quit());
    });
    const onKey = (e: KeyboardEvent) => {
      if (!isEditorShortcut(e, 'w')) return;
      e.preventDefault();
      const id = docs.store.get().activeId;
      if (id) void closeTab(id);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      offClose();
      offQuit();
      window.removeEventListener('keydown', onKey);
    };
  }, [host, docs, confirmCloseAll, closeTab]);

  const closeAll = async () => {
    if (!(await confirmCloseAll())) return;
    docs.closeAll(true);
    onClosed();
  };

  const reload = async () => {
    if (!active) return;
    if (active.dirty) {
      const ok = await dialogs.confirm({
        title: '重新载入',
        message: `${active.name} 中未保存的修改将丢失。`,
        okText: '重新载入',
        danger: true,
      });
      if (!ok) return;
    }
    docs.reload(active.id);
  };

  const onUpdate = useCallback(
    (state: EditorState, docChanged: boolean) => {
      const id = docs.store.get().activeId;
      const e = id ? entries.current.get(id) : undefined;
      if (!id || !e) return;
      e.state = state;
      if (docChanged && e.base) docs.setDirty(id, !state.doc.eq(e.base));
      const head = state.selection.main.head;
      const line = state.doc.lineAt(head);
      setCursor((c) => (c.line === line.number && c.col === head - line.from + 1 ? c : { line: line.number, col: head - line.from + 1 }));
    },
    [docs],
  );

  const status = active ? statusOf(active) : null;
  // 拖窗口的标记只对元素本身生效：标签那一排铺满了标签栏，两层都要标，不然点到的是里层，拖不动
  const drag = host ? dragRegion : undefined;
  const busy = active?.status === 'saving' || active?.status === 'loading';

  return (
    <div className="ed">
      <div className="ed__strip" style={{ paddingLeft: inset + 6 }} {...drag} {...stripProps}>
        <div role="tablist" aria-label="打开的文件" className="ed__tabs" {...drag}>
          {tabs.map((t) => {
            const on = t.id === activeId;
            return (
              <div key={t.id} className={`ed__tab${on ? ' ed__tab--on' : ''}${t.dirty ? ' ed__tab--dirty' : ''}`} title={`${t.host}:${t.path}`}>
                <button type="button" role="tab" aria-selected={on} className="ed__tab-name" onClick={() => docs.activate(t.id)}>
                  {t.name}
                </button>
                <button type="button" className="ed__tab-close" aria-label={`关闭 ${t.name}`} onClick={() => void closeTab(t.id)}>
                  <span className="ed__dot" aria-hidden="true" />
                  <CloseIcon size={8} />
                </button>
              </div>
            );
          })}
        </div>
        {closable && (
          <button type="button" className="tb ed__close" aria-label="关闭编辑器" title="关闭编辑器" onClick={() => void closeAll()}>
            <CloseIcon size={10} />
          </button>
        )}
      </div>
      {active ? (
        <>
          <div className="ed__toolbar">
            <button
              type="button"
              className={`btn${active.dirty ? ' btn-primary' : ''}`}
              disabled={busy}
              title={`保存并上传（${editorShortcutLabel('s')}）`}
              onClick={() => save(active.id)}
            >
              保存
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void reload()}>
              重新载入
            </button>
            <button
              type="button"
              className="btn"
              title={`查找和替换（${editorShortcutLabel('f')}）`}
              onClick={() => viewRef.current && openSearchPanel(viewRef.current)}
            >
              查找
            </button>
            <span className="ed__path mono" title={`${active.host}:${active.path}`}>
              <FileIcon size={13} />
              <span className="ellipsis">{active.path}</span>
            </span>
            {busy && (
              <span className="ed__progress" aria-hidden="true">
                <span className={active.progress === null ? 'ed__progress-wait' : undefined} style={{ width: `${(active.progress ?? 0) * 100}%` }} />
              </span>
            )}
            {status && (
              <span
                role="status"
                className={`ed__status${busy ? ' ed__status--busy' : ''} ed__status--${status.tone} ellipsis`}
                title={status.text}
              >
                {status.text}
              </span>
            )}
          </div>
          <CodeEditor state={entry?.state ?? null} viewRef={viewRef} onUpdate={onUpdate} />
          <div className="ed__foot">
            <span>UTF-8</span>
            <span>{active.eol === '\r\n' ? 'CRLF' : 'LF'}</span>
            <span>
              第 {cursor.line} 行，第 {cursor.col} 列
            </span>
            <span className="ed__foot-right">{LANGUAGE_LABEL[entry?.lang ?? 'plain']}</span>
            <span className="ellipsis">{active.host}</span>
          </div>
        </>
      ) : (
        <Placeholder>正在打开…</Placeholder>
      )}
    </div>
  );
}

function Placeholder({ children }: { children: ReactNode }) {
  return <div className="empty ed__empty">{children}</div>;
}

/** 一个 CodeMirror 视图，切文件时换整份状态（各文件的撤销记录、光标、滚动位置各自保留） */
function CodeEditor({
  state,
  viewRef,
  onUpdate,
}: {
  state: EditorState | null;
  viewRef: { current: EditorView | null };
  onUpdate(state: EditorState, docChanged: boolean): void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  useEffect(() => {
    const view = new EditorView({
      parent: hostRef.current!,
      dispatchTransactions: (trs, v) => {
        v.update(trs);
        onUpdateRef.current(v.state, trs.some((tr) => tr.docChanged));
      },
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [viewRef]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || !state || view.state === state) return;
    view.setState(state);
    onUpdateRef.current(state, false);
    view.focus();
  }, [state, viewRef]);

  return <div ref={hostRef} className="ed__code" hidden={!state} />;
}
