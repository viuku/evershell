import { App, isMac } from '@evershell/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { tauriBackend } from './tauri-backend';

// Mac 上系统标题栏是透明的（tauri.macos.conf.json），红绿灯叠在界面左上角，约占 78px 宽
const windowButtonsInset = isMac ? 78 : undefined;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App backend={tauriBackend} windowButtonsInset={windowButtonsInset} />
  </StrictMode>,
);
