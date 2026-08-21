import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { ERROR_CODES } from '@dl/shared';
import type { MapListResult } from '@dl/shared';
import { ok, fail } from '../utils/respond.js';
import { validateMapData } from '../maps/catalog.js';

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

  /**
   * 地图编辑器保存：写入 maps-uncensored 审查队列（后台审查后自行移入 maps 目录）。
   * 请求体 { id, map }；id 为文件名（不含 .json），严格白名单防路径穿越。
   */
  app.post('/api/maps', async (request, reply) => {
    const body = (request.body ?? {}) as { id?: unknown; map?: unknown };
    const { id, map } = body;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(id)) {
      return fail(reply, 400, ERROR_CODES.INVALID_PARAMS, '地图 id 仅允许字母/数字/下划线/连字符');
    }
    if (!validateMapData(map)) {
      return fail(reply, 400, ERROR_CODES.INVALID_PARAMS, '地图数据结构非法，未保存');
    }
    try {
      mkdirSync(app.mapsUncensoredDir, { recursive: true });
      writeFileSync(path.join(app.mapsUncensoredDir, `${id}.json`), JSON.stringify(map, null, 2), 'utf8');
    } catch (err) {
      app.log.error(err, '保存地图到 maps-uncensored 失败');
      return fail(reply, 500, ERROR_CODES.INVALID_PARAMS, '地图保存失败，请检查服务器目录权限');
    }
    return ok(reply, { id, savedTo: 'maps-uncensored' });
  });
};
