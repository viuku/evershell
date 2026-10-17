import { Modal } from '@evershell/ui';
import { useState } from 'react';
import type { RelayConfig } from './wasm-backend';

const STORAGE_KEY = 'evershell.relay';
const DEFAULT: RelayConfig = { url: 'ws://127.0.0.1:8787', token: '' };

// 只是本机便利：记住上次填的中转地址。M2 会换成账号登录后下发的短期票据。
export function loadRelay(): RelayConfig {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? { ...DEFAULT, ...JSON.parse(saved) } : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

function saveRelay(relay: RelayConfig) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(relay));
  } catch {}
}

/** ≡ 菜单里的“中转设置…”弹窗 */
export function RelaySettingsDialog(props: { initial: RelayConfig; onSave(relay: RelayConfig): void; onClose(): void }) {
  const [url, setUrl] = useState(props.initial.url);
  const [token, setToken] = useState(props.initial.token);

  const save = () => {
    const next = { url: url.trim(), token };
    saveRelay(next);
    props.onSave(next);
    props.onClose();
  };

  return (
    <Modal title="中转设置" onClose={props.onClose} width={440} tone="sheet">
      <form
        className="relay"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label htmlFor="relay-url" className="lbl">
          中转地址
        </label>
        <input
          id="relay-url"
          className="field mono"
          value={url}
          placeholder="ws://127.0.0.1:8787"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setUrl(e.target.value)}
        />
        <label htmlFor="relay-token" className="lbl">
          令牌
        </label>
        <input id="relay-token" className="field mono" type="password" value={token} autoComplete="off" onChange={(e) => setToken(e.target.value)} />
        <span className="relay__hint">SSH 在浏览器内加密，中转只转发字节，看不到密码和私钥。</span>
        <div className="relay__actions">
          <button type="button" className="btn" onClick={props.onClose}>
            取消
          </button>
          <button type="submit" className="btn btn-primary">
            保存
          </button>
        </div>
      </form>
    </Modal>
  );
}
