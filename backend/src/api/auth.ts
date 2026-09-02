import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';
import { AUTH, ERROR_CODES, LoginBodySchema, RegisterBodySchema } from '@dl/shared';
import type { LoginResult, UserPublic } from '@dl/shared';
import { users, type UserRow } from '../db/schema.js';
import { authenticateBearer, signAuthToken } from '../auth/jwt.js';
import { hasSkin } from '../skin.js';
import { createRateLimiter } from '../utils/rateLimit.js';
import { ok, fail } from '../utils/respond.js';

export interface AuthPluginOptions {
  registerPerMin?: number;
  loginPerMin?: number;
}

export function toUserPublic(row: UserRow, hasSkin = false): UserPublic {
  return {
    id: row.id,
    username: row.username,
    matches: row.matches,
    wins: row.wins,
    flag: row.defaultFlag,
    score: row.score,
    hasSkin,
  };
}

export const authRoutes: FastifyPluginAsync<AuthPluginOptions> = async (app, opts) => {
  const registerLimiter = createRateLimiter(opts.registerPerMin ?? AUTH.REGISTER_RATE_PER_MIN, 60_000);
  const loginLimiter = createRateLimiter(opts.loginPerMin ?? AUTH.LOGIN_RATE_PER_MIN, 60_000);

  app.post('/api/auth/register', async (request, reply) => {
    if (!registerLimiter(request.ip)) {
      return fail(reply, 429, ERROR_CODES.RATE_LIMITED, '请求过于频繁，请稍后再试');
    }
    const parsed = RegisterBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, ERROR_CODES.INVALID_PARAMS, '用户名需 3-20 字符，密码需 6-32 字符');
    }
    const { username, password } = parsed.data;
    if (/\s/.test(username)) {
      return fail(reply, 400, ERROR_CODES.INVALID_PARAMS, '用户名不能包含空白字符');
    }
    const existing = app.db.select().from(users).where(eq(users.username, username)).get();
    if (existing) {
      return fail(reply, 409, ERROR_CODES.USERNAME_TAKEN, '用户名已存在');
    }
    // 同步哈希 + better-sqlite3 同步写入：查重与插入之间不让出事件循环，天然免竞态
    const passwordHash = bcrypt.hashSync(password, AUTH.BCRYPT_COST);
    app.db.insert(users).values({ username, passwordHash }).run();
    return ok(reply, undefined, '注册成功');
  });

  app.post('/api/auth/login', async (request, reply) => {
    if (!loginLimiter(request.ip)) {
      return fail(reply, 429, ERROR_CODES.RATE_LIMITED, '请求过于频繁，请稍后再试');
    }
    const parsed = LoginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return fail(reply, 400, ERROR_CODES.INVALID_PARAMS, '用户名或密码格式非法');
    }
    const { username, password } = parsed.data;
    const row = app.db.select().from(users).where(eq(users.username, username)).get();
    if (!row || !bcrypt.compareSync(password, row.passwordHash)) {
      return fail(reply, 401, ERROR_CODES.AUTH_FAILED, '用户名或密码错误');
    }
    const data: LoginResult = {
      token: signAuthToken({ userId: row.id, username: row.username }),
      user: toUserPublic(row, hasSkin(app.skinDir, row.id)),
    };
    return ok(reply, data);
  });

  app.get('/api/ws-ticket', async (request, reply) => {
    const payload = authenticateBearer(request.headers.authorization);
    if (!payload) {
      return fail(reply, 401, ERROR_CODES.AUTH_FAILED, '未登录或凭证已过期');
    }
    return ok(reply, { ticket: app.tickets.issue(payload.userId, payload.username) });
  });
}
