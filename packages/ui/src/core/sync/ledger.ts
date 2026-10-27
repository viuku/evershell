// 账本（docs/specs/sync.md「账本 + 混合逻辑时钟」）：同步自己记的一本账，不改现有数据的格式。
// 每条记录记 [时间戳, 内容摘要]，删掉的摘要为 null。本机内容和账本一比，就知道哪些新增、改了、删了。

export type LedgerEntry = [hlc: string, digest: string | null];
/** 集合名 → 记录 id → 账目 */
export type Ledger = Record<string, Record<string, LedgerEntry>>;

/** 待上传队列里的一项：`集合/记录 id`（集合名里没有斜杠，id 里可能有，所以按第一个斜杠拆） */
export function pendingKey(collection: string, id: string): string {
  return `${collection}/${id}`;
}

export function splitPendingKey(key: string): { collection: string; id: string } | null {
  const i = key.indexOf('/');
  if (i <= 0 || i === key.length - 1) return null;
  return { collection: key.slice(0, i), id: key.slice(i + 1) };
}

export function ledgerGet(ledger: Ledger, collection: string, id: string): LedgerEntry | undefined {
  return ledger[collection]?.[id];
}

export function ledgerSet(ledger: Ledger, collection: string, id: string, entry: LedgerEntry): void {
  (ledger[collection] ??= {})[id] = entry;
}

export function ledgerDelete(ledger: Ledger, collection: string, id: string): void {
  const c = ledger[collection];
  if (c) delete c[id];
}

/** 远端这条比账本里记的新才要；一样大的是自己推上去又拉回来的，比账本旧的是服务器回放的旧版本 */
export function isNewer(ledger: Ledger, collection: string, id: string, hlc: string): boolean {
  const entry = ledgerGet(ledger, collection, id);
  return !entry || hlc > entry[0];
}

/**
 * 本机一个集合的当前内容（id → 摘要）和账本比：新出现或摘要变了的记新时间戳、标为待上传；
 * 账本里有、现在没有的记墓碑。tombstones 为 false 的集合（历史、最近连接）挤出去不算删除，只从账本里去掉。
 * 返回变了的 id
 */
export function detectChanges(
  ledger: Ledger,
  pending: Set<string>,
  collection: string,
  current: Map<string, string>,
  tick: () => string,
  tombstones: boolean,
): string[] {
  const changed: string[] = [];
  const book = (ledger[collection] ??= {});
  for (const [id, d] of current) {
    const entry = book[id];
    if (entry && entry[1] === d) continue;
    book[id] = [tick(), d];
    pending.add(pendingKey(collection, id));
    changed.push(id);
  }
  for (const [id, entry] of Object.entries(book)) {
    if (entry[1] === null || current.has(id)) continue;
    if (tombstones) {
      book[id] = [tick(), null];
      pending.add(pendingKey(collection, id));
      changed.push(id);
    } else {
      delete book[id];
      pending.delete(pendingKey(collection, id));
    }
  }
  return changed;
}
