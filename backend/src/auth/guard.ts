import type { FastifyReply, FastifyRequest } from 'fastify';
import { ERROR_CODES } from '@dl/shared';
import { authenticateBearer } from './jwt.js';
import { fail } from '../utils/respond.js';

/** 鉴权前置钩子：解析 Bearer JWT，失败即 401（需 REST 鉴权的路由统一挂载） */
export async function authPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const payload = authenticateBearer(request.headers.authorization);
  if (!payload) {
    fail(reply, 401, ERROR_CODES.AUTH_FAILED, '未登录或凭证已过期');
    return;
  }
  request.user = payload;
}
