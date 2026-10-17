import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Modal } from './Modal';

// 全局的小对话框：输入一个值、确认、问密码。用 Promise 包起来，调用处写成同步流程。

export interface PromptOptions {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  okText?: string;
  /** 返回错误文案则不关闭 */
  validate?(value: string): string | null;
}

export interface ConfirmOptions {
  title: string;
  message: string;
  okText?: string;
  danger?: boolean;
}

export interface PasswordOptions {
  title: string;
  message: string;
  /** 是否显示“记住密码” */
  canRemember: boolean;
}

export interface PasswordResult {
  password: string;
  remember: boolean;
}

export interface KeyOptions {
  title: string;
  message: string;
  canRemember: boolean;
}

export interface KeyResult {
  privateKey: string;
  passphrase: string;
  remember: boolean;
}

interface DialogsApi {
  prompt(opts: PromptOptions): Promise<string | null>;
  confirm(opts: ConfirmOptions): Promise<boolean>;
  askPassword(opts: PasswordOptions): Promise<PasswordResult | null>;
  /** 让用户选私钥文件（或粘贴），连接时没有保存的私钥用 */
  askPrivateKey(opts: KeyOptions): Promise<KeyResult | null>;
  /** 只是告知，一个“好”按钮 */
  alert(title: string, message: string): Promise<void>;
}

type Pending =
  | { kind: 'prompt'; opts: PromptOptions; resolve(v: string | null): void }
  | { kind: 'confirm'; opts: ConfirmOptions; resolve(v: boolean): void }
  | { kind: 'password'; opts: PasswordOptions; resolve(v: PasswordResult | null): void }
  | { kind: 'key'; opts: KeyOptions; resolve(v: KeyResult | null): void }
  | { kind: 'alert'; title: string; message: string; resolve(): void };

const Ctx = createContext<DialogsApi | null>(null);

export function useDialogs(): DialogsApi {
  const api = useContext(Ctx);
  if (!api) throw new Error('useDialogs 必须在 DialogsProvider 里使用');
  return api;
}

export function DialogsProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<Pending[]>([]);
  const push = useCallback((p: Pending) => setQueue((q) => [...q, p]), []);
  const pop = useCallback(() => setQueue((q) => q.slice(1)), []);

  const api = useMemo<DialogsApi>(
    () => ({
      prompt: (opts) => new Promise((resolve) => push({ kind: 'prompt', opts, resolve })),
      confirm: (opts) => new Promise((resolve) => push({ kind: 'confirm', opts, resolve })),
      askPassword: (opts) => new Promise((resolve) => push({ kind: 'password', opts, resolve })),
      askPrivateKey: (opts) => new Promise((resolve) => push({ kind: 'key', opts, resolve })),
      alert: (title, message) => new Promise((resolve) => push({ kind: 'alert', title, message, resolve })),
    }),
    [push],
  );

  const current = queue[0];
  return (
    <Ctx.Provider value={api}>
      {children}
      {current?.kind === 'prompt' && <PromptDialog key={queue.length} pending={current} done={pop} />}
      {current?.kind === 'confirm' && <ConfirmDialog key={queue.length} pending={current} done={pop} />}
      {current?.kind === 'password' && <PasswordDialog key={queue.length} pending={current} done={pop} />}
      {current?.kind === 'key' && <KeyDialog key={queue.length} pending={current} done={pop} />}
      {current?.kind === 'alert' && <AlertDialog key={queue.length} pending={current} done={pop} />}
    </Ctx.Provider>
  );
}

function PromptDialog({ pending, done }: { pending: Extract<Pending, { kind: 'prompt' }>; done(): void }) {
  const { opts } = pending;
  const [value, setValue] = useState(opts.initial ?? '');
  const [error, setError] = useState<string | null>(null);
  const cancel = () => {
    pending.resolve(null);
    done();
  };
  const ok = () => {
    const err = opts.validate?.(value) ?? null;
    if (err) {
      setError(err);
      return;
    }
    pending.resolve(value);
    done();
  };
  return (
    <Modal title={opts.title} onClose={cancel} width={380} tone="sheet">
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          ok();
        }}
      >
        {opts.label && <label htmlFor="dlg-prompt">{opts.label}</label>}
        <input
          id="dlg-prompt"
          className="field"
          value={value}
          placeholder={opts.placeholder}
          autoComplete="off"
          spellCheck={false}
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            setValue(e.target.value);
            setError(null);
          }}
        />
        {error && (
          <span role="alert" className="dialog-error">
            {error}
          </span>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={cancel}>
            取消
          </button>
          <button type="submit" className="btn btn-primary">
            {opts.okText ?? '确定'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ConfirmDialog({ pending, done }: { pending: Extract<Pending, { kind: 'confirm' }>; done(): void }) {
  const { opts } = pending;
  const finish = (v: boolean) => {
    pending.resolve(v);
    done();
  };
  return (
    <Modal title={opts.title} onClose={() => finish(false)} width={380} tone="sheet">
      <div className="dialog-body">
        <p className="dialog-message">{opts.message}</p>
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => finish(false)}>
            取消
          </button>
          <button
            type="button"
            className={`btn ${opts.danger ? 'btn-danger' : 'btn-primary'}`}
            data-autofocus
            onClick={() => finish(true)}
          >
            {opts.okText ?? '确定'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AlertDialog({ pending, done }: { pending: Extract<Pending, { kind: 'alert' }>; done(): void }) {
  const finish = () => {
    pending.resolve();
    done();
  };
  return (
    <Modal title={pending.title} onClose={finish} width={380} tone="sheet">
      <div className="dialog-body">
        <p className="dialog-message">{pending.message}</p>
        <div className="dialog-actions">
          <button type="button" className="btn btn-primary" data-autofocus onClick={finish}>
            好
          </button>
        </div>
      </div>
    </Modal>
  );
}

function PasswordDialog({ pending, done }: { pending: Extract<Pending, { kind: 'password' }>; done(): void }) {
  const { opts } = pending;
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const cancel = () => {
    pending.resolve(null);
    done();
  };
  return (
    <Modal title={opts.title} onClose={cancel} width={380} tone="sheet">
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          pending.resolve({ password, remember });
          done();
        }}
      >
        <p className="dialog-message">{opts.message}</p>
        <label htmlFor="dlg-password">密码</label>
        <input
          id="dlg-password"
          className="field"
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(e) => setPassword(e.target.value)}
        />
        {opts.canRemember && (
          <label className="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            记住密码
          </label>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={cancel}>
            取消
          </button>
          <button type="submit" className="btn btn-primary">
            连接
          </button>
        </div>
      </form>
    </Modal>
  );
}

function KeyDialog({ pending, done }: { pending: Extract<Pending, { kind: 'key' }>; done(): void }) {
  const { opts } = pending;
  const [privateKey, setPrivateKey] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [remember, setRemember] = useState(false);
  const cancel = () => {
    pending.resolve(null);
    done();
  };
  return (
    <Modal title={opts.title} onClose={cancel} width={420} tone="sheet">
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (!privateKey.trim()) return;
          pending.resolve({ privateKey, passphrase, remember });
          done();
        }}
      >
        <p className="dialog-message">{opts.message}</p>
        <KeyPicker value={privateKey} fileName={fileName} onChange={(key, name) => { setPrivateKey(key); setFileName(name); }} />
        <label htmlFor="dlg-passphrase">私钥口令（没有则留空）</label>
        <input
          id="dlg-passphrase"
          className="field"
          type="password"
          value={passphrase}
          autoComplete="off"
          onChange={(e) => setPassphrase(e.target.value)}
        />
        {opts.canRemember && (
          <label className="check">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            记住私钥
          </label>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={cancel}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={!privateKey.trim()}>
            连接
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** 私钥选择：选文件读入，或直接粘贴 PEM */
export function KeyPicker({
  value,
  fileName,
  onChange,
}: {
  value: string;
  fileName: string | null;
  onChange(privateKey: string, fileName: string | null): void;
}) {
  const pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    onChange(await file.text(), file.name);
  };
  return (
    <div className="keypick">
      <div className="keypick__row">
        <span className={`field keypick__name${fileName || value ? '' : ' muted'}`}>
          {fileName ?? (value ? '已粘贴私钥' : '未选择')}
        </span>
        <label className="btn">
          选择…
          <input type="file" className="sr-only" tabIndex={-1} onChange={(e) => void pick(e)} />
        </label>
      </div>
      <textarea
        className="field mono keypick__text"
        rows={3}
        value={value}
        placeholder="或在这里粘贴 PEM 格式私钥"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value, null)}
      />
    </div>
  );
}
