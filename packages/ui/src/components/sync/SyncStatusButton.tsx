import { useStore } from '../../core/store';
import { syncStatus } from '../../core/sync';
import { statusTip, statusWord } from '../../core/sync-text';
import { SpinnerIcon } from '../common/Icons';

/** 左侧状态栏顶部「同步状态」右边的状态文字，单击打开同步窗口（设计稿方案 A） */
export function SyncStatusButton({ onOpen }: { onOpen(): void }) {
  const status = useStore(syncStatus);
  const warn = status.state === 'error' || status.state === 'relogin';
  return (
    <button
      type="button"
      className={`sync-status${warn ? ' sync-status--warn' : ''}`}
      data-tip={statusTip(status, Date.now())}
      onClick={onOpen}
    >
      {status.state === 'syncing' ? <SpinnerIcon size={10} className="spin sync-status__spin" /> : <span className={`sync-dot sync-dot--${status.state}`} />}
      {statusWord(status.state)}
    </button>
  );
}
