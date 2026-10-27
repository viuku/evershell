-- D1 的第一个迁移：建表。内容和 schema.sql 一致；以后改表结构加新的迁移文件，不改这个。

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  verifier TEXT NOT NULL,
  salt TEXT NOT NULL,
  kdf TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  account_id INTEGER NOT NULL,
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  hlc TEXT NOT NULL,
  deleted INTEGER NOT NULL,
  data TEXT NOT NULL,
  size INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (account_id, collection, id)
);

CREATE INDEX IF NOT EXISTS records_seq ON records (account_id, seq);

CREATE TABLE IF NOT EXISTS login_failures (
  account TEXT NOT NULL,
  at INTEGER NOT NULL
);
