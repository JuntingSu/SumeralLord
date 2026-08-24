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
