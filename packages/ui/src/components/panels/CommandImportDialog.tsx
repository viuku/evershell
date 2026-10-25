import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { findDuplicateCommands, mergeCommands, type CommandMergeOutcome, type GroupMode } from '../../core/importers/commands/merge';
import {
  COMMAND_SOURCES,
  commandSourceInfo,
  firstFoundCommands,
  scanLocalCommands,
  type CommandScan,
  type CommandSourceInfo,
} from '../../core/importers/commands/sources';
import type { CommandImportResult, CommandSource, ImportedCommand } from '../../core/importers/commands/types';
import { newId } from '../../core/storage';
import { commitSnippetData, currentSnippetData, groupsStore, listGroups, snippetsStore, type Snippet } from '../../core/snippets-store';
import { useStore } from '../../core/store';
import type { SshBackend } from '../../types';
import { DisclosureIcon, FolderFillIcon } from '../common/Icons';
import { Modal } from '../common/Modal';
import { collectImportFiles, pickedFromDrop, pickedFromList, type PickedFile } from '../manager/import-files';

// 导入快捷命令：选来源 → 选文件 → 预览 → 完成，和导入连接一样（components/manager/ImportDialog.tsx），
// 样式也共用 manager.css 里的 .imp__*。解析和合并在 core/importers/commands，规格见 docs/specs/command-import.md。

type Step =
  | { kind: 'source' }
  | { kind: 'file'; source: CommandSourceInfo }
  /** from：一键导入时读的位置，「上一步」回来源页；手动选文件时为 null */
  | { kind: 'preview'; source: CommandSourceInfo; result: CommandImportResult; from: string | null }
  | { kind: 'done'; source: CommandSourceInfo; result: CommandImportResult; outcome: CommandMergeOutcome; skipped: number };

const STEP_LABELS = ['选择来源', '选择文件', '预览', '完成'];
const stepIndex = (s: Step) => ({ source: 0, file: 1, preview: 2, done: 3 })[s.kind];
const oneGroupName = (source: CommandSourceInfo) => `从 ${source.label} 导入`;
const modeOf = (kind: GroupMode['kind'], source: CommandSourceInfo): GroupMode =>
  kind === 'one' ? { kind: 'one', name: oneGroupName(source) } : { kind: 'keep' };

interface Props {
  backend: SshBackend;
  onClose(): void;
  /** 导入完成后回调，参数是导入的第一条命令所在的分类，命令页切过去 */
  onImported(group: string | null): void;
}

export function CommandImportDialog({ backend, onClose, onImported }: Props) {
  const existing = useStore(snippetsStore);
  const [step, setStep] = useState<Step>({ kind: 'source' });
  const [sourceId, setSourceId] = useState<CommandSource>('finalshell');
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [modeKind, setModeKind] = useState<GroupMode['kind']>('keep');
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  /** 各来源默认位置的查找结果；网页端、还没查完时为 null */
  const [local, setLocal] = useState<Map<CommandSource, CommandScan> | null>(null);
  const userPicked = useRef(false);

  useEffect(() => {
    if (!backend.findLocalCommands) return;
    let alive = true;
    backend
      .findLocalCommands()
      .then((list) => {
        if (!alive) return;
        const scan = scanLocalCommands(list);
        setLocal(scan);
        const first = firstFoundCommands(scan);
        if (first && !userPicked.current) setSourceId(first);
      })
      .catch(() => {
        // 查不了就和以前一样手动选文件
      });
    return () => {
      alive = false;
    };
  }, [backend]);

  /** 默认勾选：和已有的重复的、有做不到的写法的不勾 */
  const defaultSelection = (result: CommandImportResult, mode: GroupMode) => {
    const dup = findDuplicateCommands(snippetsStore.get(), result, mode);
    return new Set(result.commands.filter((c) => !dup.has(c.id) && !c.unsupported).map((c) => c.id));
  };

  const showPreview = (source: CommandSourceInfo, result: CommandImportResult, from: string | null) => {
    setModeKind('keep');
    setSelected(defaultSelection(result, { kind: 'keep' }));
    setStep({ kind: 'preview', source, result, from });
  };

  const readFiles = async (source: CommandSourceInfo, picked: PickedFile[]) => {
    setReading(true);
    setFileError(null);
    try {
      const { files, skipped } = await collectImportFiles(picked, source);
      if (files.length === 0) {
        setFileError(skipped > 0 ? `所选的 ${skipped} 个文件均不是 ${source.label} 的配置文件（扩展名不符或文件过大）` : '未选择任何文件');
        return;
      }
      showPreview(source, source.parse(files), null);
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    } finally {
      setReading(false);
    }
  };

  const onDrop = async (e: DragEvent, source: CommandSourceInfo) => {
    e.preventDefault();
    setOver(false);
    await readFiles(source, await pickedFromDrop(e.dataTransfer));
  };

  const runImport = (source: CommandSourceInfo, result: CommandImportResult) => {
    setImporting(true);
    try {
      const outcome = mergeCommands(currentSnippetData(), result, {
        selected,
        mode: modeOf(modeKind, source),
        now: Date.now(),
        newId: () => newId('snp'),
      });
      commitSnippetData(outcome.data);
      const first = result.commands.find((c) => selected.has(c.id));
      onImported(first ? (modeKind === 'one' ? oneGroupName(source) : first.group) : null);
      setStep({ kind: 'done', source, result, outcome, skipped: result.commands.length - outcome.added });
    } finally {
      setImporting(false);
    }
  };

  const title = step.kind === 'source' ? '导入快捷命令' : `导入快捷命令 · ${step.source.label}`;
  const chosen = commandSourceInfo(sourceId);
  const scan = step.kind === 'source' ? local?.get(sourceId) : undefined;

  return (
    <Modal title={title} onClose={onClose} width={660} height={540} tone="sheet" className="imp">
      <div className="imp__steps" aria-label="步骤">
        {STEP_LABELS.map((label, i) => (
          <span key={label} className={i === stepIndex(step) ? 'imp__step imp__step--on' : 'imp__step'}>
            {i + 1} {label}
          </span>
        ))}
      </div>

      <div className="imp__body">
        {step.kind === 'source' && (
          <div className="imp__sources" role="radiogroup" aria-label="来源">
            {COMMAND_SOURCES.map((s) => {
              const found = local?.get(s.id);
              return (
                <label key={s.id} className={`imp__source${s.id === sourceId ? ' imp__source--on' : ''}`}>
                  <input
                    type="radio"
                    name="cmd-imp-source"
                    value={s.id}
                    checked={s.id === sourceId}
                    onChange={() => {
                      userPicked.current = true;
                      setSourceId(s.id);
                    }}
                  />
                  <span className="imp__sourceName">{s.label}</span>
                  {found?.state === 'found' && <span className="imp__found">已找到 {found.result.commands.length} 条命令</span>}
                  <span className="imp__sourceBlurb">{s.blurb}</span>
                </label>
              );
            })}
          </div>
        )}

        {step.kind === 'file' && (
          <>
            <dl className="imp__guide">
              <dt>macOS</dt>
              <dd>{step.source.mac}</dd>
              <dt>Windows</dt>
              <dd>{step.source.windows}</dd>
              <dt>选择内容</dt>
              <dd>{step.source.pick}</dd>
            </dl>
            <div
              className={`imp__drop${over ? ' imp__drop--over' : ''}`}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => void onDrop(e, step.source)}
            >
              {reading ? (
                <span>正在读取…</span>
              ) : (
                <>
                  <button type="button" className="btn btn-primary" onClick={() => fileInput.current?.click()}>
                    选择文件…
                  </button>
                  <span>或将文件拖到此处</span>
                  {fileError && (
                    <span role="alert" className="dialog-error">
                      {fileError}
                    </span>
                  )}
                </>
              )}
              <input
                ref={fileInput}
                type="file"
                className="sr-only"
                tabIndex={-1}
                accept={step.source.extensions.map((e) => `.${e}`).join(',') || undefined}
                onChange={(e) => {
                  const picked = pickedFromList(e.target.files ?? []);
                  e.target.value = '';
                  void readFiles(step.source, picked);
                }}
              />
            </div>
          </>
        )}

        {step.kind === 'preview' && step.from && (
          <div className="imp__from muted ellipsis" title={step.from}>
            读取自 <span className="mono">{step.from}</span>
          </div>
        )}
        {step.kind === 'preview' && (
          <CommandPreview
            source={step.source}
            result={step.result}
            existing={existing}
            selected={selected}
            onSelected={setSelected}
            modeKind={modeKind}
            onModeKind={(k) => {
              setModeKind(k);
              setSelected(defaultSelection(step.result, modeOf(k, step.source)));
            }}
          />
        )}

        {step.kind === 'done' && (
          <div className="imp__done">
            <div className="imp__big">已导入 {step.outcome.added} 条命令</div>
            {step.outcome.newGroups.length > 0 && (
              <div>
                已新建 {step.outcome.newGroups.length} 个分类：{step.outcome.newGroups.join('、')}
              </div>
            )}
            <div className="muted">
              {step.outcome.noEnter > 0 ? `其中 ${step.outcome.noEnter} 条不自动回车` : '均为自动回车的命令'}
              {step.skipped > 0 && ` · ${step.skipped} 条未勾选，未导入`}
            </div>
            {step.result.issues.length > 0 && <div className="muted">{step.result.issues.length} 条无法读取，未导入</div>}
          </div>
        )}
      </div>

      <div className="imp__foot">
        {scan?.state === 'found' && (
          <button type="button" className="btn" onClick={() => setStep({ kind: 'file', source: chosen })}>
            手动选择…
          </button>
        )}
        {step.kind === 'source' && (
          <span className="muted ellipsis" title={scan?.location}>
            {scan?.state === 'found' && (
              <>
                从 <span className="mono">{scan.location}</span> 读取
              </>
            )}
            {scan?.state === 'empty' && (
              <>
                <span className="mono">{scan.location}</span> 中没有快捷命令
              </>
            )}
            {scan?.state === 'missing' && `未在默认位置找到 ${chosen.label} 的快捷命令`}
            {scan?.state === 'error' && `无法读取 ${chosen.label} 的配置：${scan.message}`}
            {!scan && chosen.manualOnly}
          </span>
        )}
        {step.kind === 'preview' && (
          <span className="muted ellipsis">
            {modeKind === 'keep' ? '放入原分类，同名分类将合并到现有分类' : `全部放入「${oneGroupName(step.source)}」`}
          </span>
        )}
        {(step.kind === 'file' || step.kind === 'preview') && (
          <button
            type="button"
            className="btn"
            disabled={reading || importing}
            onClick={() => setStep(step.kind === 'file' || step.from ? { kind: 'source' } : { kind: 'file', source: step.source })}
          >
            上一步
          </button>
        )}
        {step.kind !== 'done' && (
          <button type="button" className="btn imp__cancel" onClick={onClose}>
            取消
          </button>
        )}
        {step.kind === 'source' &&
          (scan?.state === 'found' ? (
            <button type="button" className="btn btn-primary" onClick={() => showPreview(chosen, scan.result, scan.location)}>
              一键导入
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => setStep({ kind: 'file', source: chosen })}>
              下一步
            </button>
          ))}
        {step.kind === 'preview' && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={importing || selected.size === 0}
            onClick={() => runImport(step.source, step.result)}
          >
            {importing ? '正在导入…' : '导入'}
          </button>
        )}
        {step.kind === 'done' && (
          <button type="button" className="btn btn-primary imp__cancel" data-autofocus onClick={onClose}>
            完成
          </button>
        )}
      </div>
    </Modal>
  );
}

type Row = { kind: 'group'; name: string; commands: ImportedCommand[]; open: boolean } | { kind: 'command'; command: ImportedCommand };

/** 预览：按分类分组的命令表，每行一个勾选框；命令显示完整内容，看过再导 */
function CommandPreview({
  source,
  result,
  existing,
  selected,
  onSelected,
  modeKind,
  onModeKind,
}: {
  source: CommandSourceInfo;
  result: CommandImportResult;
  existing: Snippet[];
  selected: ReadonlySet<string>;
  onSelected(next: Set<string>): void;
  modeKind: GroupMode['kind'];
  onModeKind(kind: GroupMode['kind']): void;
}) {
  const [closed, setClosed] = useState<Set<string>>(() => new Set());
  const saved = useStore(groupsStore);
  const duplicates = useMemo(() => findDuplicateCommands(existing, result, modeOf(modeKind, source)), [existing, result, modeKind, source]);
  const existingGroups = useMemo(() => new Set(listGroups(saved, existing)), [saved, existing]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const name of result.groups) {
      const commands = result.commands.filter((c) => c.group === name);
      if (commands.length === 0) continue;
      const open = !closed.has(name);
      out.push({ kind: 'group', name, commands, open });
      if (open) for (const c of commands) out.push({ kind: 'command', command: c });
    }
    return out;
  }, [result, closed]);

  const toggle = (ids: string[], on: boolean) => {
    const next = new Set(selected);
    for (const id of ids) if (on) next.add(id);
    else next.delete(id);
    onSelected(next);
  };
  const allOn = result.commands.length > 0 && result.commands.every((c) => selected.has(c.id));
  const noEnter = result.commands.filter((c) => c.noEnter).length;
  const groupCount = result.groups.filter((g) => result.commands.some((c) => c.group === g)).length;
  const unsupported = result.commands.filter((c) => c.unsupported).length;

  return (
    <>
      <div className="imp__options">
        <label className="check">
          <input type="checkbox" checked={allOn} onChange={() => toggle(result.commands.map((c) => c.id), !allOn)} />
          全选
        </label>
        <span className="muted">
          已选 {selected.size} / {result.commands.length} 条 · {groupCount} 个分类
          {noEnter > 0 && ` · ${noEnter} 条不自动回车`}
        </span>
        <label className="imp__inline">
          放入
          <select className="field" value={modeKind} onChange={(e) => onModeKind(e.target.value as GroupMode['kind'])} aria-label="目标分类">
            <option value="keep">原分类</option>
            <option value="one">新分类「{oneGroupName(source)}」</option>
          </select>
        </label>
      </div>
      <div className="scroll imp__tree">
        <div className="grid-head grid-head--sticky imp__cols imp__cols--cmd">
          <span>名称</span>
          <span>命令</span>
          <span>回车</span>
        </div>
        {rows.length === 0 ? (
          <div className="empty">未读取到可导入的命令</div>
        ) : (
          rows.map((row) => {
            if (row.kind === 'group') {
              const ids = row.commands.map((c) => c.id);
              const n = ids.filter((id) => selected.has(id)).length;
              const isNew = modeKind === 'keep' && !existingGroups.has(row.name);
              return (
                <div key={`g:${row.name}`} className="grid-row imp__cols imp__cols--cmd imp__row" onClick={() => toggle(ids, n !== ids.length)}>
                  <span className="mgr__name">
                    <input
                      type="checkbox"
                      checked={n === ids.length}
                      ref={(el) => {
                        if (el) el.indeterminate = n > 0 && n < ids.length;
                      }}
                      aria-label={`导入分类 ${row.name}`}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggle(ids, n !== ids.length)}
                    />
                    <span className="mgr__disclosure">
                      <button
                        type="button"
                        className="imp__disc"
                        aria-label={row.open ? '折叠' : '展开'}
                        aria-expanded={row.open}
                        onClick={(e) => {
                          e.stopPropagation();
                          setClosed((c) => {
                            const next = new Set(c);
                            if (next.has(row.name)) next.delete(row.name);
                            else next.add(row.name);
                            return next;
                          });
                        }}
                      >
                        <DisclosureIcon open={row.open} />
                      </button>
                    </span>
                    <FolderFillIcon size={16} />
                    <span className="ellipsis">{row.name}</span>
                    <span className="muted mgr__count">{ids.length} 条</span>
                    {isNew && <span className="imp__tag muted">新分类</span>}
                  </span>
                  <span />
                  <span />
                </div>
              );
            }
            const c = row.command;
            const lines = c.cmd.split('\n');
            return (
              <div
                key={c.id}
                className="grid-row imp__cols imp__cols--cmd imp__row"
                onClick={() => toggle([c.id], !selected.has(c.id))}
              >
                <span className="mgr__name imp__cmdName">
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    aria-label={`导入 ${c.name}`}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggle([c.id], !selected.has(c.id))}
                  />
                  <span className="ellipsis">{c.name}</span>
                  {duplicates.has(c.id) && <span className="imp__tag imp__tag--warn">已存在</span>}
                  {c.unsupported && (
                    <span className="imp__tag imp__tag--warn" data-tip={c.unsupported}>
                      含特殊语法
                    </span>
                  )}
                </span>
                {/* 整条命令放在悬停提示里：多行的只显示第一行 */}
                <span className={`mono ellipsis${selected.has(c.id) ? '' : ' muted'}`} data-tip={c.cmd}>
                  {lines[0]}
                  {lines.length > 1 && <span className="muted imp__lines">共 {lines.length} 行</span>}
                </span>
                <span>{c.noEnter ? <span className="imp__tag imp__tag--accent">不自动</span> : <span className="muted">自动</span>}</span>
              </div>
            );
          })
        )}
      </div>
      {modeKind === 'keep' && duplicates.size > 0 && (
        <div className="imp__warn">{duplicates.size} 条与 EverShell 中的现有命令相同（分类和内容均相同），默认未勾选。如需重复导入，请手动勾选。</div>
      )}
      {unsupported > 0 && (
        <div className="imp__warn">
          {unsupported} 条使用了 {source.label} 专有语法，EverShell 无法实现相同效果，默认未勾选。将指针悬停在「含特殊语法」上可查看原因。
        </div>
      )}
      <div className="muted imp__note">单击命令即会发送到服务器执行，请在导入前确认内容。将指针悬停在命令上可查看完整内容。</div>
      {result.warnings.map((w) => (
        <div key={w} className="imp__warn">
          {w}
        </div>
      ))}
      {result.issues.length > 0 && (
        <details className="imp__issues">
          <summary>{result.issues.length} 条未导入</summary>
          <ul>
            {result.issues.map((i, n) => (
              <li key={n}>
                {i.file && <span className="mono">{i.file}</span>}
                {i.file && ' — '}
                {i.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
