import { useRef, useState, type DragEvent } from 'react';
import { secretKeys } from '../../core/connect';
import { hostsStore } from '../../core/hosts-store';
import { mergeImport, type DuplicatePolicy, type MergeOutcome } from '../../core/importers/merge';
import { SOURCES, type SourceInfo } from '../../core/importers/sources';
import type { ImportResult, ImportSource } from '../../core/importers/types';
import { useStore } from '../../core/store';
import type { SshBackend } from '../../types';
import { Modal } from '../common/Modal';
import { collectImportFiles, pickedFromDrop, pickedFromList, type PickedFile } from './import-files';
import { ImportPreview, importTarget, type TargetKind } from './ImportPreview';

// 导入连接：选来源 → 选文件 → 预览 → 完成。解析和合并都在 core/importers 里，这里只管流程和界面。

type Step =
  | { kind: 'source' }
  | { kind: 'file'; source: SourceInfo }
  | { kind: 'preview'; source: SourceInfo; result: ImportResult }
  | { kind: 'done'; source: SourceInfo; result: ImportResult; outcome: MergeOutcome; passwordsSaved: number };

const STEP_LABELS = ['选来源', '选文件', '预览', '完成'];
const stepIndex = (s: Step) => ({ source: 0, file: 1, preview: 2, done: 3 })[s.kind];

interface Props {
  backend: SshBackend;
  onClose(): void;
  /** 导入完成后回调，参数是新建的文件夹 id，管理器用来展开它们 */
  onImported(newFolderIds: string[]): void;
}

export function ImportDialog({ backend, onClose, onImported }: Props) {
  const data = useStore(hostsStore);
  const [step, setStep] = useState<Step>({ kind: 'source' });
  const [sourceId, setSourceId] = useState<ImportSource>('finalshell');
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [policy, setPolicy] = useState<DuplicatePolicy>('skip');
  const [target, setTarget] = useState<TargetKind>('folder');
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);
  const secrets = backend.secrets;

  const readFiles = async (source: SourceInfo, picked: PickedFile[]) => {
    setReading(true);
    setFileError(null);
    try {
      const { files, skipped } = await collectImportFiles(picked, source);
      if (files.length === 0) {
        setFileError(skipped > 0 ? `选中的 ${skipped} 个文件都不是${source.label}的配置文件（扩展名不符或太大）` : '没有选中任何文件');
        return;
      }
      const result = source.parse(files);
      // 默认全选：全部连接 + 没有连接的空文件夹
      const withServers = new Set<string>();
      const parentOf = new Map(result.folders.map((f) => [f.id, f.parentId]));
      for (const s of result.servers) for (let cur = s.parentId; cur; cur = parentOf.get(cur) ?? null) withServers.add(cur);
      setSelected(new Set([...result.servers.map((s) => s.id), ...result.folders.filter((f) => !withServers.has(f.id)).map((f) => f.id)]));
      setPolicy('skip');
      setStep({ kind: 'preview', source, result });
    } catch (e) {
      setFileError(e instanceof Error ? e.message : String(e));
    } finally {
      setReading(false);
    }
  };

  const onDrop = async (e: DragEvent, source: SourceInfo) => {
    e.preventDefault();
    setOver(false);
    await readFiles(source, await pickedFromDrop(e.dataTransfer));
  };

  const runImport = async (source: SourceInfo, result: ImportResult) => {
    setImporting(true);
    try {
      const before = new Set(hostsStore.get().folders.map((f) => f.id));
      const outcome = mergeImport(hostsStore.get(), result, { selected, policy, target: importTarget(source, target) });
      hostsStore.set(outcome.data);
      let passwordsSaved = 0;
      if (secrets.available) {
        for (const p of outcome.passwords) {
          try {
            await secrets.set(secretKeys.password(p.serverId), p.password);
            passwordsSaved++;
          } catch {
            // 保险箱写不进去不影响连接本身
          }
        }
      }
      onImported(outcome.data.folders.filter((f) => !before.has(f.id)).map((f) => f.id));
      setStep({ kind: 'done', source, result, outcome, passwordsSaved });
    } finally {
      setImporting(false);
    }
  };

  const title = step.kind === 'source' ? '导入连接' : `导入连接 · ${step.source.label}`;

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
            {SOURCES.map((s) => (
              <label key={s.id} className={`imp__source${s.id === sourceId ? ' imp__source--on' : ''}`}>
                <input type="radio" name="imp-source" value={s.id} checked={s.id === sourceId} onChange={() => setSourceId(s.id)} />
                <span className="imp__sourceName">{s.label}</span>
                <span className="imp__sourceBlurb">{s.blurb}</span>
              </label>
            ))}
          </div>
        )}

        {step.kind === 'file' && (
          <>
            <dl className="imp__guide">
              <dt>macOS</dt>
              <dd>{step.source.mac}</dd>
              <dt>Windows</dt>
              <dd>{step.source.windows}</dd>
              <dt>选什么</dt>
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
                  <div className="imp__dropBtns">
                    {step.source.directory && (
                      <button type="button" className="btn btn-primary" onClick={() => dirInput.current?.click()}>
                        选择文件夹…
                      </button>
                    )}
                    <button type="button" className={`btn${step.source.directory ? '' : ' btn-primary'}`} onClick={() => fileInput.current?.click()}>
                      选择文件…
                    </button>
                  </div>
                  <span>或把文件{step.source.directory ? '、文件夹' : ''}拖到这里</span>
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
                multiple
                accept={step.source.extensions.map((e) => `.${e}`).join(',') || undefined}
                onChange={(e) => {
                  const picked = pickedFromList(e.target.files ?? []);
                  e.target.value = '';
                  void readFiles(step.source, picked);
                }}
              />
              {step.source.directory && (
                <input
                  ref={dirInput}
                  type="file"
                  className="sr-only"
                  tabIndex={-1}
                  multiple
                  {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
                  onChange={(e) => {
                    const picked = pickedFromList(e.target.files ?? []);
                    e.target.value = '';
                    void readFiles(step.source, picked);
                  }}
                />
              )}
            </div>
          </>
        )}

        {step.kind === 'preview' && (
          <ImportPreview
            source={step.source}
            result={step.result}
            existing={data}
            selected={selected}
            onSelected={setSelected}
            policy={policy}
            onPolicy={setPolicy}
            target={target}
            onTarget={setTarget}
            secretsAvailable={secrets.available}
          />
        )}

        {step.kind === 'done' && (
          <div className="imp__done">
            <div className="imp__big">
              已导入 {step.outcome.added} 个连接、{step.outcome.folders} 个文件夹
            </div>
            <div>
              {secrets.available
                ? `保存了 ${step.passwordsSaved} 个密码`
                : step.outcome.passwords.length > 0
                  ? `${step.outcome.passwords.length} 个密码没有保存（网页端不保存密码，连接时再输入）`
                  : '没有密码需要保存'}
            </div>
            {(step.outcome.skipped > 0 || step.outcome.overwritten > 0) && (
              <div className="muted">
                {step.outcome.skipped > 0 && `跳过 ${step.outcome.skipped} 个重名连接`}
                {step.outcome.skipped > 0 && step.outcome.overwritten > 0 && ' · '}
                {step.outcome.overwritten > 0 && `覆盖 ${step.outcome.overwritten} 个现有连接`}
              </div>
            )}
            {step.result.issues.length > 0 && <div className="muted">{step.result.issues.length} 条解析失败，没有导入</div>}
          </div>
        )}
      </div>

      <div className="imp__foot">
        {step.kind === 'preview' && (
          <span className="muted ellipsis">
            {target === 'folder' ? `导入到根目录下的「${step.source.folderName}」` : '导入到根目录'}
          </span>
        )}
        {(step.kind === 'file' || step.kind === 'preview') && (
          <button
            type="button"
            className="btn"
            disabled={reading || importing}
            onClick={() => setStep(step.kind === 'file' ? { kind: 'source' } : { kind: 'file', source: step.source })}
          >
            上一步
          </button>
        )}
        {step.kind !== 'done' && (
          <button type="button" className="btn imp__cancel" onClick={onClose}>
            取消
          </button>
        )}
        {step.kind === 'source' && (
          <button type="button" className="btn btn-primary" onClick={() => setStep({ kind: 'file', source: SOURCES.find((s) => s.id === sourceId)! })}>
            下一步
          </button>
        )}
        {step.kind === 'preview' && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={importing || selected.size === 0}
            onClick={() => void runImport(step.source, step.result)}
          >
            {importing ? '导入中…' : '导入'}
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
