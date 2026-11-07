import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export interface DbHandle {
  db: Db;
  sqlite: Database.Database;
}

/** 存量库守卫迁移：目标列缺失时补列（新库由 CREATE TABLE 直接建全） */
function ensureColumn(sqlite: Database.Database, table: string, column: string, ddl: string): void {
  const cols = sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>;
  if (!cols.some((c) => c.name === column)) {
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

export function openDb(dbPath?: string): DbHandle {
  const file = dbPath ?? config.dbPath;
  mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      default_flag INTEGER NOT NULL DEFAULT 1,
      matches INTEGER NOT NULL DEFAULT 0,
      wins INTEGER NOT NULL DEFAULT 0,
      score REAL NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS match_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL UNIQUE,
      room_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER NOT NULL,
      winners TEXT NOT NULL,
      winning_team INTEGER NOT NULL DEFAULT -1,
      participants TEXT NOT NULL,
      score_changes TEXT NOT NULL DEFAULT '[]',
      aborted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS pve_saves (
      user_id INTEGER PRIMARY KEY,
      game_id TEXT NOT NULL,
      map_title TEXT NOT NULL,
      turn INTEGER NOT NULL,
      phase TEXT NOT NULL,
      current_seat INTEGER NOT NULL,
      current_force TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_maps (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]',
      player_num INTEGER NOT NULL,
      row INTEGER NOT NULL,
      column INTEGER NOT NULL,
      has_triggers INTEGER NOT NULL DEFAULT 0,
      published INTEGER NOT NULL DEFAULT 0,
      published_at INTEGER,
      likes INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_user_maps_owner ON user_maps(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_user_maps_community ON user_maps(published, updated_at);
    CREATE INDEX IF NOT EXISTS idx_user_maps_popular ON user_maps(published, likes);
    CREATE TABLE IF NOT EXISTS user_map_likes (
      map_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (map_id, user_id)
    );
  `);
  // 存量库补列（DEFAULT 使旧账号自动回填 100 分、旧对局 score_changes 回填 []）
  ensureColumn(sqlite, 'users', 'score', 'score REAL NOT NULL DEFAULT 100');
  ensureColumn(sqlite, 'match_history', 'score_changes', "score_changes TEXT NOT NULL DEFAULT '[]'");
  return { db: drizzle(sqlite, { schema }), sqlite };
}
