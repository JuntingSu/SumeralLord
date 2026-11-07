// 个人作品与社区地图索引：个人接口要求登录；社区读取公开，点赞要求登录。
import type { FastifyPluginAsync } from 'fastify';
import { ERROR_CODES } from '@dl/shared';
import type { MapLikeResult, UserMapListResult, UserMapSort } from '@dl/shared';
import { authPreHandler } from '../auth/guard.js';
import { authenticateBearer } from '../auth/jwt.js';
import { UserMapError } from '../maps/userMaps.js';
import { fail, ok } from '../utils/respond.js';

const MAP_BODY_LIMIT = 16 * 1024 * 1024;
const SORTS = new Set<UserMapSort>([
  'recent',
  'oldest',
  'title_asc',
  'title_desc',
  'author_asc',
  'author_desc',
  'popular',
]);

interface ListQuery {
  search?: string;
  sort?: string;
  page?: string;
  pageSize?: string;
}

function listOptions(query: ListQuery) {
  return {
    search: query.search,
    sort: SORTS.has(query.sort as UserMapSort) ? (query.sort as UserMapSort) : 'recent',
    page: Number(query.page),
    pageSize: Number(query.pageSize),
  };
}

function sendError(reply: Parameters<typeof fail>[0], err: unknown): unknown {
  if (err instanceof UserMapError) {
    return fail(reply, err.status, err.code, err.message);
  }
  throw err;
}

export const userMapRoutes: FastifyPluginAsync = async (app) => {
  // ---------- 我的作品（登录 + 所有权） ----------
  app.get('/api/user-maps', { preHandler: authPreHandler }, async (request, reply) => {
    const user = request.user!;
    const result = app.userMaps.listMine(user.userId, listOptions(request.query as ListQuery));
    return ok(reply, result satisfies UserMapListResult);
  });

  app.post(
    '/api/user-maps',
    { preHandler: authPreHandler, bodyLimit: MAP_BODY_LIMIT },
    async (request, reply) => {
      const user = request.user!;
      const body = (request.body ?? {}) as { map?: unknown };
      try {
        const meta = app.userMaps.create(user.userId, user.username, body.map);
        return ok(reply, meta);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get('/api/user-maps/:id', { preHandler: authPreHandler }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const map = app.userMaps.get(id, { ownerId: user.userId });
    if (!map) return fail(reply, 404, ERROR_CODES.MAP_NOT_FOUND, '作品不存在');
    return ok(reply, map);
  });

  app.get(
    '/api/user-maps/:id/meta',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };
      const meta = app.userMaps.meta(id, { ownerId: user.userId });
      if (!meta) return fail(reply, 404, ERROR_CODES.MAP_NOT_FOUND, '作品不存在');
      return ok(reply, meta);
    },
  );

  app.get(
    '/api/user-maps/:id/preview',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };
      const preview = app.userMaps.preview(id, { ownerId: user.userId });
      if (!preview) return fail(reply, 404, ERROR_CODES.MAP_NOT_FOUND, '作品不存在');
      return ok(reply, preview);
    },
  );

  app.put(
    '/api/user-maps/:id',
    { preHandler: authPreHandler, bodyLimit: MAP_BODY_LIMIT },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as { map?: unknown };
      try {
        return ok(reply, app.userMaps.update(user.userId, id, user.username, body.map));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    '/api/user-maps/:id/publish',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };
      try {
        return ok(reply, app.userMaps.publish(user.userId, id));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // ---------- 社区地图（公开读取） ----------
  app.get('/api/community/maps', async (request, reply) => {
    const result = app.userMaps.listCommunity(listOptions(request.query as ListQuery));
    return ok(reply, result satisfies UserMapListResult);
  });

  app.get('/api/community/maps/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const map = app.userMaps.get(id, { publishedOnly: true });
    if (!map) return fail(reply, 404, ERROR_CODES.MAP_NOT_FOUND, '地图不存在');
    return ok(reply, map);
  });

  app.get('/api/community/maps/:id/preview', async (request, reply) => {
    const { id } = request.params as { id: string };
    const preview = app.userMaps.preview(id, { publishedOnly: true });
    if (!preview) return fail(reply, 404, ERROR_CODES.MAP_NOT_FOUND, '地图不存在');
    return ok(reply, preview);
  });

  app.get('/api/community/maps/:id/like', async (request, reply) => {
    const { id } = request.params as { id: string };
    const auth = authenticateBearer(request.headers.authorization);
    const status = app.userMaps.likeStatus(auth?.userId, id);
    if (!status) return fail(reply, 404, ERROR_CODES.MAP_NOT_FOUND, '地图不存在');
    return ok(reply, status satisfies MapLikeResult);
  });

  app.post(
    '/api/community/maps/:id/like',
    { preHandler: authPreHandler },
    async (request, reply) => {
      const user = request.user!;
      const { id } = request.params as { id: string };
      try {
        return ok(reply, app.userMaps.like(user.userId, id) satisfies MapLikeResult);
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
};
