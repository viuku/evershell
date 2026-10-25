import { useEffect, useState } from 'react';
import '../../styles/base.css';
import '../../styles/app.css';
import '../../styles/manager.css';
import { asToManager, type FromManager } from '../../core/manager-link';
import { isEditorShortcut } from '../../core/platform';
import { appearanceClass, appearanceMode } from '../../core/settings';
import { useStore } from '../../core/store';
import type { ManagerWindowHost, SshBackend } from '../../types';
import { DialogsProvider } from '../common/Dialogs';
import { TooltipLayer } from '../common/Tooltip';
import { ConnectionManager } from './ConnectionManager';

export interface ManagerAppProps {
  backend: SshBackend;
  host: ManagerWindowHost;
}

/** 桌面端独立连接管理器窗口的整个界面（docs/specs/manager-window.md） */
export default function ManagerApp({ backend, host }: ManagerAppProps) {
  const mode = useStore(appearanceMode);
  const [importSeq, setImportSeq] = useState(0);

  // 桌面端的窗口标题跟着网页标题走（系统「窗口」菜单里显示的名字）
  useEffect(() => {
    document.title = '连接管理器';
  }, []);

  // 告诉主窗口可以发消息了；主窗口刚启动问一声时也回一句
  useEffect(() => {
    const off = host.listen((raw) => {
      const msg = asToManager(raw);
      if (msg?.type === 'hello') host.post({ type: 'ready' } satisfies FromManager);
      else if (msg?.type === 'import') setImportSeq((n) => n + 1);
    });
    host.post({ type: 'ready' } satisfies FromManager);
    return off;
  }, [host]);

  // “关闭”快捷键关掉这个窗口
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isEditorShortcut(e, 'w')) return;
      e.preventDefault();
      host.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [host]);

  return (
    <div className={`app-root ${appearanceClass(mode)}`}>
      <DialogsProvider pickKeyFile={backend.pickPrivateKeyFile}>
        <ConnectionManager
          frame="window"
          backend={backend}
          importSeq={importSeq}
          onClose={() => host.close()}
          onConnect={(server) => {
            host.post({ type: 'connect', ids: [server.id] } satisfies FromManager);
            host.focusMain();
          }}
        />
      </DialogsProvider>
      <TooltipLayer />
    </div>
  );
}
