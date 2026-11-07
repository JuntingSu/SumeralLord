import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  defaultFlag: integer('default_flag').notNull().default(1),
  matches: integer('matches').notNull().default(0),
  wins: integer('wins').notNull().default(0),
  /** 当前积分（注册默认 100；结算见 backend/src/stats/settlement.ts） */
  score: real('score').notNull().default(100),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;

/** 对局结算记录（BM5；aborted=1 表示共识中止，不写胜负，供 BM7+ 战绩查询扩展） */
export const matchHistory = sqliteTable('match_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  gameId: text('game_id').notNull().unique(),
  roomId: text('room_id').notNull(),
  startedAt: integer('started_at').notNull(),
  finishedAt: integer('finished_at').notNull(),
  /** 胜方 playerId 字符串数组（JSON），中止时为 [] */
  winners: text('winners').notNull(),
  winningTeam: integer('winning_team').notNull().default(-1),
  /** 参战者快照（JSON：[{ seat, playerId, isAI }]） */
  participants: text('participants').notNull(),
  /** 本局积分结算明细（JSON 数组，见 shared ScoreChangeEntry；平局/旧记录为 []） */
  scoreChanges: text('score_changes').notNull().default('[]'),
  aborted: integer('aborted').notNull().default(0),
});

export type MatchHistoryRow = typeof matchHistory.$inferSelect;
export type NewMatchHistoryRow = typeof matchHistory.$inferInsert;

/** PVE 存档（一账号一行；完整 GameState 快照 + 初始地图/设置；对局结束由前端无条件删除） */
export const pveSaves = sqliteTable('pve_saves', {
  userId: integer('user_id').primaryKey(),
  gameId: text('game_id').notNull(),
  mapTitle: text('map_title').notNull(),
  turn: integer('turn').notNull(),
  phase: text('phase').notNull(),
  currentSeat: integer('current_seat').notNull(),
  currentForce: text('current_force').notNull(),
  payload: text('payload').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export type PveSaveRow = typeof pveSaves.$inferSelect;
export type NewPveSaveRow = typeof pveSaves.$inferInsert;

/** 个人作品 / 社区地图索引（文件存 static/user-maps/<id>.json） */
export const userMaps = sqliteTable('user_maps', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull(),
  fileName: text('file_name').notNull(),
  title: text('title').notNull(),
  author: text('author').notNull(),
  description: text('description').notNull().default(''),
  /** JSON 字符串数组 */
  tags: text('tags').notNull().default('[]'),
  playerNum: integer('player_num').notNull(),
  row: integer('row').notNull(),
  column: integer('column').notNull(),
  hasTriggers: integer('has_triggers').notNull().default(0),
  published: integer('published').notNull().default(0),
  publishedAt: integer('published_at'),
  likes: integer('likes').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export type UserMapRow = typeof userMaps.$inferSelect;
export type NewUserMapRow = typeof userMaps.$inferInsert;

/** 社区地图点赞（同一用户对同一地图只能点一次） */
export const userMapLikes = sqliteTable('user_map_likes', {
  mapId: text('map_id').notNull(),
  userId: integer('user_id').notNull(),
  createdAt: integer('created_at').notNull(),
});

export type UserMapLikeRow = typeof userMapLikes.$inferSelect;
export type NewUserMapLikeRow = typeof userMapLikes.$inferInsert;
