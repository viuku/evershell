import { useEffect, useState, type KeyboardEvent } from 'react';
import { hostsStore } from '../../core/hosts-store';
import { findKey, keyBits, keysStore, keyType, keyUsers, liveKeys, type KeyLibrary } from '../../core/key-library';
import { useStore } from '../../core/store';
import type { LocalTextFile } from '../../types';
import { KeyPicker, useDialogs } from '../common/Dialogs';
import { Modal } from '../common/Modal';

// 私钥库的两个窗口：「选择私钥」列表和「导入私钥」（照 FinalShell，docs/specs/key-library.md）

interface LibraryProps {
  library: KeyLibrary;
  /** 打开时选中哪把：服务器现在用的那把 */
  selectedId: string | null;
  pickFile?: () => Promise<LocalTextFile | null>;
  onPick(id: string): void;
  onClose(): void;
}

/** 选择私钥：列出私钥库，右边导入、改名、删除，双击或「确定」选用 */
export function KeyLibraryDialog({ library, selectedId, pickFile, onPick, onClose }: LibraryProps) {
  const keysData = useStore(keysStore);
  const hosts = useStore(hostsStore);
  const dialogs = useDialogs();
  const keys = liveKeys(keysData);
  const [sel, setSel] = useState<string | null>(() => findKey(keysData, selectedId)?.id ?? keys[0]?.id ?? null);
  const [importing, setImporting] = useState(false);
  const current = findKey(keysData, sel);

  const rename = async () => {
    if (!current) return;
    const name = await dialogs.prompt({
      title: '重命名私钥',
      label: '新名称',
      initial: current.name,
      validate: (v) => (v.trim() ? null : '名称不能为空'),
    });
    if (name) library.rename(current.id, name);
  };

  const remove = async () => {
    if (!current) return;
    const users = keyUsers(hosts, current.id);
    const ok = await dialogs.confirm({
      title: '删除私钥',
      message: users
        ? `确定要删除私钥「${current.name}」吗？有 ${users} 台服务器正在使用该私钥，删除后，${users > 1 ? '这些服务器' : '该服务器'}连接时需要重新选择私钥。`
        : `确定要删除私钥「${current.name}」吗？目前没有服务器使用该私钥。`,
      okText: '删除',
      danger: true,
    });
    if (!ok) return;
    const index = keys.findIndex((k) => k.id === current.id);
    await library.remove(current.id).catch(() => {});
    const rest = liveKeys(keysStore.get());
    setSel(rest[Math.min(index, rest.length - 1)]?.id ?? null);
  };

  // ↑↓ 换选中的，回车选用
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && current) {
      e.preventDefault();
      onPick(current.id);
      return;
    }
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
    if (!step || keys.length === 0) return;
    e.preventDefault();
    const at = keys.findIndex((k) => k.id === sel);
    setSel(keys[Math.max(0, Math.min(keys.length - 1, at + step))]!.id);
  };

  return (
    <Modal title="选择私钥" onClose={onClose} width={540} tone="sheet">
      <div className="keylib">
        <div className="keylib__table scroll" role="listbox" aria-label="私钥" tabIndex={0} onKeyDown={onKey}>
          <div className="grid-head grid-head--sticky keylib__cols">
            <span>名称</span>
            <span>类型</span>
            <span>长度</span>
            <span>用于</span>
          </div>
          {keys.length === 0 ? (
            <div className="empty">暂无私钥。单击右侧的「导入…」添加。</div>
          ) : (
            keys.map((k) => {
              const on = k.id === sel;
              const users = keyUsers(hosts, k.id);
              return (
                <div
                  key={k.id}
                  role="option"
                  aria-selected={on}
                  className={`grid-row keylib__cols keylib__row${on ? ' grid-row--on' : ''}`}
                  onClick={() => setSel(k.id)}
                  onDoubleClick={() => onPick(k.id)}
                >
                  <span className="ellipsis">{k.name}</span>
                  <span className="ellipsis">{keyType(k)}</span>
                  <span>{keyBits(k)}</span>
                  <span className="muted">{users ? `${users} 台` : '—'}</span>
                </div>
              );
            })
          )}
        </div>
        <div className="keylib__side">
          <button type="button" className="btn" onClick={() => setImporting(true)}>
            导入…
          </button>
          <button type="button" className="btn" disabled={!current} onClick={() => void rename()}>
            重命名…
          </button>
          <button type="button" className="btn" disabled={!current} onClick={() => void remove()}>
            删除…
          </button>
        </div>
      </div>
      <div className="keylib__foot">
        <span className="muted keylib__hint">双击某一行可直接选用</span>
        <button type="button" className="btn" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn btn-primary" disabled={!current} onClick={() => current && onPick(current.id)}>
          确定
        </button>
      </div>
      {importing && (
        <ImportKeyDialog
          library={library}
          pickFile={pickFile}
          onClose={() => setImporting(false)}
          onImported={(id) => {
            setSel(id);
            setImporting(false);
          }}
        />
      )}
    </Modal>
  );
}

type Check =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'ok'; text: string }
  | { kind: 'error'; message: string };

interface ImportProps {
  library: KeyLibrary;
  pickFile?: () => Promise<LocalTextFile | null>;
  onImported(id: string): void;
  onClose(): void;
}

/** 导入私钥：选文件或粘贴，起名、填口令；选好就认一下，认不出来、已经导入过的不让导入 */
export function ImportKeyDialog({ library, pickFile, onImported, onClose }: ImportProps) {
  const [privateKey, setPrivateKey] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [check, setCheck] = useState<Check>({ kind: 'idle' });
  const [busy, setBusy] = useState(false);

  // 私钥或口令变了就重新认；停手一会儿再认，带口令的私钥解开要点时间
  useEffect(() => {
    if (!privateKey.trim()) {
      setCheck({ kind: 'idle' });
      return;
    }
    setCheck({ kind: 'checking' });
    let stale = false;
    const timer = setTimeout(() => {
      library.inspect(privateKey, passphrase).then(
        (info) => {
          if (stale) return;
          const same = liveKeys(keysStore.get()).find((k) => k.fingerprint === info.fingerprint);
          if (same) setCheck({ kind: 'error', message: `该私钥已导入，名称为「${same.name}」` });
          else setCheck({ kind: 'ok', text: `已识别为 ${info.algorithm} 私钥，长度 ${info.bits}` });
        },
        (e: unknown) => {
          if (!stale) setCheck({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
        },
      );
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [library, privateKey, passphrase]);

  const ready = check.kind === 'ok' && name.trim() !== '' && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    try {
      const { key } = await library.add({ privateKey, passphrase, name });
      onImported(key.id);
    } catch (e) {
      setCheck({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      setBusy(false);
    }
  };

  return (
    <Modal title="导入私钥" onClose={onClose} width={440} tone="sheet">
      <form
        className="form keyimp"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <span className="lbl">私钥</span>
        <KeyPicker
          value={privateKey}
          fileName={fileName}
          pickFile={pickFile}
          onChange={(text, file) => {
            setPrivateKey(text);
            setFileName(file);
            // 名称没填过就用文件名
            if (file && !name.trim()) setName(file);
          }}
        />
        <label htmlFor="keyimp-name" className="lbl">
          名称
        </label>
        <input
          id="keyimp-name"
          className="field"
          value={name}
          placeholder="私钥名称"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
        />
        <label htmlFor="keyimp-pass" className="lbl">
          口令
        </label>
        <input
          id="keyimp-pass"
          className="field"
          type="password"
          value={passphrase}
          placeholder="私钥未设置口令时请留空"
          autoComplete="off"
          onChange={(e) => setPassphrase(e.target.value)}
        />
        <span />
        {check.kind === 'error' ? (
          <span role="alert" className="dialog-error">
            {check.message}
          </span>
        ) : (
          <span className="muted">
            {check.kind === 'ok'
              ? check.text
              : check.kind === 'checking'
                ? '正在识别私钥…'
                : '选择文件后，此处将显示私钥的类型和长度'}
          </span>
        )}
        <div className="form__actions">
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={!ready}>
            导入
          </button>
        </div>
      </form>
    </Modal>
  );
}
