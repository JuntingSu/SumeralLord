import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { ERROR_CODES } from '@dl/shared';
import type { MatchRecord, ScoreChangeEntry } from '@dl/shared';
import { authPreHandler } from '../auth/guard.js';
import { matchHistory, users } from '../db/schema.js';
import { toUserPublic } from './auth.js';
import { ok, fail } from '../utils/respond.js';

/** 用户相关（BM7b）：战绩/对局记录 + 个人统计（M5.4 回放列表同源） */
export const userRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authPreHandler);

  /** 本人最新公开信息（含 score/matches；统计展示走这里，避免使用登录时缓存的旧值） */
  app.get('/api/users/me', async (request, reply) => {
    const row = app.db.select().from(users).where(eq(users.id, request.user!.userId)).get();
    if (!row) return fail(reply, 404, ERROR_CODES.AUTH_FAILED, '用户不存在');
    return ok(reply, { user: toUserPublic(row) });
  });

  /** 本人对局记录（按结束时间倒序）；仅本人可查；每行含本局积分结算明细 */
  app.get('/api/users/:id/history', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (Number(id) !== request.user!.userId) {
      return fail(reply, 403, ERROR_CODES.AUTH_FAILED, '无权查看该用户战绩');
    }
    const rows = app.db.select().from(matchHistory).all();
    const history: MatchRecord[] = rows
      .filter((r) => {
        const ps = JSON.parse(r.participants) as Array<{ seat: number; playerId: number | null; isAI: boolean }>;
        return ps.some((p) => p.playerId !== null && p.playerId === request.user!.userId);
      })
      .map((r) => ({
        gameId: r.gameId,
        roomId: r.roomId,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        winners: JSON.parse(r.winners) as string[],
        winningTeam: r.winningTeam,
        participants: JSON.parse(r.participants) as Array<{ seat: number; playerId: number | null; isAI: boolean }>,
        scoreChanges: JSON.parse(r.scoreChanges ?? '[]') as ScoreChangeEntry[],
        aborted: r.aborted === 1,
      }))
      .sort((a, b) => b.finishedAt - a.finishedAt);
    return ok(reply, { history });
  });
};
