import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { ERROR_CODES } from '@dl/shared';
import type { MapListResult } from '@dl/shared';
import { ok, fail } from '../utils/respond.js';
import { validateMapData } from '../maps/catalog.js';
import { authenticateBearer } from '../auth/jwt.js';
import { users } from '../db/schema.js';

/** 达标玩家（对局数 > 15 或积分 > 150）保存的地图直入正式 maps 目录，无需审查 */
function isTrustedPlayer(matches: number, score: number): boolean {
  return matches > 15 || score > 150;
}

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
   * 地图编辑器保存：写入审查队列 maps-uncensored；
   * 已登录且达标（对局数 > 15 或积分 > 150）的玩家直存正式 maps 目录；
   * 已存在同名地图时，仅当原图作者与当前账号一致才覆盖，否则回退审查队列。
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

    // 可选鉴权：无 token 按匿名处理（始终走审查队列）；达标玩家直存 maps
    const auth = authenticateBearer(request.headers.authorization);
    let targetDir = app.mapsUncensoredDir;
    let savedTo = 'maps-uncensored';
    let reason: string | undefined;
    if (auth) {
      const row = app.db.select().from(users).where(eq(users.id, auth.userId)).get();
      if (row && isTrustedPlayer(row.matches, row.score)) {
        const existing = app.maps.get(id);
        // 同名已存在时仅允许作者本人覆盖（作者以地图文件内 author 字段为准）
        if (existing && existing.author !== auth.username) {
          reason = '该地图 id 已存在于正式地图目录且作者非本人，回退审查队列，避免覆盖';
        } else {
          targetDir = app.mapsDir;
          savedTo = 'maps';
        }
      }
    }

    try {
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(path.join(targetDir, `${id}.json`), JSON.stringify(map, null, 2), 'utf8');
    } catch (err) {
      app.log.error(err, `保存地图到 ${savedTo} 失败`);
      return fail(reply, 500, ERROR_CODES.INVALID_PARAMS, '地图保存失败，请检查服务器目录权限');
    }
    if (savedTo === 'maps') app.maps.refresh(); // 让新图立即可被选图/搜索
    return ok(reply, { id, savedTo, ...(reason ? { reason } : {}) });
  });
};
