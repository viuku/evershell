import { useMemo, useState } from 'react';
import type { HostsData } from '../../core/hosts-store';
import { findDuplicates, type DuplicatePolicy, type ImportTarget } from '../../core/importers/merge';
import type { SourceInfo } from '../../core/importers/sources';
import type { ImportedFolder, ImportedServer, ImportResult } from '../../core/importers/types';
import { DisclosureIcon, FolderFillIcon, ServerIcon } from '../common/Icons';
import { Segmented } from '../common/Segmented';

// 导入预览：和连接管理器一样的文件夹树，每行一个勾选框；下面是导入位置、重名策略和解析问题。
// selected 里放的是连接 id 和“本来就没有连接的空文件夹” id；有连接的文件夹的勾选状态由子项推出来。

export type TargetKind = 'folder' | 'root';

interface Props {
  source: SourceInfo;
  result: ImportResult;
  existing: HostsData;
  selected: ReadonlySet<string>;
  onSelected(next: Set<string>): void;
  policy: DuplicatePolicy;
  onPolicy(p: DuplicatePolicy): void;
  target: TargetKind;
  onTarget(t: TargetKind): void;
  secretsAvailable: boolean;
}

type Row = { kind: 'folder'; folder: ImportedFolder; depth: number; open: boolean; count: number } | { kind: 'server'; server: ImportedServer; depth: number };

export function importTarget(source: SourceInfo, target: TargetKind): ImportTarget {
  return target === 'folder' ? { kind: 'folder', name: source.folderName } : { kind: 'root' };
}

const cmp = (a: string, b: string) => a.localeCompare(b, 'zh-Hans-CN');

export function ImportPreview({ source, result, existing, selected, onSelected, policy, onPolicy, target, onTarget, secretsAvailable }: Props) {
  const [closed, setClosed] = useState<Set<string>>(() => new Set());

  // 每个文件夹下的全部连接（含子文件夹）
  const serversUnder = useMemo(() => {
    const map = new Map<string, ImportedServer[]>();
    const parentOf = new Map(result.folders.map((f) => [f.id, f.parentId]));
    for (const s of result.servers) {
      for (let cur = s.parentId; cur; cur = parentOf.get(cur) ?? null) {
        const list = map.get(cur);
        if (list) list.push(s);
        else map.set(cur, [s]);
      }
    }
    return map;
  }, [result]);

  const duplicates = useMemo(() => findDuplicates(existing, result, importTarget(source, target)), [existing, result, source, target]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (parentId: string | null, depth: number) => {
      const folders = result.folders.filter((f) => f.parentId === parentId).sort((a, b) => cmp(a.name, b.name));
      for (const f of folders) {
        const open = !closed.has(f.id);
        out.push({ kind: 'folder', folder: f, depth, open, count: serversUnder.get(f.id)?.length ?? 0 });
        if (open) walk(f.id, depth + 1);
      }
      const servers = result.servers.filter((s) => s.parentId === parentId).sort((a, b) => cmp(a.name, b.name));
      for (const s of servers) out.push({ kind: 'server', server: s, depth });
    };
    walk(null, 0);
    return out;
  }, [result, closed, serversUnder]);

  const folderState = (f: ImportedFolder): 'on' | 'off' | 'mixed' => {
    const list = serversUnder.get(f.id);
    if (!list || list.length === 0) return selected.has(f.id) ? 'on' : 'off';
    const n = list.filter((s) => selected.has(s.id)).length;
    return n === 0 ? 'off' : n === list.length ? 'on' : 'mixed';
  };

  const toggle = (row: Row) => {
    const next = new Set(selected);
    if (row.kind === 'server') {
      if (next.has(row.server.id)) next.delete(row.server.id);
      else next.add(row.server.id);
    } else {
      const on = folderState(row.folder) !== 'on';
      const list = serversUnder.get(row.folder.id) ?? [];
      const ids = list.length > 0 ? list.map((s) => s.id) : [row.folder.id];
      // 子文件夹里的空文件夹跟着一起
      for (const f of result.folders) if (isUnder(f, row.folder.id) && !(serversUnder.get(f.id)?.length)) ids.push(f.id);
      for (const id of ids) if (on) next.add(id);
      else next.delete(id);
    }
    onSelected(next);
  };

  const isUnder = (f: ImportedFolder, ancestor: string): boolean => {
    for (let cur = f.parentId; cur; cur = result.folders.find((x) => x.id === cur)?.parentId ?? null) if (cur === ancestor) return true;
    return false;
  };

  const selectedServers = result.servers.filter((s) => selected.has(s.id));
  const withPassword = result.servers.filter((s) => s.password !== null).length;
  const dupSelected = selectedServers.filter((s) => duplicates.has(s.id)).length;
  const allOn = result.servers.every((s) => selected.has(s.id)) && result.folders.every((f) => (serversUnder.get(f.id)?.length ?? 0) > 0 || selected.has(f.id));

  const toggleAll = () => {
    if (allOn) onSelected(new Set());
    else onSelected(new Set([...result.servers.map((s) => s.id), ...result.folders.filter((f) => !(serversUnder.get(f.id)?.length)).map((f) => f.id)]));
  };

  return (
    <>
      <div className="imp__options">
        <label className="check">
          <input type="checkbox" checked={allOn} onChange={toggleAll} />
          全选
        </label>
        <span className="muted">
          已选 {selectedServers.length} / {result.servers.length} 个连接
          {result.folders.length > 0 && ` · ${result.folders.length} 个文件夹`}
          {withPassword > 0 && ` · ${withPassword} 个含密码`}
        </span>
        <label className="imp__inline">
          导入位置
          <select className="field" value={target} onChange={(e) => onTarget(e.target.value as TargetKind)} aria-label="导入位置">
            <option value="folder">新建文件夹「{source.folderName}」</option>
            <option value="root">直接导入到根目录</option>
          </select>
        </label>
      </div>

      <div className="scroll imp__tree">
        <div className="grid-head grid-head--sticky imp__cols">
          <span>名称</span>
          <span>主机</span>
          <span>端口</span>
          <span>用户名</span>
          <span>密码</span>
        </div>
        {rows.length === 0 ? (
          <div className="empty">未解析到可导入的连接</div>
        ) : (
          rows.map((row) => {
            const id = row.kind === 'folder' ? row.folder.id : row.server.id;
            const state = row.kind === 'folder' ? folderState(row.folder) : selected.has(id) ? 'on' : 'off';
            const dup = row.kind === 'server' ? duplicates.get(id) : undefined;
            return (
              <div key={id} className="grid-row imp__cols imp__row" onClick={() => toggle(row)}>
                <span className="mgr__name" style={{ paddingLeft: row.depth * 18 }}>
                  <input
                    type="checkbox"
                    checked={state === 'on'}
                    ref={(el) => {
                      if (el) el.indeterminate = state === 'mixed';
                    }}
                    aria-label={row.kind === 'folder' ? `导入文件夹 ${row.folder.name}` : `导入 ${row.server.name}`}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggle(row)}
                  />
                  <span className="mgr__disclosure">
                    {row.kind === 'folder' && (
                      <button
                        type="button"
                        className="imp__disc"
                        aria-label={row.open ? '折叠' : '展开'}
                        aria-expanded={row.open}
                        onClick={(e) => {
                          e.stopPropagation();
                          setClosed((c) => {
                            const n = new Set(c);
                            if (n.has(row.folder.id)) n.delete(row.folder.id);
                            else n.add(row.folder.id);
                            return n;
                          });
                        }}
                      >
                        <DisclosureIcon open={row.open} />
                      </button>
                    )}
                  </span>
                  {row.kind === 'folder' ? <FolderFillIcon size={16} /> : <ServerIcon size={16} fill="var(--server)" />}
                  <span className="ellipsis">{row.kind === 'folder' ? row.folder.name : row.server.name}</span>
                  {row.kind === 'folder' && <span className="muted mgr__count">{row.count} 台</span>}
                  {dup && (
                    <span className="imp__tag imp__tag--warn" title={`已存在：${dup.name}（${dup.user}@${dup.host}:${dup.port}）`}>
                      重名
                    </span>
                  )}
                </span>
                <span className="mono mgr__mono ellipsis">{row.kind === 'server' ? row.server.host : ''}</span>
                <span className="mono mgr__mono">{row.kind === 'server' ? row.server.port : ''}</span>
                <span className="ellipsis">{row.kind === 'server' ? row.server.user : ''}</span>
                <span className="ellipsis">
                  {row.kind === 'server' &&
                    (row.server.password !== null ? (
                      secretsAvailable ? (
                        <span className="imp__tag imp__tag--ok">含密码</span>
                      ) : (
                        <span className="imp__tag muted">含密码 · 不保存</span>
                      )
                    ) : (
                      <span className="imp__tag muted">连接时输入</span>
                    ))}
                </span>
              </div>
            );
          })
        )}
      </div>

      {dupSelected > 0 && (
        <div className="imp__options">
          <span className="imp__tag--warn">{dupSelected} 个与现有连接重名（同一文件夹下名称相同，或主机、端口、用户名均相同）</span>
          <Segmented<DuplicatePolicy>
            ariaLabel="重名处理"
            size="small"
            role="group"
            value={policy}
            onChange={onPolicy}
            options={[
              { id: 'skip', label: '跳过' },
              { id: 'overwrite', label: '覆盖' },
              { id: 'keepBoth', label: '保留两份' },
            ]}
          />
        </div>
      )}

      {!secretsAvailable && withPassword > 0 && <div className="imp__warn">网页端不保存密码，请在连接时输入。</div>}
      {result.warnings.map((w) => (
        <div key={w} className="imp__warn">
          {w}
        </div>
      ))}
      {result.issues.length > 0 && (
        <details className="imp__issues">
          <summary>{result.issues.length} 条未导入（解析失败或不是 SSH 连接）</summary>
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
