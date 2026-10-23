import { useEffect, useMemo } from 'react';
import '../../styles/base.css';
import '../../styles/app.css';
import '../../styles/editor.css';
import { EditorDocs } from '../../core/editor-docs';
import { appearanceClass, appearanceMode } from '../../core/settings';
import { useStore } from '../../core/store';
import type { EditorWindowHost } from '../../types';
import { DialogsProvider } from '../common/Dialogs';
import { TooltipLayer } from '../common/Tooltip';
import { EditorWorkspace } from './EditorWorkspace';

export interface EditorAppProps {
  host: EditorWindowHost;
  /** 系统窗口按钮叠在左上角时占的宽度（Mac 的红绿灯），文件标签要让开 */
  windowButtonsInset?: number;
}

/** 桌面端独立编辑窗口的整个界面 */
export default function EditorApp({ host, windowButtonsInset }: EditorAppProps) {
  const mode = useStore(appearanceMode);
  const docs = useMemo(() => new EditorDocs(host, (dirty) => host.setDirty(dirty)), [host]);
  useEffect(() => {
    docs.start();
    return () => docs.stop();
  }, [docs]);

  // 桌面端的窗口标题跟着网页标题走（系统「窗口」菜单里显示的名字）：当前文件名
  const { tabs, activeId } = useStore(docs.store);
  const activeName = tabs.find((t) => t.id === activeId)?.name;
  useEffect(() => {
    document.title = activeName ? `${activeName} - 编辑器` : '编辑器';
  }, [activeName]);

  return (
    <div className={`app-root ${appearanceClass(mode)}`}>
      <DialogsProvider>
        <div className={`ed-window ${appearanceClass(mode)}`}>
          <EditorWorkspace docs={docs} host={host} onClosed={() => host.close()} inset={windowButtonsInset} />
        </div>
      </DialogsProvider>
      <TooltipLayer />
    </div>
  );
}
