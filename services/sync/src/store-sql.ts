// D1 和 node:sqlite 共用的 SQL 实现。两边都是 SQLite，SQL 写一份，
// 各自只提供“执行一条”“在一个事务里执行一批”两个动作（store-d1.ts、store-sqlite.ts），
// 这样 vitest 用 node:sqlite 测到的就是 D1 上跑的同一套 SQL。

import type { DeviceRow, PulledRecord, PushRecord, PushResult, Store } from './store.ts';

export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;
export interface Stmt {
  sql: string;
  params: SqlValue[];
}

export interface SqlDriver {
  all(stmt: Stmt): Promise<Row[]>;
  /** 在一个事务里依次执行，任何一条出错整批回滚；返回每条语句的结果行 */
  batch(stmts: Stmt[]): Promise<Row[][]>;
}

/** 服务器替 history 集合只留最新的这么多条（按时间戳） */
export const HISTORY_KEEP = 1000;

// D1 每个绑定参数最大 2 MB，推送的记录按这个大小分块写入，留足余量
const CHUNK_CHARS = 1_000_000;

const q = (sql: string, ...params: SqlValue[]): Stmt => ({ sql, params });
const num = (v: SqlValue | undefined): number => Number(v ?? 0);

// 推送的每条记录在 JSON 里的字段：c 集合、i id、h 时间戳、s 大小（以及写入时的 d 墓碑、x 数据）。
// 用一个 JSON 参数配 json_each 一次处理一整批，不受 D1 每条语句 100 个参数的限制。
const MATCH = `records AS r ON r.account_id = ?1
  AND r.collection = json_extract(j.value, '$.c') AND r.id = json_extract(j.value, '$.i')`;

// 这批推送里会写进去的记录（新出现的，或时间戳比库里新的）带来的空间变化
const DELTA = `(SELECT COALESCE(SUM(json_extract(j.value, '$.s') - COALESCE(r.size, 0)), 0)
  FROM json_each(?2) AS j LEFT JOIN ${MATCH}
  WHERE r.hlc IS NULL OR json_extract(j.value, '$.h') > r.hlc)`;

// 每条记录的 seq = 本批起点 + 它在整批里的位置；?2 是“整批条数 - 1 - 本块起始位置”。
// INSERT ... SELECT 带 ON CONFLICT 时 SQLite 要求 SELECT 有 WHERE，所以写了 WHERE true。
const UPSERT = `INSERT INTO records (account_id, collection, id, hlc, deleted, data, size, seq)
  SELECT ?1, json_extract(j.value, '$.c'), json_extract(j.value, '$.i'), json_extract(j.value, '$.h'),
    json_extract(j.value, '$.d'), json_extract(j.value, '$.x'), json_extract(j.value, '$.s'),
    (SELECT seq FROM accounts WHERE id = ?1) - ?2 + j.key
  FROM json_each(?3) AS j WHERE true
  ON CONFLICT (account_id, collection, id) DO UPDATE SET
    hlc = excluded.hlc, deleted = excluded.deleted, data = excluded.data, size = excluded.size, seq = excluded.seq
  WHERE excluded.hlc > records.hlc`;

const HISTORY_OLD = `FROM records WHERE account_id = ?1 AND collection = 'history' AND id NOT IN (
  SELECT id FROM records WHERE account_id = ?1 AND collection = 'history' ORDER BY hlc DESC, id DESC LIMIT ?2)`;

// 先按条数取一页，再按累计大小截断；只对 (seq, size) 开窗口，不把整页的数据都缓存一遍。
// 前两行总是带上：第一行保证一条很大的记录也能取到，第二行用来判断后面还有没有。
const PULL = `WITH page AS (
    SELECT seq, size FROM records WHERE account_id = ?1 AND seq > ?2 ORDER BY seq LIMIT ?3),
  cut AS (
    SELECT seq, size, SUM(size) OVER (ORDER BY seq ROWS UNBOUNDED PRECEDING) AS total,
      ROW_NUMBER() OVER (ORDER BY seq) AS rn FROM page)
  SELECT r.collection, r.id, r.hlc, r.deleted, r.data, r.seq, cut.total
  FROM cut JOIN records AS r ON r.account_id = ?1 AND r.seq = cut.seq
  WHERE cut.rn <= 2 OR cut.total - cut.size < ?4
  ORDER BY r.seq`;

export function sqlStore(db: SqlDriver): Store {
  return {
    async findAccount(name) {
      const [row] = await db.all(
        q('SELECT id, name, verifier, salt, kdf, wrapped_key FROM accounts WHERE name = ?1', name),
      );
      if (!row) return null;
      return {
        id: num(row.id),
        name: String(row.name),
        verifier: String(row.verifier),
        salt: String(row.salt),
        kdf: String(row.kdf),
        wrappedKey: String(row.wrapped_key),
      };
    },

    async createAccount(a) {
      const [row] = await db.all(
        q(
          `INSERT INTO accounts (name, verifier, salt, kdf, wrapped_key, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT (name) DO NOTHING RETURNING id`,
          a.name,
          a.verifier,
          a.salt,
          a.kdf,
          a.wrappedKey,
          a.createdAt,
        ),
      );
      return row ? num(row.id) : null;
    },

    async createSession(accountId, account, tokenHash, device, now) {
      await db.batch([
        q('DELETE FROM sessions WHERE account_id = ?1 AND device_id = ?2', accountId, device.id),
        q(
          `INSERT INTO sessions (token_hash, account_id, device_id, device_name, platform, created_at, last_seen_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`,
          tokenHash,
          accountId,
          device.id,
          device.name,
          device.platform,
          now,
        ),
        q('DELETE FROM login_failures WHERE account = ?1', account),
      ]);
    },

    async findSession(tokenHash) {
      const [row] = await db.all(
        q(
          `SELECT s.account_id, a.name, s.device_id, s.last_seen_at
           FROM sessions AS s JOIN accounts AS a ON a.id = s.account_id WHERE s.token_hash = ?1`,
          tokenHash,
        ),
      );
      if (!row) return null;
      return {
        tokenHash,
        accountId: num(row.account_id),
        account: String(row.name),
        deviceId: String(row.device_id),
        lastSeenAt: num(row.last_seen_at),
      };
    },

    async touchSession(tokenHash, now) {
      await db.all(q('UPDATE sessions SET last_seen_at = ?2 WHERE token_hash = ?1', tokenHash, now));
    },

    async deleteSession(tokenHash) {
      await db.all(q('DELETE FROM sessions WHERE token_hash = ?1', tokenHash));
    },

    async deleteDeviceSessions(accountId, deviceId) {
      await db.all(q('DELETE FROM sessions WHERE account_id = ?1 AND device_id = ?2', accountId, deviceId));
    },

    async renameDevice(accountId, deviceId, name) {
      await db.all(
        q('UPDATE sessions SET device_name = ?3 WHERE account_id = ?1 AND device_id = ?2', accountId, deviceId, name),
      );
    },

    async listDevices(accountId) {
      // 正常一台设备只有一个令牌；万一有多个，取最近在线的那个的名称
      const rows = await db.all(
        q(
          `SELECT device_id, device_name, platform, MAX(last_seen_at) AS last_seen_at
           FROM sessions WHERE account_id = ?1 GROUP BY device_id ORDER BY last_seen_at DESC`,
          accountId,
        ),
      );
      return rows.map(
        (r): DeviceRow => ({
          id: String(r.device_id),
          name: String(r.device_name),
          platform: String(r.platform),
          lastSeenAt: num(r.last_seen_at),
        }),
      );
    },

    async countLoginFailures(account, since) {
      const [row] = await db.all(
        q('SELECT COUNT(*) AS n FROM login_failures WHERE account = ?1 AND at > ?2', account, since),
      );
      return num(row?.n);
    },

    async addLoginFailure(account, at, before) {
      await db.batch([
        q('DELETE FROM login_failures WHERE at <= ?1', before),
        q('INSERT INTO login_failures (account, at) VALUES (?1, ?2)', account, at),
      ]);
    },

    async changePassword(accountId, s, keepTokenHash) {
      await db.batch([
        q(
          'UPDATE accounts SET verifier = ?2, salt = ?3, kdf = ?4, wrapped_key = ?5 WHERE id = ?1',
          accountId,
          s.verifier,
          s.salt,
          s.kdf,
          s.wrappedKey,
        ),
        q('DELETE FROM sessions WHERE account_id = ?1 AND token_hash <> ?2', accountId, keepTokenHash),
      ]);
    },

    async usage(accountId) {
      const [row] = await db.all(
        q(
          `SELECT used_bytes, (SELECT COUNT(*) FROM records WHERE account_id = ?1) AS n
           FROM accounts WHERE id = ?1`,
          accountId,
        ),
      );
      return { bytes: num(row?.used_bytes), records: num(row?.n) };
    },

    async pushRecords(accountId, records, quotaBytes) {
      const n = records.length;
      if (n === 0) {
        const [row] = await db.all(q('SELECT seq FROM accounts WHERE id = ?1', accountId));
        return { ok: true, seq: num(row?.seq), results: [] };
      }
      const keys = JSON.stringify(records.map((r) => ({ c: r.collection, i: r.id, h: r.hlc, s: r.data.length })));

      // 额度先查后写：D1 没有交互式事务，没法在 batch 中途按条件回滚。
      // 两台设备恰好同时推送时最多超出一次推送的量，额度本来就是软限制，可以接受。
      // 只拦会让空间变大的推送，超额以后仍然能改小、能删。
      const [pre] = await db.all(q(`SELECT used_bytes, ${DELTA} AS delta FROM accounts WHERE id = ?1`, accountId, keys));
      const delta = num(pre?.delta);
      if (delta > 0 && num(pre?.used_bytes) + delta > quotaBytes) return { ok: false, reason: 'quota_exceeded' };

      const stmts: Stmt[] = [
        q('UPDATE accounts SET seq = seq + ?2 WHERE id = ?1', accountId, n),
        // 必须在写入之前算：写入以后旧记录的大小就没了
        q(`UPDATE accounts SET used_bytes = used_bytes + ${DELTA} WHERE id = ?1`, accountId, keys),
      ];
      for (const chunk of chunks(records)) {
        stmts.push(q(UPSERT, accountId, n - 1 - chunk.offset, chunk.json));
      }
      if (records.some((r) => r.collection === 'history')) {
        stmts.push(
          q(
            `UPDATE accounts SET used_bytes = used_bytes - COALESCE((SELECT SUM(size) ${HISTORY_OLD}), 0) WHERE id = ?1`,
            accountId,
            HISTORY_KEEP,
          ),
          q(`DELETE ${HISTORY_OLD}`, accountId, HISTORY_KEEP),
        );
      }
      stmts.push(
        q(`SELECT j.key AS k, r.hlc, r.seq FROM json_each(?2) AS j JOIN ${MATCH}`, accountId, keys),
        q('SELECT seq FROM accounts WHERE id = ?1', accountId),
      );
      const out = await db.batch(stmts);
      const seq = num(out[out.length - 1][0]?.seq);
      const base = seq - n;

      // 写进去的记录 seq 正好是分给它的那个；不是的就是库里已有更新的。
      // 查不到的只可能是刚写进去又被 history 的 1000 条上限挤掉的，也算写入成功。
      const results: ({ status: 'ok' } | { status: 'stale'; hlc: string })[] = records.map(() => ({ status: 'ok' }));
      for (const row of out[out.length - 2]) {
        const k = num(row.k);
        if (num(row.seq) !== base + 1 + k) results[k] = { status: 'stale', hlc: String(row.hlc) };
      }
      return { ok: true, seq, results } satisfies PushResult;
    },

    async pullRecords(accountId, since, limit, maxBytes) {
      // 两条放在同一个事务里读，账号的 seq 和取到的记录对得上，不会漏掉中间插进来的推送
      const [rows, [acc]] = await db.batch([
        q(PULL, accountId, since, limit + 1, maxBytes),
        q('SELECT seq FROM accounts WHERE id = ?1', accountId),
      ]);
      const records: PulledRecord[] = [];
      for (const [i, r] of rows.entries()) {
        if (i > 0 && num(r.total) > maxBytes) break;
        records.push({
          collection: String(r.collection),
          id: String(r.id),
          hlc: String(r.hlc),
          deleted: num(r.deleted) !== 0,
          data: String(r.data),
          seq: num(r.seq),
        });
      }
      let more = records.length < rows.length;
      if (records.length > limit) {
        records.length = limit;
        more = true;
      }
      // 取完了就给账号当前的 seq：中间有被覆盖、被挤掉的记录留下的空号，客户端的游标也能一步跳到头
      const seq = more ? records[records.length - 1].seq : num(acc?.seq);
      return { records, seq, more };
    },
  };
}

function chunks(records: PushRecord[]): { offset: number; json: string }[] {
  const out: { offset: number; json: string }[] = [];
  let items: string[] = [];
  let size = 0;
  let offset = 0;
  records.forEach((r, i) => {
    const item = JSON.stringify({
      c: r.collection,
      i: r.id,
      h: r.hlc,
      d: r.deleted ? 1 : 0,
      x: r.data,
      s: r.data.length,
    });
    if (items.length > 0 && size + item.length > CHUNK_CHARS) {
      out.push({ offset, json: `[${items.join(',')}]` });
      items = [];
      size = 0;
      offset = i;
    }
    items.push(item);
    size += item.length + 1;
  });
  out.push({ offset, json: `[${items.join(',')}]` });
  return out;
}
