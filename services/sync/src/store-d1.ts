// Cloudflare 版的存储：D1。D1 没有交互式事务，db.batch() 里的语句在一个事务里执行，
// 而且一整批只算一次查询（免费版每个请求最多 50 次查询）。

import type { Store } from './store.ts';
import { type Row, type Stmt, sqlStore } from './store-sql.ts';

export function d1Store(db: D1Database): Store {
  const prepare = (s: Stmt) => db.prepare(s.sql).bind(...s.params);
  return sqlStore({
    async all(stmt) {
      const { results } = await prepare(stmt).all<Row>();
      return results;
    },
    async batch(stmts) {
      const out = await db.batch<Row>(stmts.map(prepare));
      return out.map((r) => r.results ?? []);
    },
  });
}
