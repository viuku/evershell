import { useRef, useState } from 'react';
import { historyStore, recentCommands } from '../../core/history-store';
import { modEnterLabel } from '../../core/platform';
import { useStore } from '../../core/store';
import { PaletteIcon } from '../common/Icons';
import { Dropdown, type MenuItem } from '../common/Menu';

interface Props {
  lookOpen: boolean;
  onToggleLook(): void;
  /** 发到当前会话；返回 false 表示没发出去（未连接） */
  onSend(cmd: string): boolean;
  /** 发到全部已连接会话，返回数量 */
  onSendAll(cmd: string): number;
  connected: boolean;
  connectedCount: number;
}

/** 终端下方的命令栏：外观、历史、输入框、发送、发送到全部会话 */
export function CommandBar({ lookOpen, onToggleLook, onSend, onSendAll, connected, connectedCount }: Props) {
  const [cmd, setCmd] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const history = useStore(historyStore);
  const recent = recentCommands(history);

  const flash = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice(null), 1600);
  };

  const send = () => {
    const text = cmd.trim();
    if (!text) return;
    if (!onSend(text)) {
      flash('当前会话未连接');
      return;
    }
    setCmd('');
  };

  const sendAll = () => {
    const text = cmd.trim();
    if (!text) return;
    const n = onSendAll(text);
    if (n === 0) {
      flash('没有已连接的会话');
      return;
    }
    flash(`已发送到 ${n} 个会话`);
    setCmd('');
  };

  const historyItems: MenuItem[] =
    recent.length === 0
      ? [{ type: 'label', label: '还没有历史命令' }]
      : recent.map((c) => ({
          label: c,
          onSelect: () => {
            setCmd(c);
            inputRef.current?.focus();
          },
        }));

  return (
    <div className="cmdbar">
      <button type="button" className="btn" onClick={onToggleLook} aria-expanded={lookOpen} title="终端外观">
        <PaletteIcon size={13} />
        外观
      </button>
      <Dropdown
        direction="up"
        ariaLabel="历史命令"
        items={historyItems}
        trigger={(p) => (
          <button type="button" className="btn" {...p}>
            历史 ▾
          </button>
        )}
      />
      <label htmlFor="cmdbox" className="sr-only">
        命令
      </label>
      <input
        id="cmdbox"
        ref={inputRef}
        className="field cmdbar__input mono"
        value={cmd}
        placeholder={notice ?? '输入命令后回车，发送到当前会话'}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setCmd(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (e.metaKey || e.ctrlKey) sendAll();
            else send();
          }
        }}
      />
      <button type="button" className="btn btn-primary" onClick={send} disabled={!connected}>
        发送
      </button>
      <button type="button" className="btn" onClick={sendAll} disabled={connectedCount === 0} title={modEnterLabel}>
        发送到全部会话
      </button>
    </div>
  );
}
