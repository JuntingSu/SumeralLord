import type { FastifyPluginAsync } from 'fastify';
import { ERROR_CODES } from '@dl/shared';
import type { SeatAssignment } from '@dl/shared';
import { authPreHandler } from '../auth/guard.js';
import { ok, fail } from '../utils/respond.js';

/** 对局查询接口（v1：仅断线重连/中途观战数据源；操作意图全部走 WS） */
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
};

export type { SeatAssignment };
