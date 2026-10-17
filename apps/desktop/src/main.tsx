import { App } from '@evershell/ui';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { tauriBackend } from './tauri-backend';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App backend={tauriBackend} />
  </StrictMode>,
);
