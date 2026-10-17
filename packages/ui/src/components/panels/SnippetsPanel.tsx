import { useState, type FormEvent } from 'react';
import { addSnippet, removeSnippet, snippetGroups, snippetsStore, updateSnippet, type Snippet } from '../../core/snippets-store';
import { useStore } from '../../core/store';
import { useDialogs } from '../common/Dialogs';
import { ContextMenu, type ContextMenuState } from '../common/Menu';
import { Modal } from '../common/Modal';
import { Segmented } from '../common/Segmented';

interface Props {
  onSend(cmd: string): boolean;
  onSendAll(cmd: string): number;
}

type Editing = { mode: 'new' } | { mode: 'edit'; snippet: Snippet };

/** 快捷命令：按分组筛选，行末「发送」，右键编辑 / 删除 / 批量发送 */
export function SnippetsPanel({ onSend, onSendAll }: Props) {
  const list = useStore(snippetsStore);
  const dialogs = useDialogs();
  const [group, setGroup] = useState('全部');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const groups = snippetGroups(list);
  const current = group !== '全部' && !groups.includes(group) ? '全部' : group;
  const shown = list.filter((s) => current === '全部' || s.group === current);

  const remove = async (s: Snippet) => {
    const ok = await dialogs.confirm({ title: '删除快捷命令', message: `确定要删除“${s.name}”吗？`, okText: '删除', danger: true });
    if (ok) removeSnippet(s.id);
  };

  return (
    <div className="snips">
      <div className="snips__bar">
        <Segmented
          ariaLabel="分组"
          role="group"
          size="small"
          value={current}
          onChange={setGroup}
          options={['全部', ...groups].map((g) => ({ id: g, label: g }))}
        />
        <button type="button" className="btn snips__new" onClick={() => setEditing({ mode: 'new' })}>
          新建命令
        </button>
      </div>
      <div className="scroll snips__table">
        <div className="snips__inner">
          <div className="grid-head snips__cols">
            <span>名称</span>
            <span>命令</span>
            <span>分组</span>
            <span />
          </div>
          {shown.length === 0 ? (
            <div className="empty">还没有快捷命令，点右上角「新建命令」添加</div>
          ) : (
            shown.map((s) => (
              <div
                key={s.id}
                className="grid-row snips__cols snips__row"
                onDoubleClick={() => onSend(s.cmd)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({
                    x: e.clientX,
                    y: e.clientY,
                    items: [
                      { label: '发送到当前会话', onSelect: () => void onSend(s.cmd) },
                      { label: '发送到全部会话', onSelect: () => void onSendAll(s.cmd) },
                      { type: 'separator' },
                      { label: '编辑…', onSelect: () => setEditing({ mode: 'edit', snippet: s }) },
                      { label: '删除…', danger: true, onSelect: () => void remove(s) },
                    ],
                  });
                }}
              >
                <span className="ellipsis">{s.name}</span>
                <code className="mono ellipsis snips__cmd" title={s.cmd}>
                  {s.cmd}
                </code>
                <span className="muted ellipsis">{s.group}</span>
                <button type="button" className="btn btn--row snips__send" onClick={() => onSend(s.cmd)}>
                  发送
                </button>
              </div>
            ))
          )}
        </div>
      </div>
      {editing && <SnippetDialog editing={editing} groups={groups} onClose={() => setEditing(null)} />}
      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

function SnippetDialog({ editing, groups, onClose }: { editing: Editing; groups: string[]; onClose(): void }) {
  const init = editing.mode === 'edit' ? editing.snippet : null;
  const [name, setName] = useState(init?.name ?? '');
  const [cmd, setCmd] = useState(init?.cmd ?? '');
  const [group, setGroup] = useState(init?.group ?? groups[0] ?? '常用');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const input = { name: name.trim() || cmd.trim().slice(0, 30), cmd: cmd.trim(), group: group.trim() || '常用' };
    if (!input.cmd) return;
    if (init) updateSnippet(init.id, input);
    else addSnippet(input);
    onClose();
  };

  return (
    <Modal title={init ? '编辑命令' : '新建命令'} onClose={onClose} width={420} tone="sheet">
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
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
          }}
        />
        <label htmlFor="snp-group" className="lbl">
          分组
        </label>
        <input id="snp-group" className="field" value={group} list="snp-groups" autoComplete="off" onChange={(e) => setGroup(e.target.value)} />
        <datalist id="snp-groups">
          {groups.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
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
