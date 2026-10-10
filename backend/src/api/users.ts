import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcryptjs';
import { AUTH, ERROR_CODES, SkinUploadBodySchema, UpdateProfileBodySchema } from '@dl/shared';
import type { MatchRecord, ScoreChangeEntry } from '@dl/shared';
import { authPreHandler } from '../auth/guard.js';
import { signAuthToken } from '../auth/jwt.js';
import { matchHistory, users } from '../db/schema.js';
import { toUserPublic } from './auth.js';
import { hasSkin, decodePngDataUrl, writeSkinPair } from '../skin.js';
import { writeRandomSkin, rgbToHex } from '../skinGen.js';
import { ok, fail } from '../utils/respond.js';

/** 用户相关（BM7b）：战绩/对局记录 + 个人统计（M5.4 回放列表同源）+ 个人资料/皮肤 */
export const userRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authPreHandler);

  /** 本人最新公开信息（含 score/matches；统计展示走这里，避免使用登录时缓存的旧值） */
  app.get('/api/users/me', async (request, reply) => {
    const row = app.db.select().from(users).where(eq(users.id, request.user!.userId)).get();
    if (!row) return fail(reply, 404, ERROR_CODES.AUTH_FAILED, '用户不存在');
    return ok(reply, { user: toUserPublic(row, hasSkin(app.skinDir, row.id)) });
  });

  /** 修改用户名 / 密码（改密码必须先通过原密码校验）；改用户名后重签 JWT 携带新用户名 */
  app.patch('/api/users/me', async (request, reply) => {
    const parsed = UpdateProfileBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, ERROR_CODES.INVALID_PARAMS, parsed.error?.issues[0]?.message ?? '参数非法');
    }
    const { username, oldPassword, newPassword } = parsed.data;
    const userId = request.user!.userId;
    const row = app.db.select().from(users).where(eq(users.id, userId)).get();
    if (!row) return fail(reply, 404, ERROR_CODES.AUTH_FAILED, '用户不存在');

    const updates: { username?: string; passwordHash?: string } = {};
    let usernameChanged = false;
    if (newPassword !== undefined) {
      if (!oldPassword || !bcrypt.compareSync(oldPassword, row.passwordHash)) {
        return fail(reply, 400, ERROR_CODES.PASSWORD_WRONG, '原密码错误');
      }
      updates.passwordHash = bcrypt.hashSync(newPassword, AUTH.BCRYPT_COST);
    }
    if (username !== undefined) {
      if (/\s/.test(username)) {
        return fail(reply, 400, ERROR_CODES.INVALID_PARAMS, '用户名不能包含空白字符');
      }
      if (username !== row.username) {
        const existing = app.db.select().from(users).where(eq(users.username, username)).get();
        if (existing) return fail(reply, 409, ERROR_CODES.USERNAME_TAKEN, '用户名已存在');
      }
      updates.username = username;
      usernameChanged = true;
    }
    app.db.update(users).set(updates).where(eq(users.id, userId)).run();
    const fresh = app.db.select().from(users).where(eq(users.id, userId)).get()!;
    // 用户名变化 → 重签 token（JWT 内嵌 username，房间/WS 展示用）
    const token = usernameChanged ? signAuthToken({ userId: fresh.id, username: fresh.username }) : undefined;
    return ok(reply, { user: toUserPublic(fresh, hasSkin(app.skinDir, fresh.id)), token });
  });

  /** 上传个人皮肤：一对 192×216 PNG（solid + hollow），写入 backend/static/skin */
  app.post('/api/users/me/skin', async (request, reply) => {
    const parsed = SkinUploadBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, ERROR_CODES.INVALID_PARAMS, '请上传两张 PNG 皮肤图片（≤2MB）');
    }
    const solid = decodePngDataUrl(parsed.data.solid);
    const hollow = decodePngDataUrl(parsed.data.hollow);
    if (!solid || !hollow) {
      return fail(reply, 400, ERROR_CODES.INVALID_PARAMS, '皮肤文件必须为 192×216 的 PNG 图片（≤2MB）');
    }
    writeSkinPair(app.skinDir, request.user!.userId, solid.buf, hollow.buf);
    return ok(reply, { hasSkin: true });
  });

  /** 随机配色皮肤：服务器随机取色（每通道 40–230）渲染六边形，直接覆盖当前皮肤 */
  app.post('/api/users/me/skin/random', async (request, reply) => {
    const color = writeRandomSkin(app.skinDir, request.user!.userId);
    return ok(reply, { hasSkin: true, color: rgbToHex(color) });
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
