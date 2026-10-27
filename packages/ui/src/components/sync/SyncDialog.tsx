import { useEffect, useState, type FormEvent } from 'react';
import { useStore } from '../../core/store';
import {
  changePassword,
  describeEnableResult,
  listDevices,
  login,
  logout,
  register,
  relogin,
  removeDevice,
  renameDevice,
  serverInfo,
  syncNow,
  syncStatus,
  validateEnableForm,
  type EnableResult,
  type SyncDevice,
} from '../../core/sync';
import { COUNT_LABELS, newPasswordError, relativeTime, statusDetail, statusWord } from '../../core/sync-text';
import { useDialogs } from '../common/Dialogs';
import { ComputerIcon, GlobeIcon, SpinnerIcon, SuccessIcon, WarnIcon } from '../common/Icons';
import { Modal } from '../common/Modal';
import { Segmented } from '../common/Segmented';

// 云同步窗口（设计稿方案 A：https://claude.ai/artifact/NDmqP3LDsJnQrT4uELxsbh，规格 docs/specs/sync.md）。
// 没开同步时是登录 / 注册；开了以后是状态、设备和账号操作；登录失效时是重新登录。
// 引擎给的错误已经是整句（「操作 + 失败：原因」），原样显示，不再加前缀。

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function SyncDialog({ onClose }: { onClose(): void }) {
  const status = useStore(syncStatus);
  // 开启流程走完、点「完成」之前一直停在开启页，哪怕状态已经变成“已同步”
  const [enabling, setEnabling] = useState(status.state === 'off');
  if (enabling || status.state === 'off') return <EnableView onClose={onClose} onFinished={() => setEnabling(false)} />;
  if (status.state === 'relogin') return <ReloginView onClose={onClose} />;
  return <PanelView onClose={onClose} />;
}

// ---------- 开启：登录 / 注册 ----------

type Mode = 'login' | 'register';
type Registration = 'invite' | 'open' | 'closed';

const STEPS: Record<Mode, string[]> = {
  login: ['正在登录…', '正在下载云端数据…', '正在合并本机数据…'],
  register: ['正在注册…', '正在加密本机数据…', '正在上传本机数据…'],
};

function EnableView({ onClose, onFinished }: { onClose(): void; onFinished(): void }) {
  const [mode, setMode] = useState<Mode>('login');
  const [server, setServer] = useState('');
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [invite, setInvite] = useState('');
  const [error, setError] = useState('');
  const [forgot, setForgot] = useState(false);
  const [registration, setRegistration] = useState<Registration | null>(null);
  const [phase, setPhase] = useState<'form' | 'progress' | 'done'>('form');
  const [step, setStep] = useState(0);
  const [result, setResult] = useState<EnableResult | null>(null);

  const isRegister = mode === 'register';
  const closed = isRegister && registration === 'closed';

  // 服务器地址填完再问要不要邀请码；问不到就照常显示邀请码一栏
  const checkServer = () => {
    const url = server.trim();
    if (!/^https?:\/\/\S+$/i.test(url)) return;
    serverInfo(url)
      .then((info) => setRegistration(info.registration))
      .catch(() => setRegistration(null));
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (closed) return setError('该服务器未开放注册');
    const problem = validateEnableForm({
      mode,
      server,
      account,
      password,
      password2,
      invite,
      inviteRequired: registration !== 'open',
    });
    if (problem) return setError(problem);
    setError('');
    setStep(0);
    setPhase('progress');
    try {
      const opts = { server: server.trim(), account: account.trim(), password };
      const done = isRegister
        ? await register({ ...opts, invite: invite.trim() || undefined }, setStep)
        : await login(opts, setStep);
      setPassword('');
      setPassword2('');
      setResult(done);
      setPhase('done');
    } catch (err) {
      setError(errorText(err));
      setPhase('form');
    }
  };

  if (phase === 'progress') {
    return (
      <Modal title="云同步" onClose={() => {}} width={460}>
        <ol className="sync-steps" aria-live="polite">
          {STEPS[mode].map((text, i) => (
            <li key={text} className={i <= step ? 'sync-steps__item sync-steps__item--on' : 'sync-steps__item'}>
              {i < step ? (
                <SuccessIcon size={14} className="sync-steps__ok" />
              ) : i === step ? (
                <SpinnerIcon size={14} className="spin sync-steps__spin" />
              ) : (
                <span className="sync-steps__dot" />
              )}
              {text}
            </li>
          ))}
        </ol>
      </Modal>
    );
  }

  if (phase === 'done' && result) {
    const finish = () => {
      onFinished();
      onClose();
    };
    return (
      <Modal title="云同步" onClose={finish} width={460}>
        <div className="sync-done">
          <SuccessIcon size={34} className="sync-done__icon" />
          <strong>云同步已开启</strong>
          <p>{describeEnableResult(result)}</p>
        </div>
        <div className="sync-actions">
          <button type="button" className="btn btn-primary sync-actions__main" data-autofocus onClick={finish}>
            完成
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="云同步" onClose={onClose} width={460}>
      <form onSubmit={submit}>
        <div className="sync-mode">
          <Segmented
            options={[
              { id: 'login', label: '登录' },
              { id: 'register', label: '注册账号' },
            ]}
            value={mode}
            onChange={(m) => {
              setMode(m);
              setError('');
              setForgot(false);
            }}
            ariaLabel="登录或注册"
            size="small"
            role="group"
          />
        </div>
        <div className="form sync-form">
          <label className="lbl" htmlFor="sync-server">
            服务器地址
          </label>
          <input
            id="sync-server"
            className="field mono"
            value={server}
            placeholder="https://sync.example.com"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setServer(e.target.value)}
            onBlur={checkServer}
          />
          <label className="lbl" htmlFor="sync-account">
            账号
          </label>
          <input
            id="sync-account"
            className="field"
            value={account}
            autoComplete="username"
            spellCheck={false}
            onChange={(e) => setAccount(e.target.value)}
          />
          <label className="lbl" htmlFor="sync-password">
            同步密码
          </label>
          <input
            id="sync-password"
            className="field"
            type="password"
            value={password}
            autoComplete={isRegister ? 'new-password' : 'current-password'}
            onChange={(e) => setPassword(e.target.value)}
          />
          {isRegister && (
            <>
              <label className="lbl" htmlFor="sync-password2">
                确认密码
              </label>
              <input
                id="sync-password2"
                className="field"
                type="password"
                value={password2}
                autoComplete="new-password"
                onChange={(e) => setPassword2(e.target.value)}
              />
              {registration !== 'open' && !closed && (
                <>
                  <label className="lbl sync-form__top" htmlFor="sync-invite">
                    邀请码
                  </label>
                  <div className="sync-form__stack">
                    <input
                      id="sync-invite"
                      className="field mono"
                      value={invite}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(e) => setInvite(e.target.value)}
                    />
                    <span className="sync-muted">部署同步服务时设置的邀请码</span>
                  </div>
                </>
              )}
            </>
          )}
          {!isRegister && (
            <>
              <span />
              <div className="sync-form__stack">
                <button type="button" className="sync-link" aria-expanded={forgot} onClick={() => setForgot((f) => !f)}>
                  忘记同步密码？
                </button>
                {forgot && (
                  <span className="sync-muted">同步密码无法找回。请在仍已登录的设备上打开「云同步」，选择「修改同步密码」重新设置。</span>
                )}
              </div>
            </>
          )}
        </div>
        <p className="sync-note">
          将同步以下内容：服务器和文件夹（含已保存的密码、私钥）、私钥库、快捷命令、历史命令、最近连接、服务器指纹。数据在本机加密后上传，同步服务器无法查看内容。
        </p>
        {isRegister && (
          <p className="sync-warn">
            <WarnIcon size={14} className="sync-warn__icon" />
            <span>同步密码无法找回。忘记后只能在仍已登录的设备上重新设置；如没有仍已登录的设备，云端数据将无法恢复。</span>
          </p>
        )}
        {closed && <p className="sync-warn">该服务器未开放注册</p>}
        <div className="sync-actions">
          <span role="alert" className="sync-actions__error">
            {error}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={closed}>
            {isRegister ? '注册并开启同步' : '登录并开启同步'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- 开了以后：状态、设备、账号操作 ----------

function PanelView({ onClose }: { onClose(): void }) {
  const status = useStore(syncStatus);
  const dialogs = useDialogs();
  const [name, setName] = useState(status.deviceName ?? '');
  const [nameError, setNameError] = useState('');
  const [devices, setDevices] = useState<SyncDevice[] | null>(null);
  const [devicesError, setDevicesError] = useState('');
  const [flash, setFlash] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);

  const loadDevices = () => {
    setDevicesError('');
    listDevices()
      .then(setDevices)
      .catch((e: unknown) => setDevicesError(errorText(e)));
  };
  useEffect(loadDevices, []);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(''), 2600);
    return () => clearTimeout(t);
  }, [flash]);

  const saveName = () => {
    const next = name.trim();
    if (!next || next === status.deviceName) return setName(status.deviceName ?? '');
    setNameError('');
    renameDevice(next)
      .then(loadDevices)
      .catch((e: unknown) => setNameError(errorText(e)));
  };

  const remove = async (d: SyncDevice) => {
    const ok = await dialogs.confirm({
      title: '移除设备',
      message: `确定要移除「${d.name}」吗？该设备将退出云同步，重新登录后才能继续同步。该设备上已有的数据不会被删除。`,
      okText: '移除',
      danger: true,
    });
    if (!ok) return;
    try {
      await removeDevice(d.id);
      setFlash(`已移除「${d.name}」`);
      loadDevices();
    } catch (e) {
      await dialogs.alert('移除设备', errorText(e));
    }
  };

  const signOut = async () => {
    const ok = await dialogs.confirm({
      title: '退出登录',
      message: '确定要退出云同步吗？本机数据将保留，此后不再与其他设备同步。',
      okText: '退出登录',
      danger: true,
    });
    if (!ok) return;
    await logout();
    onClose();
  };

  const busy = status.state === 'syncing';
  return (
    <Modal title="云同步" onClose={onClose} width={540}>
      <div className="sync-panel">
        <div className="sync-card">
          {busy ? <SpinnerIcon size={16} className="spin sync-card__spin" /> : <span className={`sync-dot sync-dot--big sync-dot--${status.state}`} />}
          <div className="sync-card__text">
            <strong>{statusWord(status.state)}</strong>
            <span className="sync-muted">{statusDetail(status, Date.now())}</span>
          </div>
          {/* 打开时把焦点放在这里，别落到下面的本机名称上，看着像在改名 */}
          <button type="button" className="btn" data-autofocus disabled={busy} onClick={() => void syncNow().catch(() => {})}>
            {status.state === 'error' ? '重试' : '立即同步'}
          </button>
        </div>

        <div className="sync-info">
          <span className="sync-info__label">账号</span>
          <span>{status.account}</span>
          <span className="sync-info__label">服务器</span>
          <span className="mono sync-info__url">{status.server}</span>
          <label className="sync-info__label" htmlFor="sync-device-name">
            本机名称
          </label>
          <div className="sync-form__stack">
            <input
              id="sync-device-name"
              className="field sync-info__name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
            />
            {nameError && <span className="dialog-error">{nameError}</span>}
          </div>
          <span className="sync-info__label sync-info__label--top">同步内容</span>
          <div className="sync-counts">
            {COUNT_LABELS.map(([key, label]) => (
              <div key={key} className="sync-counts__cell">
                <strong>{status.counts[key]}</strong>
                <span className="sync-muted">{label}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="sync-devices">
          <div className="sync-muted sync-devices__title">已登录的设备</div>
          <div role="list" className="sync-devices__list">
            {devices === null && !devicesError && <div className="sync-devices__empty sync-muted">正在加载设备列表…</div>}
            {devicesError && <div className="sync-devices__empty dialog-error">{devicesError}</div>}
            {devices?.map((d) => (
              <div role="listitem" key={d.id} className="sync-devices__row">
                {d.platform === 'web' ? <GlobeIcon size={16} className="sync-devices__icon" /> : <ComputerIcon size={16} className="sync-devices__icon" />}
                <span className="sync-devices__name">{d.name}</span>
                {d.current && <span className="sync-badge">本机</span>}
                <span className="sync-muted sync-devices__when">{d.current ? '刚刚' : relativeTime(d.lastSeenAt, Date.now())}</span>
                {!d.current && (
                  <button type="button" className="btn btn--xs" aria-label={`移除「${d.name}」`} onClick={() => void remove(d)}>
                    移除
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="sync-actions">
        <button type="button" className="btn" onClick={() => setChangingPassword(true)}>
          修改同步密码…
        </button>
        <button type="button" className="btn" onClick={() => void signOut()}>
          退出登录…
        </button>
        <span role="status" className="sync-actions__flash">
          {flash}
        </span>
        <button type="button" className="btn btn-primary sync-actions__main" onClick={onClose}>
          完成
        </button>
      </div>
      {changingPassword && (
        <ChangePasswordDialog
          onClose={() => setChangingPassword(false)}
          onDone={() => {
            setChangingPassword(false);
            setFlash('同步密码已修改');
          }}
        />
      )}
    </Modal>
  );
}

function ChangePasswordDialog({ onClose, onDone }: { onClose(): void; onDone(): void }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = newPasswordError(password, again);
    if (problem) return setError(problem);
    setBusy(true);
    try {
      await changePassword(password);
      onDone();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <Modal title="修改同步密码" onClose={onClose} width={400} tone="sheet">
      <form onSubmit={submit}>
        <div className="form form--wide sync-form">
          <label className="lbl" htmlFor="sync-new-password">
            新同步密码
          </label>
          <input
            id="sync-new-password"
            className="field"
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
          <label className="lbl" htmlFor="sync-new-password2">
            确认新密码
          </label>
          <input
            id="sync-new-password2"
            className="field"
            type="password"
            value={again}
            autoComplete="new-password"
            onChange={(e) => setAgain(e.target.value)}
          />
        </div>
        <p className="sync-muted sync-paragraph">忘记原密码时也可在此重新设置。修改后，其他设备需使用新密码重新登录。</p>
        <div className="sync-actions">
          <span role="alert" className="sync-actions__error">
            {error}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? '正在修改…' : '修改'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- 登录失效：重新登录 ----------

function ReloginView({ onClose }: { onClose(): void }) {
  const status = useStore(syncStatus);
  const dialogs = useDialogs();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) return setError('请输入同步密码');
    setBusy(true);
    setError('');
    try {
      await relogin(password);
      setPassword('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    const ok = await dialogs.confirm({
      title: '退出同步',
      message: '确定要退出云同步吗？本机数据将保留，此后不再与其他设备同步。',
      okText: '退出同步',
      danger: true,
    });
    if (!ok) return;
    await logout();
    onClose();
  };

  return (
    <Modal title="云同步" onClose={onClose} width={420}>
      <form onSubmit={submit}>
        <p className="sync-paragraph">
          {status.message
            ? `${status.message}。`
            : '登录已失效，可能是在其他设备上修改了同步密码，或本机已被移除。请输入同步密码重新登录。'}
        </p>
        <div className="form sync-form">
          <span className="lbl">账号</span>
          <span className="sync-form__value">{status.account}</span>
          <label className="lbl" htmlFor="sync-relogin-password">
            同步密码
          </label>
          <input
            id="sync-relogin-password"
            className="field"
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="sync-actions">
          <button type="button" className="btn" onClick={() => void signOut()}>
            退出同步
          </button>
          <span role="alert" className="sync-actions__error">
            {error}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? '正在登录…' : '登录'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
