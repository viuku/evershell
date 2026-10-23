import { App, connectStorageSync, EditorApp, isMac, ManagerApp } from '@evershell/ui';
import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { editorHost, managerHost, storageSync, tauriBackend, windowKind } from './tauri-backend';

// Mac 上系统标题栏是透明的（tauri.macos.conf.json），红绿灯叠在界面左上角，约占 78px 宽
const windowButtonsInset = isMac ? 78 : undefined;

// 主窗口、编辑窗口、连接管理器共用本地数据，一个窗口写了通知其他窗口
connectStorageSync(storageSync);

// 几个窗口加载同一个页面，按窗口标签决定显示哪个（src-tauri/src/windows.rs）
const kind = windowKind();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {kind === 'editor' ? (
      <Suspense fallback={null}>
        <EditorApp host={editorHost} windowButtonsInset={windowButtonsInset} />
      </Suspense>
    ) : kind === 'manager' ? (
      <Suspense fallback={null}>
        <ManagerApp backend={tauriBackend} host={managerHost} />
      </Suspense>
    ) : (
      <App backend={tauriBackend} windowButtonsInset={windowButtonsInset} />
    )}
  </StrictMode>,
);
