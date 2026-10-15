// SQLite persistence. One file holds accounts, characters (their sim state as JSON) and the guild.
import Database from 'better-sqlite3';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash TEXT NOT NULL,
  pw_salt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS characters (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id),
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  state TEXT NOT NULL,
  last_seen INTEGER NOT NULL,
  away TEXT
);
CREATE TABLE IF NOT EXISTS guild (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  gold INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS guild_bank (
  item INTEGER PRIMARY KEY,
  count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guild_log (
  id INTEGER PRIMARY KEY,
  t INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  item INTEGER,
  count INTEGER NOT NULL DEFAULT 0,
  gold INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS guild_requests (
  id INTEGER PRIMARY KEY,
  t INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  item INTEGER NOT NULL,
  count INTEGER NOT NULL,
  filled INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  open INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS chat (
  id INTEGER PRIMARY KEY,
  t INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feed (
  id INTEGER PRIMARY KEY,
  t INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL
);
`;

export function openDb(file: string, guildName: string): DB {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  db.prepare(`INSERT INTO guild (id, name) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name`).run(guildName);
  return db;
}
