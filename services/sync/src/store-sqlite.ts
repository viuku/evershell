// 自建版的存储：Node 22 以上自带的 node:sqlite，不需要装原生模块。
// node:sqlite 是同步接口，一批语句在 BEGIN/COMMIT 之间执行时不会被别的请求插进来。

import { readFileSync } from 'node:fs';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Store } from './store.ts';
import { type Row, type SqlDriver, type Stmt, sqlStore } from './store-sql.ts';

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

/** 传路径就打开（没有就新建）；测试传一个现成的连接进来，方便直接查库 */
export function sqliteStore(target: string | DatabaseSync): { store: Store; close(): void } {
  const db = typeof target === 'string' ? new DatabaseSync(target) : target;
  // WAL 让读不挡写；busy_timeout 防止外部的备份命令短暂锁库时直接报错
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);

  const cache = new Map<string, StatementSync>();
  const prepare = (sql: string) => {
    let stmt = cache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      cache.set(sql, stmt);
    }
    return stmt;
  };
  const run = (s: Stmt) => prepare(s.sql).all(...s.params) as Row[];

  const driver: SqlDriver = {
    async all(stmt) {
      return run(stmt);
    },
    async batch(stmts) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = stmts.map(run);
        db.exec('COMMIT');
        return out;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
  };
  return { store: sqlStore(driver), close: () => db.close() };
}
