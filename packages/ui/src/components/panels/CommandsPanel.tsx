import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from 'react';
import {
  commandEditorText,
  commandEditorWidth,
  editorClearAfterSend,
  editorSendTarget,
  lastSentSnippet,
  selectedGroup,
  sendTo,
  snippetSendTarget,
  type SendResult,
  type SendTarget,
} from '../../core/commands-panel';
import { isModEnter, modEnterLabel } from '../../core/platform';
import type { SessionInfo, SessionManager } from '../../core/session-manager';
import {
  DEFAULT_GROUP,
  addGroup,
  addSnippet,
  currentGroup,
  groupNameError,
  groupsStore,
  listGroups,
  removeGroup,
  removeSnippet,
  renameGroup,
  snippetsStore,
  updateSnippet,
  type Snippet,
} from '../../core/snippets-store';
import { useStore } from '../../core/store';
import { useDialogs } from '../common/Dialogs';
import { FolderOutlineIcon, GearIcon } from '../common/Icons';
import { ContextMenu, Dropdown, type ContextMenuState, type MenuItem } from '../common/Menu';
import { Modal } from '../common/Modal';

interface Props {
  manager: SessionManager;
  session: SessionInfo;
}

type Editing =
  | { mode: 'new'; title: string; group: string | null; cmd: string }
  | { mode: 'edit'; snippet: Snippet };

/** 发送结果的提示停留多久 */
const FLASH_MS = 2000;
/** 拖分隔条时左边至少留这么宽 */
const MAIN_MIN = 260;
const EDITOR_MIN = 200;

/** 底栏「命令」页，照 FinalShell：左边分类和快捷命令，单击就发送；右边命令编辑器，能写多行 */
export function CommandsPanel({ manager, session }: Props) {
  const dialogs = useDialogs();
  const saved = useStore(groupsStore);
  const list = useStore(snippetsStore);
  const selected = useStore(selectedGroup);
  const lastId = useStore(lastSentSnippet);
  const target = useStore(snippetSendTarget);
  const text = useStore(commandEditorText);
  const editorTarget = useStore(editorSendTarget);
  const clearAfter = useStore(editorClearAfterSend);
  const width = useStore(commandEditorWidth);

  const groups = useMemo(() => listGroups(saved, list), [saved, list]);
  const group = currentGroup(groups, selected);
  const shown = list.filter((s) => s.group === group);
  const lastSent = shown.find((s) => s.id === lastId) ?? null;

  const [editing, setEditing] = useState<Editing | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [flash, setFlash] = useState<SendResult | null>(null);
  const flashTimer = useRef(0);
  const editorRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  const send = (cmd: string, to: SendTarget, name?: string): SendResult | null => {
    const result = sendTo(manager, session.id, to, cmd, name);
    if (result) {
      setFlash(result);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS);
    }
    return result;
  };

  const sendSnippet = (s: Snippet) => {
    lastSentSnippet.set(s.id);
    send(s.cmd, target, s.name);
  };

  const sendEditor = () => {
    const result = send(text, editorTarget);
    if (result?.ok && clearAfter) commandEditorText.set('');
  };

  // ---------- 分类 ----------

  const newGroup = async () => {
    const name = await dialogs.prompt({ title: '新建分类', label: '名称', validate: (v) => groupNameError(v, groups) });
    if (name === null) return;
    addGroup(name);
    selectedGroup.set(name.trim());
  };

  const renameGroupAsk = async (g: string) => {
    const name = await dialogs.prompt({ title: '重命名分类', label: '名称', initial: g, validate: (v) => groupNameError(v, groups, g) });
    if (name === null || name.trim() === g) return;
    renameGroup(g, name);
    if (group === g) selectedGroup.set(name.trim());
  };

  const removeGroupAsk = async (g: string) => {
    const n = list.filter((s) => s.group === g).length;
    if (n > 0) {
      const ok = await dialogs.confirm({
        title: '删除分类',
        message: `确定删除分类「${g}」吗？里面的 ${n} 条命令也会一起删掉。`,
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
    }
    removeGroup(g);
  };

  // ---------- 命令 ----------

  const newSnippet = () => setEditing({ mode: 'new', title: '新建命令', group, cmd: '' });

  const removeSnippetAsk = async (s: Snippet) => {
    const ok = await dialogs.confirm({ title: '删除命令', message: `确定删除「${s.name}」吗？`, okText: '删除', danger: true });
    if (ok) removeSnippet(s.id);
  };

  const openMenu = (e: ReactMouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const snippetMenu = (e: ReactMouseEvent, s: Snippet) => {
    openMenu(e, [
      { label: '发送', onSelect: () => sendSnippet(s) },
      { label: '编辑…', onSelect: () => setEditing({ mode: 'edit', snippet: s }) },
      {
        label: '放进命令编辑器',
        onSelect: () => {
          commandEditorText.set(s.cmd);
          editorRef.current?.focus();
        },
      },
      { type: 'separator' },
      { label: '删除…', danger: true, onSelect: () => void removeSnippetAsk(s) },
    ]);
  };

  const optionItems: MenuItem[] = [
    { label: '发送后清空', checked: clearAfter, onSelect: () => editorClearAfterSend.set(!clearAfter) },
    { type: 'separator' },
    {
      label: '存为快捷命令…',
      disabled: !text.trim(),
      onSelect: () => setEditing({ mode: 'new', title: '存为快捷命令', group, cmd: text }),
    },
    { label: '清空', disabled: !text, onSelect: () => commandEditorText.set('') },
  ];

  return (
    <div className="cmds">
      <div className="cmds__main">
        <div role="group" aria-label="分类" className="cmds__groups">
          {groups.map((g) => (
            <button
              key={g}
              type="button"
              className={`cmds__group${g === group ? ' cmds__group--on' : ''}`}
              aria-pressed={g === group}
              onClick={() => selectedGroup.set(g)}
              onContextMenu={(e) =>
                openMenu(e, [
                  { label: '重命名…', onSelect: () => void renameGroupAsk(g) },
                  { label: '删除…', danger: true, onSelect: () => void removeGroupAsk(g) },
                ])
              }
            >
              <FolderOutlineIcon size={14} />
              {g}
            </button>
          ))}
          <button type="button" className="cmds__add" onClick={() => void newGroup()}>
            ＋ 新建分类
          </button>
        </div>
        <div
          className="scroll cmds__box"
          onContextMenu={(e) =>
            openMenu(e, [
              { label: '新建命令…', onSelect: newSnippet },
              { label: '新建分类…', onSelect: () => void newGroup() },
            ])
          }
        >
          <div className="cmds__flow">
            {shown.map((s) => (
              <span key={s.id} className="cmds__cmd" onContextMenu={(e) => snippetMenu(e, s)}>
                <button
                  type="button"
                  className="cmds__name"
                  data-tip={s.cmd}
                  // 双击的第二下不再发：习惯双击的人不会把命令发两遍
                  onClick={(e) => e.detail < 2 && sendSnippet(s)}
                >
                  {s.name}
                </button>
                <button
                  type="button"
                  className="cmds__gear"
                  aria-label={`编辑「${s.name}」`}
                  data-tip="编辑"
                  onClick={() => setEditing({ mode: 'edit', snippet: s })}
                >
                  <GearIcon size={13} />
                </button>
              </span>
            ))}
            <button type="button" className="cmds__add cmds__add--cmd" onClick={newSnippet}>
              ＋ 新建命令
            </button>
          </div>
        </div>
        <div className="cmds__foot">
          <span role="status" className={`cmds__flash${flash ? (flash.ok ? ' cmds__flash--ok' : ' cmds__flash--fail') : ''}`}>
            {flash?.text}
          </span>
          <label htmlFor="cmds-target">发送到</label>
          <TargetSelect id="cmds-target" value={target} onChange={(v) => snippetSendTarget.set(v)} />
          <button
            type="button"
            className="btn btn-primary cmds__send"
            disabled={!lastSent}
            title={lastSent ? `再发一次「${lastSent.name}」` : '先点一条命令'}
            onClick={() => lastSent && sendSnippet(lastSent)}
          >
            发送
          </button>
        </div>
      </div>
      <EditorSplitter />
      <div className="cmds__editor" style={{ flexBasis: width }}>
        <label htmlFor="cmds-editor" className="cmds__title">
          命令编辑器
        </label>
        <textarea
          id="cmds-editor"
          ref={editorRef}
          className="field mono cmds__text"
          value={text}
          placeholder={`可以写多行，${modEnterLabel} 发送`}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => commandEditorText.set(e.target.value)}
          onKeyDown={(e) => {
            if (!isModEnter(e)) return;
            e.preventDefault();
            sendEditor();
          }}
        />
        <div className="cmds__foot">
          <Dropdown
            direction="up"
            ariaLabel="命令编辑器选项"
            items={optionItems}
            trigger={(p) => (
              <button type="button" className="btn" {...p}>
                选项 ▾
              </button>
            )}
          />
          <label htmlFor="cmds-editor-target" className="cmds__to">
            发送到
          </label>
          <TargetSelect id="cmds-editor-target" value={editorTarget} onChange={(v) => editorSendTarget.set(v)} />
          <button type="button" className="btn btn-primary cmds__send" disabled={!text.trim()} onClick={sendEditor}>
            发送
          </button>
        </div>
      </div>
      {editing && (
        <SnippetDialog
          editing={editing}
          groups={groups}
          onClose={() => setEditing(null)}
          onSaved={(g) => selectedGroup.set(g)}
        />
      )}
      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function TargetSelect({ id, value, onChange }: { id: string; value: SendTarget; onChange(v: SendTarget): void }) {
  return (
    <select id={id} className="field cmds__target" value={value} onChange={(e) => onChange(e.target.value as SendTarget)}>
      <option value="current">当前会话</option>
      <option value="all">全部会话</option>
    </select>
  );
}

/** 左右两块中间的分隔条，往左拖命令编辑器变宽 */
function EditorSplitter() {
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; width: number; max: number } | null>(null);

  useEffect(() => {
    if (!dragging) return;
    const move = (e: MouseEvent) => {
      const s = start.current;
      if (!s) return;
      commandEditorWidth.set(Math.round(Math.max(EDITOR_MIN, Math.min(s.max, s.width + s.x - e.clientX))));
    };
    const up = () => setDragging(false);
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="调整命令编辑器宽度"
      className={`cmds__split${dragging ? ' cmds__split--on' : ''}`}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const editor = e.currentTarget.nextElementSibling as HTMLElement | null;
        const panel = e.currentTarget.parentElement as HTMLElement;
        // 从现在实际的宽度开始算：窗口窄时编辑器被挤窄过，不会一拖就跳
        const w = editor?.getBoundingClientRect().width ?? EDITOR_MIN;
        const max = Math.max(EDITOR_MIN, panel.getBoundingClientRect().width - MAIN_MIN - e.currentTarget.offsetWidth);
        start.current = { x: e.clientX, width: w, max };
        setDragging(true);
      }}
    >
      <span />
      <span />
      <span />
    </div>
  );
}

function SnippetDialog({
  editing,
  groups,
  onClose,
  onSaved,
}: {
  editing: Editing;
  groups: string[];
  onClose(): void;
  /** 存好后切到命令所在的分类 */
  onSaved(group: string): void;
}) {
  const init = editing.mode === 'edit' ? editing.snippet : null;
  // 分类全删光时只有一个默认分类可选，存的时候会自动建出来
  const options = groups.length > 0 ? groups : [DEFAULT_GROUP];
  const [name, setName] = useState(init?.name ?? '');
  const [cmd, setCmd] = useState(init ? init.cmd : editing.mode === 'new' ? editing.cmd : '');
  const [group, setGroup] = useState(() => {
    const want = init ? init.group : editing.mode === 'new' ? editing.group : null;
    return want !== null && options.includes(want) ? want : options[0]!;
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!cmd.trim()) return;
    const input = { name, cmd, group };
    if (init) {
      updateSnippet(init.id, input);
      onSaved(group);
    } else {
      onSaved(addSnippet(input).group);
    }
    onClose();
  };

  return (
    <Modal title={init ? '编辑命令' : editing.mode === 'new' ? editing.title : ''} onClose={onClose} width={420} tone="sheet">
      <form className="form" onSubmit={submit}>
        <label htmlFor="snp-name" className="lbl">
          名称
        </label>
        <input id="snp-name" className="field" value={name} placeholder="例如 查看磁盘" autoComplete="off" onChange={(e) => setName(e.target.value)} />
        <label htmlFor="snp-cmd" className="lbl">
          命令
        </label>
        <textarea
          id="snp-cmd"
          className="field mono"
          rows={3}
          value={cmd}
          placeholder="df -h"
          spellCheck={false}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (isModEnter(e)) submit(e);
          }}
        />
        <label htmlFor="snp-group" className="lbl">
          分类
        </label>
        <select id="snp-group" className="field" value={group} onChange={(e) => setGroup(e.target.value)}>
          {options.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <div className="form__actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={!cmd.trim()}>
            确定
          </button>
        </div>
      </form>
    </Modal>
  );
}
