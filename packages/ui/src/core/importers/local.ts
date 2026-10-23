import type { LocalConfigFiles } from '../../types';
import { SOURCES } from './sources';
import type { ImportResult, ImportSource } from './types';

// 一键导入：后端在各软件默认位置读到的文件 → 每个来源的状态，来源页据此标出“找到 N 个连接”。
// 规格见 docs/specs/one-click-import.md。

export type LocalScan =
  | { state: 'found'; location: string; result: ImportResult }
  /** 有配置文件，但解析不出连接（比如 ~/.ssh/config 里只有带通配符的 Host） */
  | { state: 'empty'; location: string }
  | { state: 'missing'; location: string }
  | { state: 'error'; location: string; message: string };

/** 只收后端查过、界面认识的来源；没出现的来源（网页端、本平台没有的软件）界面不提示 */
export function scanLocalConfigs(list: LocalConfigFiles[]): Map<ImportSource, LocalScan> {
  const out = new Map<ImportSource, LocalScan>();
  for (const c of list) {
    const source = SOURCES.find((s) => s.id === c.source);
    if (!source || out.has(source.id)) continue;
    const { location } = c;
    if (c.error) {
      out.set(source.id, { state: 'error', location, message: c.error });
    } else if (c.files.length === 0) {
      out.set(source.id, { state: 'missing', location });
    } else {
      try {
        const result = source.parse(c.files);
        out.set(source.id, result.servers.length > 0 ? { state: 'found', location, result } : { state: 'empty', location });
      } catch (e) {
        out.set(source.id, { state: 'error', location, message: e instanceof Error ? e.message : String(e) });
      }
    }
  }
  return out;
}

/** 默认选中的来源：按来源列表的顺序，第一个找到连接的 */
export function firstFound(scan: Map<ImportSource, LocalScan>): ImportSource | null {
  return SOURCES.find((s) => scan.get(s.id)?.state === 'found')?.id ?? null;
}
