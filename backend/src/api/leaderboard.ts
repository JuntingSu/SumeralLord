import { asc, count, desc, eq, gt } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { ERROR_CODES } from '@dl/shared';
import type { LeaderboardEntry, LeaderboardResult } from '@dl/shared';
import { authPreHandler } from '../auth/guard.js';
import { users } from '../db/schema.js';
import { ok, fail } from '../utils/respond.js';

type LeaderboardType = 'score' | 'matches';

/** 排行榜：积分榜（score 降序）/ 对局数榜（matches 降序）；Top100 + 当前账号排名（严格大于计数，并列同名次） */
export const leaderboardRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authPreHandler);

  app.get('/api/leaderboard/:type', async (request, reply) => {
    const { type } = request.params as { type: string };
    if (type !== 'score' && type !== 'matches') {
      return fail(reply, 400, ERROR_CODES.INVALID_PARAMS, '榜单类型非法');
    }
    const col = type === 'score' ? users.score : users.matches;
    const rows = app.db.select().from(users).orderBy(desc(col), asc(users.id)).limit(100).all();
    const list: LeaderboardEntry[] = rows.map((r, i) => ({
      id: r.id,
      username: r.username,
      flag: r.defaultFlag,
      score: r.score,
      matches: r.matches,
      rank: i + 1,
    }));

    const meId = request.user!.userId;
    let me = list.find((e) => e.id === meId) ?? null;
    if (!me) {
      const myRow = app.db.select().from(users).where(eq(users.id, meId)).get();
      if (myRow) {
        const better = app.db
          .select({ n: count() })
          .from(users)
          .where(gt(col, myRow[type === 'score' ? 'score' : 'matches']))
          .get();
        me = {
          id: myRow.id,
          username: myRow.username,
          flag: myRow.defaultFlag,
          score: myRow.score,
          matches: myRow.matches,
          rank: (better?.n ?? 0) + 1,
        };
      }
    }
    return ok(reply, { list, me } satisfies LeaderboardResult);
  });
};
