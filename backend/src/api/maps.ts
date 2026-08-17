import type { FastifyPluginAsync } from 'fastify';
import { ERROR_CODES } from '@dl/shared';
import type { MapListResult } from '@dl/shared';
import { ok, fail } from '../utils/respond.js';

/** 地图查询接口：按设计公开（选图需要），无鉴权 */
export const mapRoutes: FastifyPluginAsync = async (app) => {
  app.get('/api/maps', async (request, reply) => {
    const { search } = request.query as { search?: string };
    return ok(reply, { mapList: app.maps.list(search) } satisfies MapListResult);
  });

  app.get('/api/maps/:id/preview', async (request, reply) => {
    const { id } = request.params as { id: string };
    const map = app.maps.get(id);
    if (!map) return fail(reply, 404, ERROR_CODES.MAP_NOT_FOUND, '地图不存在');
    return ok(reply, { row: map.row, column: map.column, battlefield: map.battlefield });
  });

  app.get('/api/maps/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const map = app.maps.get(id);
    if (!map) return fail(reply, 404, ERROR_CODES.MAP_NOT_FOUND, '地图不存在');
    return ok(reply, map);
  });
};
