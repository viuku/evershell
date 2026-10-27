import { useState } from 'react';
import { formatBytesLong, formatMtime } from '../../core/format';
import { formatPerm, parseOctal, parsePerm, PERM_PRESETS, toOctal } from '../../core/permissions';
import type { FileEntry, PermScope } from '../../types';
import { FileIcon, FolderFillIcon } from '../common/Icons';
import { Modal } from '../common/Modal';

// 文件权限对话框，设计稿方案 A（所有者 2026-10-26 选的）：上面是名称和位置，中间一张权限表
// （每行最右边是这一行的数字），下面是数字表示、常用权限和文件夹的应用范围

interface Props {
  cwd: string;
  /** 右键时选中的项，至少一项 */
  entries: readonly FileEntry[];
  onCancel(): void;
  onApply(mode: number, scope: PermScope): void;
}

const WHO = [
  { label: '所有者', shift: 6 },
  { label: '用户组', shift: 3 },
  { label: '其他用户', shift: 0 },
] as const;
const BITS = [
  { label: '读取', bit: 4 },
  { label: '写入', bit: 2 },
  { label: '执行', bit: 1 },
] as const;
const SPECIAL = [
  { label: 'SUID', bit: 0o4000 },
  { label: 'SGID', bit: 0o2000 },
  { label: '粘滞位', bit: 0o1000 },
] as const;
const RANGES: { id: Exclude<PermScope, 'self'>; label: string }[] = [
  { id: 'all', label: '文件和文件夹' },
  { id: 'dirs', label: '仅文件夹' },
  { id: 'files', label: '仅文件' },
];

/** 几项都一样时给那个值，不一样时写「多个」 */
function same(values: readonly string[]): string {
  const first = values[0] ?? '';
  return values.every((v) => v === first) ? first : '多个';
}

export function PermissionsDialog({ cwd, entries, onCancel, onApply }: Props) {
  const first = entries[0];
  const one = entries.length === 1 ? first : undefined;
  const [mode, setMode] = useState(() => (first ? parsePerm(first.perm) : null) ?? 0o644);
  /** 数字框里正在输入、还不是合法数字的文字 */
  const [draft, setDraft] = useState<string | null>(null);
  const [recursive, setRecursive] = useState(false);
  const [range, setRange] = useState<Exclude<PermScope, 'self'>>('all');
  const dirs = entries.filter((e) => e.kind === 'dir').length;
  const hasDir = dirs > 0;
  const scope: PermScope = hasDir && recursive ? range : 'self';
  const kind = one?.kind ?? (hasDir ? 'dir' : 'file');
  const invalid = draft !== null && parseOctal(draft) === null;

  const set = (next: number) => {
    setMode(next & 0o7777);
    setDraft(null);
  };

  const detail = one
    ? one.kind === 'dir'
      ? `${cwd} · 文件夹 · 修改于 ${formatMtime(one.mtime)}`
      : `${cwd} · ${one.kind === 'link' ? '链接' : formatBytesLong(one.size)} · 修改于 ${formatMtime(one.mtime)}`
    : `${cwd} · ${[dirs > 0 ? `${dirs} 个文件夹` : '', entries.length - dirs > 0 ? `${entries.length - dirs} 个文件` : ''].filter(Boolean).join('、')}`;

  const rangeText = { all: '全部内容', dirs: '文件夹', files: '文件' }[range];
  const summary = one
    ? one.kind !== 'dir'
      ? `将修改「${one.name}」`
      : !recursive
        ? `仅修改文件夹「${one.name}」本身`
        : range === 'files'
          ? `将修改「${one.name}」中的全部文件，不含文件夹本身`
          : `将修改「${one.name}」及其中的${rangeText}`
    : `将把选中的 ${entries.length} 项统一设为 ${toOctal(mode)}${scope !== 'self' ? `，并应用到文件夹中的${rangeText}` : ''}`;

  return (
    <Modal title="文件权限" onClose={onCancel} width={460} tone="sheet">
      <form
        className="perm"
        onSubmit={(e) => {
          e.preventDefault();
          if (!invalid) onApply(mode, scope);
        }}
      >
        <div className="perm__head">
          {kind === 'dir' ? <FolderFillIcon size={34} /> : <FileIcon size={34} style={{ opacity: 0.75 }} />}
          <div className="perm__title">
            <span className="perm__name ellipsis">{one ? one.name : `已选中 ${entries.length} 项`}</span>
            <span className="muted ellipsis">{detail}</span>
          </div>
        </div>
        <div className="perm__body">
          <div className="perm__owners">
            <span className="muted">所有者</span>
            <span className="mono ellipsis">{same(entries.map((e) => e.owner))}</span>
            <span className="muted">用户组</span>
            <span className="mono ellipsis">{same(entries.map((e) => e.group))}</span>
          </div>
          <div className="perm__table" role="group" aria-label="权限">
            <div className="perm__row perm__row--head muted">
              <span>对象</span>
              {BITS.map((b) => (
                <span key={b.label} className="perm__cell">
                  {b.label}
                </span>
              ))}
              <span className="perm__cell">数字</span>
            </div>
            {WHO.map((w) => (
              <div key={w.label} className="perm__row">
                <span>{w.label}</span>
                {BITS.map((b) => {
                  const bit = b.bit << w.shift;
                  return (
                    <label key={b.label} className="perm__cell">
                      <input type="checkbox" aria-label={`${w.label}${b.label}`} checked={(mode & bit) !== 0} onChange={() => set(mode ^ bit)} />
                    </label>
                  );
                })}
                <span className="perm__cell mono perm__digit">{(mode >> w.shift) & 7}</span>
              </div>
            ))}
            <div className="perm__special">
              <span className="muted">特殊权限</span>
              {SPECIAL.map((s) => (
                <label key={s.label}>
                  <input type="checkbox" checked={(mode & s.bit) !== 0} onChange={() => set(mode ^ s.bit)} />
                  {s.label}
                </label>
              ))}
            </div>
          </div>
          <div className="perm__line">
            <label htmlFor="perm-octal" className="muted">
              数字表示
            </label>
            <input
              id="perm-octal"
              className="field mono perm__octal"
              value={draft ?? toOctal(mode)}
              maxLength={4}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={invalid || undefined}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-7]/g, '');
                const parsed = parseOctal(v);
                if (parsed !== null) setMode(parsed);
                setDraft(v);
              }}
              onBlur={() => !invalid && setDraft(null)}
            />
            <span className="mono muted perm__symbolic">{formatPerm(mode, kind)}</span>
            <span className="seg seg--small perm__presets" role="group" aria-label="常用权限">
              {PERM_PRESETS.map((p) => {
                const on = mode === p.mode;
                return (
                  <button
                    key={p.mode}
                    type="button"
                    className={`seg__item mono${on ? ' seg__item--on' : ''}`}
                    title={p.tip}
                    aria-pressed={on}
                    onClick={() => set(p.mode)}
                  >
                    {toOctal(p.mode)}
                  </button>
                );
              })}
            </span>
          </div>
          {hasDir && (
            <div className="perm__line">
              <label className="perm__check">
                <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />
                同时应用到其中的内容
              </label>
              <select
                className="field perm__range"
                aria-label="应用范围"
                disabled={!recursive}
                value={range}
                onChange={(e) => setRange(e.target.value as Exclude<PermScope, 'self'>)}
              >
                {RANGES.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        <div className="perm__foot">
          <span className="muted ellipsis perm__summary">{summary}</span>
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={invalid} data-autofocus>
            确定
          </button>
        </div>
      </form>
    </Modal>
  );
}
