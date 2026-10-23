import { useRef, useState } from 'react';
import { clearHistory, historyLine, historyStore, recentCommands } from '../../core/history-store';
import { shortcutLabel } from '../../core/platform';
import type { SessionStatus } from '../../core/session-manager';
import { useStore } from '../../core/store';
import { useDialogs } from '../common/Dialogs';
import { BoltIcon, DownIcon, GearIcon, PaletteIcon, SearchIcon, UpIcon } from '../common/Icons';
import { Dropdown, type MenuItem } from '../common/Menu';

interface Props {
  lookOpen: boolean;
  onToggleLook(): void;
  /** 发到当前会话；返回 false 表示没发出去（未连接） */
  onSend(cmd: string): boolean;
  status: SessionStatus;
  /** 闪电：连着就断开，断开了就重连 */
  onToggleConnection(): void;
  findOpen: boolean;
  onToggleFind(): void;
  /** 打开这台服务器的「编辑连接」；连接管理器里没有这条记录时为 null */
  onEditConnection: (() => void) | null;
  bottomOpen: boolean;
  onToggleBottom(): void;
}

const BOLT_TITLES: Record<SessionStatus, string> = {
  connected: '已连接，点一下断开',
  connecting: '正在连接…',
  closed: '已断开，点一下重新连接',
  error: '已断开，点一下重新连接',
};

/** 终端下方的命令栏：外观、历史、输入框、发送；右边是连接状态、搜索、连接设置、底栏开关。发到全部会话在底栏的「命令」页 */
export function CommandBar(props: Props) {
  const { lookOpen, onToggleLook, onSend, status } = props;
  const [cmd, setCmd] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const history = useStore(historyStore);
  const recent = recentCommands(history);
  const dialogs = useDialogs();

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

  const historyItems: MenuItem[] =
    recent.length === 0
      ? [{ type: 'label', label: '还没有历史命令' }]
      : [
          ...recent.map((c) => ({
            label: historyLine(c),
            onSelect: () => {
              setCmd(historyLine(c));
              inputRef.current?.focus();
            },
          })),
          { type: 'separator' },
          {
            label: '清空历史…',
            onSelect: () =>
              void dialogs
                .confirm({ title: '清空历史命令', message: '确定要清空全部历史命令吗？', okText: '清空', danger: true })
                .then((ok) => ok && clearHistory()),
          },
        ];

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
            send();
          }
        }}
      />
      <button type="button" className="btn btn-primary" onClick={send} disabled={status !== 'connected'}>
        发送
      </button>
      <CommandBarTools {...props} />
    </div>
  );
}

/** 右边四个图标按钮，顺序照 FinalShell */
function CommandBarTools({ status, onToggleConnection, findOpen, onToggleFind, onEditConnection, bottomOpen, onToggleBottom }: Props) {
  const busy = status === 'connecting';
  return (
    <div className="cmdbar__tools">
      <span className="cmdbar__sep" aria-hidden="true" />
      {/* 连接中也要能看到提示，所以不用 disabled（禁用的按钮不出提示），点了不响应 */}
      <button
        type="button"
        className={`cmdbar__tool cmdbar__bolt cmdbar__bolt--${status}`}
        aria-label={BOLT_TITLES[status]}
        aria-disabled={busy || undefined}
        title={BOLT_TITLES[status]}
        onClick={() => !busy && onToggleConnection()}
      >
        <BoltIcon size={14} />
      </button>
      <button
        type="button"
        className={`cmdbar__tool${findOpen ? ' cmdbar__tool--on' : ''}`}
        aria-label="搜索终端内容"
        aria-pressed={findOpen}
        title={`搜索（${shortcutLabel('f')}）`}
        onClick={onToggleFind}
      >
        <SearchIcon size={14} />
      </button>
      <button
        type="button"
        className="cmdbar__tool"
        aria-label="连接设置"
        title="连接设置"
        disabled={!onEditConnection}
        onClick={() => onEditConnection?.()}
      >
        <GearIcon size={14} />
      </button>
      <button
        type="button"
        className="cmdbar__tool"
        aria-label={bottomOpen ? '隐藏底栏' : '显示底栏'}
        aria-expanded={bottomOpen}
        title={bottomOpen ? '隐藏底栏' : '显示底栏'}
        onClick={onToggleBottom}
      >
        {bottomOpen ? <DownIcon size={14} /> : <UpIcon size={14} />}
      </button>
    </div>
  );
}
