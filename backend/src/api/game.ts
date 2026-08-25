import type { FastifyPluginAsync } from 'fastify';
import { eq, inArray } from 'drizzle-orm';
import { ERROR_CODES } from '@dl/shared';
import type { GameResultData, ScoreChangeEntry, SeatAssignment } from '@dl/shared';
import { authPreHandler } from '../auth/guard.js';
import { matchHistory, users } from '../db/schema.js';
import { ok, fail } from '../utils/respond.js';

/** 对局查询接口（v1：断线重连/中途观战数据源；BM7a：回放日志。操作意图全部走 WS） */
export const gameRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authPreHandler);

  app.get('/api/game/:gameId/state', async (request, reply) => {
    const { gameId } = request.params as { gameId: string };
    const game = app.games.get(gameId);
    if (!game) return fail(reply, 404, ERROR_CODES.ROOM_NOT_FOUND, '对局不存在');
    return ok(reply, {
      gameId: game.id,
      roomId: game.roomId,
      status: game.status,
      lastEventId: game.eventIdCounter,
      reducerVersion: game.reducerVersion,
      clearedSeats: [...game.clearedSeats],
    });
  });

  app.get('/api/game/:gameId/events', async (request, reply) => {
    const { gameId } = request.params as { gameId: string };
    const query = request.query as { after?: string; limit?: string };
    const after = Number(query.after ?? 0);
    const limit = Math.min(Number(query.limit ?? 500), 500);
    const { events, nextCursor } = app.games.readEvents(gameId, Number.isFinite(after) ? after : 0, Number.isFinite(limit) ? limit : 500);
    return ok(reply, { events, nextCursor });
  });

  /** 对局初始数据（刷新重连/中途观战恢复 boardState 用；与 GAME_START 同构） */
  app.get('/api/game/:gameId/meta', async (request, reply) => {
    const { gameId } = request.params as { gameId: string };
    const game = app.games.get(gameId);
    if (!game) return fail(reply, 404, ERROR_CODES.ROOM_NOT_FOUND, '对局不存在');
    return ok(reply, {
      gameId: game.id,
      roomId: game.roomId,
      map: game.map,
      seatAssignments: game.seatAssignments,
      spawnAssignments: game.spawnAssignments,
      seed: game.seed,
      timeSettings: game.timeSettings,
      reducerVersion: game.reducerVersion,
    });
  });
  /** 对局结算结果（结算页：玩家名 + 全员积分变动）。
   *  数据源 match_history（VICTORY 时 recordMatchHistory + settleMatch 已写入）；
   *  鉴权：任意登录用户（GAME_OVER 本就广播给房间全员，含观战；结果不敏感）。 */
  app.get('/api/game/:gameId/result', async (request, reply) => {
    const { gameId } = request.params as { gameId: string };
    const row = app.db.select().from(matchHistory).where(eq(matchHistory.gameId, gameId)).get();
    if (!row) return fail(reply, 404, ERROR_CODES.ROOM_NOT_FOUND, '对局不存在或未结算');
    const participants = JSON.parse(row.participants) as Array<{ seat: number; playerId: number | null; isAI: boolean }>;
    const ids = [...new Set(participants.filter((p) => p.playerId !== null).map((p) => p.playerId as number))];
    const userRows = ids.length > 0 ? app.db.select().from(users).where(inArray(users.id, ids)).all() : [];
    const nameById = new Map(userRows.map((r) => [r.id, r.username]));
    return ok(reply, {
      gameId,
      winners: JSON.parse(row.winners) as string[],
      winningTeam: row.winningTeam,
      aborted: row.aborted === 1,
      scoreChanges: JSON.parse(row.scoreChanges ?? '[]') as ScoreChangeEntry[],
      participants: participants.map((p) => ({
        seat: p.seat,
        playerId: p.playerId,
        isAI: p.isAI,
        username: p.playerId !== null ? (nameById.get(p.playerId) ?? null) : null,
      })),
    } satisfies GameResultData);
  });

  /** 对局日志（BM7a 回放）：GAME_START 首行 + 对局流分页；鉴权：参战者（内存对局或 match_history） */
  app.get('/api/game/:gameId/log', async (request, reply) => {
    const { gameId } = request.params as { gameId: string };
    const query = request.query as { after?: string; limit?: string };
    const after = Number(query.after ?? 0);
    const limit = Math.min(Number(query.limit ?? 500), 500);
    const game = app.games.get(gameId);
    const row = app.db
      .select()
      .from(matchHistory)
      .where(eq(matchHistory.gameId, gameId))
      .get();
    if (!game && !row) return fail(reply, 404, ERROR_CODES.ROOM_NOT_FOUND, '对局不存在');
    // 鉴权：该对局参战者（内存 participants 或 match_history 快照）
    const participants: Array<{ seat: number; playerId: number | null; isAI: boolean }> = game
      ? [...game.participants.entries()].map(([seat, p]) => ({ seat, playerId: p.playerId, isAI: p.isAI }))
      : row
        ? (JSON.parse(row.participants) as Array<{ seat: number; playerId: number | null; isAI: boolean }>)
        : [];
    const allowed = participants.some((p) => p.playerId !== null && p.playerId === request.user!.userId);
    if (!allowed) return fail(reply, 403, ERROR_CODES.AUTH_FAILED, '无权查看该对局');
    const { start, events, nextCursor } = app.games.readLog(
      gameId,
      Number.isFinite(after) ? after : 0,
      Number.isFinite(limit) ? limit : 500,
    );
    return ok(reply, { start, events, nextCursor });
  });
};

export type { SeatAssignment };
