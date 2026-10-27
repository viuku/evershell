import { App, createMockBackend, guardStrayFileDrops, type MenuItem, type SshBackend } from '@evershell/ui';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { RelaySettingsDialog, loadRelay } from './relay-bar';
import { createWasmBackend, type RelayConfig } from './wasm-backend';
import './web.css';

// URL 带 ?mock 时用假后端，不连服务器也能完整预览界面
const useMock = new URLSearchParams(location.search).has('mock');

let relay = loadRelay();
const backend: SshBackend = useMock ? createMockBackend() : createWasmBackend(() => relay);

function WebApp() {
  const [relayOpen, setRelayOpen] = useState(false);
  const menuExtras: MenuItem[] = useMock
    ? [{ type: 'label', label: '当前使用 Mock 后端（?mock）' }]
    : [{ label: '中转设置…', onSelect: () => setRelayOpen(true) }];

  return (
    <>
      <App backend={backend} menuExtras={menuExtras} />
      {relayOpen && (
        <RelaySettingsDialog
          initial={relay}
          onSave={(next: RelayConfig) => {
            relay = next;
          }}
          onClose={() => setRelayOpen(false)}
        />
      )}
    </>
  );
}

// 文件拖到没人接的地方时不让浏览器把页面换成那个文件
guardStrayFileDrops();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WebApp />
  </StrictMode>,
);
