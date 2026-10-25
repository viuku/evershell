import { useEffect, useMemo, useState } from 'react';
import { isAuthFailure, isBlankPassword, secretKeys } from '../../core/connect';
import { describeKey, findKey, KeyLibrary, keysStore } from '../../core/key-library';
import { applyHostKeyDecision, KnownHostsStore, withTrustOnce } from '../../core/known-hosts';
import {
  addServer,
  DEFAULT_ADVANCED,
  folderOptions,
  hostsStore,
  updateServer,
  type AdvancedOptions,
  type AuthMethod,
  type ForwardRule,
  type ServerInput,
  type ServerRecord,
} from '../../core/hosts-store';
import { newId } from '../../core/storage';
import { useStore } from '../../core/store';
import { HostKeyError, type AuthConfig, type SshBackend } from '../../types';
import { KeyPicker, useDialogs } from '../common/Dialogs';
import { Modal } from '../common/Modal';
import { Segmented } from '../common/Segmented';
import { KeyLibraryDialog } from './KeyLibraryDialog';

export type EditTarget = { mode: 'new'; parentId: string | null } | { mode: 'edit'; server: ServerRecord };

type Page = 'general' | 'advanced' | 'forward';

interface Form {
  name: string;
  parentId: string;
  host: string;
  port: string;
  note: string;
  auth: AuthMethod;
  user: string;
  password: string;
  remember: boolean;
  /** 私钥库里选的那把（桌面端） */
  keyId: string | null;
  /** 网页端没有私钥库：选的私钥只在这次弹窗里用（测试连接） */
  privateKey: string;
  keyLabel: string | null;
  passphrase: string;
  advanced: AdvancedOptions;
  forwards: ForwardRule[];
}

function formFor(target: EditTarget): Form {
  if (target.mode === 'edit') {
    const s = target.server;
    return {
      name: s.name,
      parentId: s.parentId ?? '',
      host: s.host,
      port: String(s.port),
      note: s.note,
      auth: s.auth,
      user: s.user,
      password: '',
      remember: true,
      keyId: s.keyId,
      privateKey: '',
      keyLabel: s.keyLabel,
      passphrase: '',
      advanced: { ...DEFAULT_ADVANCED, ...s.advanced },
      forwards: s.forwards,
    };
  }
  return {
    name: '',
    parentId: target.parentId ?? '',
    host: '',
    port: '22',
    note: '',
    auth: 'password',
    user: 'root',
    password: '',
    remember: true,
    keyId: null,
    privateKey: '',
    keyLabel: null,
    passphrase: '',
    advanced: { ...DEFAULT_ADVANCED },
    forwards: [],
  };
}

type TestState = { kind: 'idle' } | { kind: 'running' } | { kind: 'ok'; ms: number; fingerprint: string | null } | { kind: 'fail'; message: string };

interface Props {
  backend: SshBackend;
  target: EditTarget;
  onClose(): void;
  onSaved(id: string): void;
}

/** 新建 / 编辑连接：常规、高级、端口转发三页。高级和端口转发只保存，暂未生效 */
export function EditConnectionDialog({ backend, target, onClose, onSaved }: Props) {
  const data = useStore(hostsStore);
  const [page, setPage] = useState<Page>('general');
  const [form, setForm] = useState<Form>(() => formFor(target));
  const [test, setTest] = useState<TestState>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [hasSavedSecret, setHasSavedSecret] = useState(false);
  const secrets = backend.secrets;
  const library = useMemo(() => KeyLibrary.of(backend), [backend]);
  const keysData = useStore(keysStore);
  const chosenKey = findKey(keysData, form.keyId);
  const [pickingKey, setPickingKey] = useState(false);
  const dialogs = useDialogs();
  const editing = target.mode === 'edit' ? target.server : null;

  // 编辑时看看保险箱里有没有已保存的密码 / 私钥：有密码就在密码框里显示圆点占位
  useEffect(() => {
    if (!editing || !secrets.available) return;
    const key = editing.auth === 'password' ? secretKeys.password(editing.id) : secretKeys.privateKey(editing.id);
    secrets
      .get(key)
      .then((v) => setHasSavedSecret(v !== null))
      .catch(() => {});
  }, [editing, secrets]);

  // 保险箱里查的是原认证方式那一种：原来用私钥、改选密码时，密码框不显示圆点
  const savedPassword = hasSavedSecret && editing?.auth === 'password';
  const savedKey = hasSavedSecret && editing?.auth !== 'password';

  const patch = (p: Partial<Form>) => {
    setForm((f) => ({ ...f, ...p }));
    setTest({ kind: 'idle' });
    setError(null);
  };

  const portNumber = Number(form.port);
  const portValid = Number.isInteger(portNumber) && portNumber > 0 && portNumber <= 65535;

  const validate = (): string | null => {
    if (!form.host.trim()) return '请填写主机';
    if (!portValid) return '端口必须是 1–65535 的整数';
    if (!form.user.trim()) return '请填写用户名';
    return null;
  };

  /** 组装认证信息；编辑时留空就用保险箱里保存的，都没有就不带密码试 */
  const buildAuth = async (serverId: string | null): Promise<AuthConfig | null> => {
    if (form.auth === 'password') {
      if (form.password) return { type: 'password', password: form.password };
      if (serverId && secrets.available) {
        const saved = await secrets.get(secretKeys.password(serverId)).catch(() => null);
        if (saved !== null) return { type: 'password', password: saved };
      }
      return { type: 'password', password: '' };
    }
    if (library.available && form.keyId) {
      const saved = await library.load(form.keyId).catch(() => null);
      if (saved) return { type: 'key', ...saved };
    }
    if (form.privateKey.trim()) return { type: 'key', privateKey: form.privateKey, passphrase: form.passphrase || undefined };
    if (serverId && secrets.available) {
      const saved = await secrets.get(secretKeys.privateKey(serverId)).catch(() => null);
      if (saved) {
        const pass = form.passphrase || (await secrets.get(secretKeys.passphrase(serverId)).catch(() => null)) || undefined;
        return { type: 'key', privateKey: saved, passphrase: pass };
      }
    }
    return null;
  };

  const runTest = async () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    const auth = await buildAuth(editing?.id ?? null);
    if (!auth) {
      setError(library.available ? '请先选择私钥' : '请选择私钥后再测试');
      return;
    }
    setTest({ kind: 'running' });
    const store = new KnownHostsStore(backend.secrets);
    let trustOnce = '';
    // 主机密钥没通过时和正式连接一样弹“安全警告”，按决定记下后再试；最多问两次（第一次连接、密钥又变了）
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = performance.now();
      try {
        const knownHosts = withTrustOnce(await store.load(), trustOnce);
        const session = await backend.connect(
          { host: form.host.trim(), port: portNumber, user: form.user.trim(), auth, cols: 80, rows: 24, knownHosts },
          { onData() {}, onExit() {} },
        );
        const ms = Math.round(performance.now() - started);
        setTest({ kind: 'ok', ms, fingerprint: session.hostKeyFingerprint });
        session.close();
        return;
      } catch (e) {
        if (e instanceof HostKeyError && e.problem.kind !== 'revoked') {
          const outcome = await applyHostKeyDecision(store, e.problem, await dialogs.hostKey(e.problem)).catch(
            () => ({ retry: false }) as const,
          );
          if (outcome.retry) {
            trustOnce = outcome.trustOnce;
            continue;
          }
          setTest({ kind: 'fail', message: e.problem.kind === 'unknown' ? '已取消：没有接受主机密钥' : e.message });
          return;
        }
        const message = e instanceof Error ? e.message : String(e);
        setTest({ kind: 'fail', message: isBlankPassword(auth) && isAuthFailure(message) ? '服务器要密码，请填上密码再测' : message });
        return;
      }
    }
  };

  const save = async () => {
    const err = validate();
    if (err) {
      setError(err);
      return;
    }
    const input: ServerInput = {
      name: form.name.trim() || form.host.trim(),
      parentId: form.parentId || null,
      host: form.host.trim(),
      port: portNumber,
      user: form.user.trim(),
      note: form.note.trim(),
      proto: 'ssh',
      auth: form.auth,
      // 选的私钥可能刚在「选择私钥」里删掉了
      keyId: form.auth === 'key' ? (findKey(keysStore.get(), form.keyId)?.id ?? null) : null,
      keyLabel: form.auth === 'password' ? null : form.keyLabel,
      advanced: form.advanced,
      forwards: form.forwards,
    };
    let id: string;
    if (editing) {
      updateServer(editing.id, input);
      id = editing.id;
    } else {
      id = addServer(input).id;
    }
    if (secrets.available) {
      try {
        if (form.auth === 'password') {
          if (form.password && form.remember) await secrets.set(secretKeys.password(id), form.password);
          else if (!form.remember) await secrets.remove(secretKeys.password(id));
          await secrets.remove(secretKeys.privateKey(id));
          await secrets.remove(secretKeys.passphrase(id));
        } else {
          // 选了私钥库里的私钥，这台服务器自己以前存的那份（还没搬家的）就不要了
          if (input.keyId) {
            await secrets.remove(secretKeys.privateKey(id));
            await secrets.remove(secretKeys.passphrase(id));
          }
          await secrets.remove(secretKeys.password(id));
        }
      } catch {
        // 保险箱写入失败不影响保存连接本身
      }
    }
    onSaved(id);
    onClose();
  };

  const title = editing ? `编辑连接 · ${editing.name}` : '新建连接';
  const otherServers = data.servers.filter((s) => !s.deletedAt && s.id !== editing?.id);

  return (
    <Modal title={title} onClose={onClose} width={470} tone="sheet" className="edit">
      <div className="edit__tabs">
        <Segmented<Page>
          ariaLabel="设置分类"
          size="small"
          value={page}
          onChange={setPage}
          options={[
            { id: 'general', label: '常规' },
            { id: 'advanced', label: '高级' },
            { id: 'forward', label: '端口转发' },
          ]}
        />
      </div>

      <div className="edit__body">
        {page === 'general' && (
          <div className="form form--plain">
            <label htmlFor="e-name" className="lbl">
              名称
            </label>
            <input id="e-name" className="field" value={form.name} placeholder="例如 prod-web-03" autoComplete="off" onChange={(e) => patch({ name: e.target.value })} />
            <label htmlFor="e-group" className="lbl">
              位置
            </label>
            <select id="e-group" className="field edit__select" value={form.parentId} onChange={(e) => patch({ parentId: e.target.value })}>
              <option value="">根目录</option>
              {folderOptions(data).map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            <label htmlFor="e-host" className="lbl">
              主机
            </label>
            <div className="edit__hostRow">
              <input
                id="e-host"
                className="field mono edit__host"
                value={form.host}
                placeholder="IP 或域名"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => patch({ host: e.target.value })}
              />
              <label htmlFor="e-port">端口</label>
              <input id="e-port" className="field mono edit__port" value={form.port} inputMode="numeric" onChange={(e) => patch({ port: e.target.value })} />
            </div>
            <label htmlFor="e-note" className="lbl">
              备注
            </label>
            <textarea id="e-note" className="field" rows={3} value={form.note} placeholder="可选，可换行" onChange={(e) => patch({ note: e.target.value })} />
            <span className="edit__rule" />
            <label htmlFor="e-auth" className="lbl">
              认证方式
            </label>
            <select id="e-auth" className="field edit__select edit__select--auth" value={form.auth} onChange={(e) => patch({ auth: e.target.value as AuthMethod })}>
              <option value="password">密码</option>
              <option value="key">公钥</option>
            </select>
            <label htmlFor="e-user" className="lbl">
              用户名
            </label>
            <input id="e-user" className="field edit__user" value={form.user} autoComplete="off" spellCheck={false} onChange={(e) => patch({ user: e.target.value })} />

            {form.auth === 'password' && (
              <>
                <label htmlFor="e-pass" className="lbl">
                  密码
                </label>
                <div className="edit__stack">
                  <input
                    id="e-pass"
                    className={`field edit__user${savedPassword ? ' edit__savedPass' : ''}`}
                    type="password"
                    value={form.password}
                    placeholder={savedPassword ? '••••••••' : ''}
                    autoComplete="new-password"
                    onChange={(e) => patch({ password: e.target.value })}
                  />
                  {secrets.available ? (
                    <label className="check muted">
                      <input type="checkbox" checked={form.remember} onChange={(e) => patch({ remember: e.target.checked })} />
                      记住密码
                    </label>
                  ) : (
                    <span className="muted">网页端不保存密码，每次连接时询问</span>
                  )}
                </div>
              </>
            )}
            {form.auth === 'key' && library.available && (
              <>
                <span className="lbl">私钥</span>
                <div className="edit__stack">
                  <div className="keychoice">
                    <span className={`field keychoice__name${chosenKey ? '' : ' muted'}`}>{chosenKey ? describeKey(chosenKey) : '未选择'}</span>
                    <button type="button" className="btn" onClick={() => setPickingKey(true)}>
                      选择…
                    </button>
                  </div>
                  <span className="muted">
                    {!chosenKey && form.keyLabel ? `原来用的私钥文件是 ${form.keyLabel}，导入后选上就行` : '私钥和口令加密存在本机，别的服务器也能选同一把'}
                  </span>
                </div>
              </>
            )}
            {form.auth === 'key' && !library.available && (
              <>
                <span className="lbl">私钥</span>
                <div className="edit__stack">
                  <KeyPicker
                    value={form.privateKey}
                    fileName={form.keyLabel}
                    pickFile={backend.pickPrivateKeyFile}
                    onChange={(key, name) => patch({ privateKey: key, keyLabel: name ?? (key ? '已粘贴私钥' : null) })}
                  />
                  {savedKey && !form.privateKey && <span className="muted">已保存私钥，不修改请留空</span>}
                  <label htmlFor="e-passphrase" className="muted edit__inlineLabel">
                    口令
                    <input
                      id="e-passphrase"
                      className="field"
                      type="password"
                      value={form.passphrase}
                      placeholder="没有则留空"
                      autoComplete="off"
                      onChange={(e) => patch({ passphrase: e.target.value })}
                    />
                  </label>
                  {!secrets.available && <span className="muted">网页端不保存私钥，每次连接时选择</span>}
                </div>
              </>
            )}
          </div>
        )}

        {page === 'advanced' && (
          <div className="form form--plain form--wide">
            <span className="edit__pending">这一页的设置会保存，但暂未生效</span>
            <label htmlFor="e-jump" className="lbl">
              跳板机
            </label>
            <select
              id="e-jump"
              className="field edit__select"
              value={form.advanced.jumpServerId ?? ''}
              onChange={(e) => patch({ advanced: { ...form.advanced, jumpServerId: e.target.value || null } })}
            >
              <option value="">不使用</option>
              {otherServers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}（{s.user}@{s.host}）
                </option>
              ))}
            </select>
            <label htmlFor="e-proxy" className="lbl">
              代理
            </label>
            <div className="edit__hostRow">
              <select
                id="e-proxy"
                className="field edit__select"
                value={form.advanced.proxy}
                onChange={(e) => patch({ advanced: { ...form.advanced, proxy: e.target.value as AdvancedOptions['proxy'] } })}
              >
                <option value="none">不使用</option>
                <option value="http">HTTP 代理</option>
                <option value="socks5">SOCKS5 代理</option>
              </select>
              {form.advanced.proxy !== 'none' && (
                <>
                  <input
                    className="field mono edit__host"
                    value={form.advanced.proxyHost}
                    placeholder="代理地址"
                    aria-label="代理地址"
                    onChange={(e) => patch({ advanced: { ...form.advanced, proxyHost: e.target.value } })}
                  />
                  <input
                    className="field mono edit__port"
                    value={String(form.advanced.proxyPort)}
                    aria-label="代理端口"
                    inputMode="numeric"
                    onChange={(e) => patch({ advanced: { ...form.advanced, proxyPort: Number(e.target.value) || 0 } })}
                  />
                </>
              )}
            </div>
            <label htmlFor="e-alive" className="lbl">
              心跳间隔
            </label>
            <div className="edit__hostRow">
              <input
                id="e-alive"
                className="field edit__port"
                value={String(form.advanced.keepAliveSecs)}
                inputMode="numeric"
                onChange={(e) => patch({ advanced: { ...form.advanced, keepAliveSecs: Number(e.target.value) || 0 } })}
              />
              <span className="muted">秒</span>
            </div>
            <label htmlFor="e-enc" className="lbl">
              字符编码
            </label>
            <select id="e-enc" className="field edit__select edit__select--narrow" value={form.advanced.encoding} onChange={(e) => patch({ advanced: { ...form.advanced, encoding: e.target.value } })}>
              <option>UTF-8</option>
              <option>GBK</option>
              <option>Big5</option>
            </select>
            <label htmlFor="e-term" className="lbl">
              终端类型
            </label>
            <select id="e-term" className="field edit__select" value={form.advanced.termType} onChange={(e) => patch({ advanced: { ...form.advanced, termType: e.target.value } })}>
              <option>xterm-256color</option>
              <option>xterm</option>
              <option>vt100</option>
            </select>
          </div>
        )}

        {page === 'forward' && <ForwardPage rules={form.forwards} onChange={(forwards) => patch({ forwards })} />}
      </div>

      <div className="edit__foot">
        <button type="button" className="btn" disabled={test.kind === 'running'} onClick={() => void runTest()}>
          {test.kind === 'running' ? '连接中…' : '测试连接'}
        </button>
        {test.kind === 'ok' && (
          <span role="status" className="edit__ok ellipsis" title={test.fingerprint ?? undefined}>
            ✓ 连接成功 · {test.ms} ms{test.fingerprint ? ` · ${test.fingerprint}` : ''}
          </span>
        )}
        {test.kind === 'fail' && (
          <span role="status" className="edit__fail ellipsis" title={test.message}>
            ✕ {test.message}
          </span>
        )}
        {error && (
          <span role="alert" className="edit__fail ellipsis">
            {error}
          </span>
        )}
        <button type="button" className="btn edit__cancel" onClick={onClose}>
          取消
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void save()}>
          确定
        </button>
      </div>
      {pickingKey && (
        <KeyLibraryDialog
          library={library}
          selectedId={form.keyId}
          pickFile={backend.pickPrivateKeyFile}
          onPick={(id) => {
            patch({ keyId: id });
            setPickingKey(false);
          }}
          onClose={() => setPickingKey(false)}
        />
      )}
    </Modal>
  );
}

const TYPE_LABEL: Record<ForwardRule['type'], string> = { local: '本地', remote: '远程', dynamic: '动态' };

/** 端口转发页：规则表 + 添加 / 删除。只保存，暂未生效 */
function ForwardPage({ rules, onChange }: { rules: ForwardRule[]; onChange(rules: ForwardRule[]): void }) {
  const [sel, setSel] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Omit<ForwardRule, 'id'>>({ type: 'local', bindHost: '127.0.0.1', bindPort: 0, targetHost: '127.0.0.1', targetPort: 0 });

  const add = () => {
    if (!draft.bindPort || (draft.type !== 'dynamic' && !draft.targetPort)) return;
    onChange([...rules, { id: newId('fwd'), ...draft }]);
    setAdding(false);
  };

  return (
    <div className="fwd">
      <span className="edit__pending">端口转发规则会保存，但暂未生效</span>
      <div className="fwd__table">
        <div className="fwd__head">
          <span>类型</span>
          <span>本地</span>
          <span>远程</span>
        </div>
        {rules.length === 0 && !adding && <div className="empty fwd__empty">还没有转发规则</div>}
        {rules.map((r) => (
          <button key={r.id} type="button" className={`fwd__row mono${sel === r.id ? ' fwd__row--on' : ''}`} onClick={() => setSel(r.id)}>
            <span className="fwd__type">{TYPE_LABEL[r.type]}</span>
            <span>
              {r.bindHost}:{r.bindPort}
            </span>
            <span>{r.type === 'dynamic' ? 'SOCKS5' : `${r.targetHost}:${r.targetPort}`}</span>
          </button>
        ))}
        {adding && (
          <div className="fwd__row fwd__row--draft">
            <select className="field" aria-label="类型" value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as ForwardRule['type'] })}>
              <option value="local">本地</option>
              <option value="remote">远程</option>
              <option value="dynamic">动态</option>
            </select>
            <span className="fwd__pair">
              <input className="field mono" aria-label="本地地址" value={draft.bindHost} onChange={(e) => setDraft({ ...draft, bindHost: e.target.value })} />
              <input
                className="field mono fwd__port"
                aria-label="本地端口"
                placeholder="端口"
                inputMode="numeric"
                value={draft.bindPort || ''}
                onChange={(e) => setDraft({ ...draft, bindPort: Number(e.target.value) || 0 })}
              />
            </span>
            {draft.type === 'dynamic' ? (
              <span className="muted">SOCKS5</span>
            ) : (
              <span className="fwd__pair">
                <input className="field mono" aria-label="远程地址" value={draft.targetHost} onChange={(e) => setDraft({ ...draft, targetHost: e.target.value })} />
                <input
                  className="field mono fwd__port"
                  aria-label="远程端口"
                  placeholder="端口"
                  inputMode="numeric"
                  value={draft.targetPort || ''}
                  onChange={(e) => setDraft({ ...draft, targetPort: Number(e.target.value) || 0 })}
                />
              </span>
            )}
          </div>
        )}
      </div>
      <div className="fwd__actions">
        {adding ? (
          <>
            <button type="button" className="btn btn-primary" onClick={add}>
              添加
            </button>
            <button type="button" className="btn" onClick={() => setAdding(false)}>
              取消
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={() => setAdding(true)}>
              添加…
            </button>
            <button
              type="button"
              className="btn"
              disabled={!sel}
              onClick={() => {
                onChange(rules.filter((r) => r.id !== sel));
                setSel(null);
              }}
            >
              删除
            </button>
          </>
        )}
      </div>
    </div>
  );
}
