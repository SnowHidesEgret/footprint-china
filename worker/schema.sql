-- 点亮中国 · D1 数据库结构（2026-10-20 由 KV 迁移）
-- 执行：通过 Cloudflare API /d1/database/{id}/query 或 wrangler d1 execute

CREATE TABLE IF NOT EXISTS users (
  user_id       TEXT PRIMARY KEY,
  username      TEXT,
  password_hash TEXT,
  nickname      TEXT NOT NULL DEFAULT '',
  color         TEXT,
  footprint     TEXT NOT NULL DEFAULT '{}',
  created_at    INTEGER,
  updated_at    INTEGER,
  merged_into   TEXT,
  v2            INTEGER NOT NULL DEFAULT 0,
  claimed_from  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_nickname ON users(nickname);

CREATE TABLE IF NOT EXISTS rooms (
  code          TEXT PRIMARY KEY,
  name          TEXT,
  password      TEXT,
  owner_user_id TEXT,
  created_at    INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_password ON rooms(password);

CREATE TABLE IF NOT EXISTS room_members (
  room_code TEXT NOT NULL,
  user_id   TEXT NOT NULL,
  joined_at INTEGER,
  PRIMARY KEY (room_code, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON room_members(user_id);
