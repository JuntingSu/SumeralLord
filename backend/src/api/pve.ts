import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import {
  ERROR_CODES,
  isPvePlayableMap,
  validateMapData,
} from '@dl/shared';
import type {
  MapListResult,
  PveRandomMapResult,
  PveSaveBody,
  PveSaveMetaResponse,
  PveSavePayload,
  PveSaveResponse,
  PveWeightsResult,
} from '@dl/shared';
import { pveSaves } from '../db/schema.js';
import { authPreHandler } from '../auth/guard.js';
import { ok, fail } from '../utils/respond.js';

const SAVE_BODY_LIMIT = 64 * 1024 * 1024;

/** 刷新 PVE 目录元数据（mtime 缓存；首次 ensureLoaded 会全量扫描） */
function refreshPveMaps(app: { pveMaps: { ensureLoaded: (ms?: number) => number; refresh: () => number }; pveMapsReloadMs: number }): void {
  app.pveMaps.ensureLoaded(app.pveMapsReloadMs);
  app.pveMaps.refresh();
}

/** 解析/校验存档请求体；返回序列化后的 payload（用于落库与大小限制） */
function parseSaveBody(raw: unknown, maxBytes: number): { body: PveSaveBody; serialized: string } | { error: string } {
  if (raw === null || typeof raw !== 'object') return { error: '存档数据为空' };
  const b = raw as Partial<PveSaveBody>;
  if (typeof b.gameId !== 'string' || b.gameId.length === 0 || b.gameId.length > 64) return { error: 'gameId 非法' };
  if (typeof b.mapTitle !== 'string' || b.mapTitle.length > 200) return { error: 'mapTitle 非法' };
  if (!Number.isInteger(b.turn) || (b.turn as number) < 0) return { error: 'turn 非法' };
  if (typeof b.phase !== 'string' || b.phase.length === 0) return { error: 'phase 非法' };
  if (!Number.isInteger(b.currentSeat) || (b.currentSeat as number) < 0) return { error: 'currentSeat 非法' };
  if (typeof b.currentForce !== 'string' || b.currentForce.length > 200) return { error: 'currentForce 非法' };

  const p = b.payload as Partial<PveSavePayload> | undefined;
  if (!p || typeof p !== 'object' || p.version !== 3) return { error: '存档版本非法' };
  const state = p.state;
  if (!state || typeof state !== 'object') return { error: '缺少完整 GameState' };
  if (!Array.isArray(state.tiles) || !Array.isArray(state.forces)) return { error: 'GameState 结构非法' };
  if (!Number.isInteger(state.rows) || !Number.isInteger(state.columns)) return { error: 'GameState 行列非法' };
  if (state.tiles.length !== state.rows * state.columns) return { error: 'GameState 地块数量与行列不符' };
  const config = p.config;
  if (!config || typeof config !== 'object') return { error: '缺少存档配置' };
  if (!validateMapData(config.map)) return { error: '初始地图结构非法' };
  if (!Array.isArray(config.seatAssignments) || config.seatAssignments.length === 0) {
    return { error: 'seatAssignments 非法' };
  }

  const serialized = JSON.stringify(p);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    const label = maxBytes >= 1024 * 1024 ? `${Math.floor(maxBytes / 1024 / 1024)}MB` : `${Math.floor(maxBytes / 1024)}KB`;
    return { error: `存档超过 ${label} 上限` };
  }
  return { body: b as PveSaveBody, serialized };
}

/** PVE 地图 / 权重 / 存档接口（对局本身不经过服务器） */
export const pveRoutes: FastifyPluginAsync = async (app) => {
  // ---------- 地图库 ----------

  app.get('/api/pve/maps', async (request, reply) => {
    refreshPveMaps(app);
    const { search } = request.query as { search?: string };
    const mapList = app.pveMaps.list(search).filter(isPvePlayableMap);
    return ok(reply, { mapList } satisfies MapListResult);
  });

  // 注意：静态段路由需在 /:id 之前注册
  app.get('/api/pve/maps/random', async (request, reply) => {
    refreshPveMaps(app);
    const { exclude, minPlayers } = request.query as {
      exclude?: string;
      minPlayers?: string;
    };
    const min = Math.max(2, Number(minPlayers) || 2);
    let candidates = app.pveMaps
      .list()
      .filter(isPvePlayableMap)
      .filter((m) => m.playerNum >= min);
    if (exclude && candidates.length > 1) candidates = candidates.filter((m) => m.id !== exclude);
    if (candidates.length === 0) {
      return fail(reply, 404, ERROR_CODES.MAP_NOT_FOUND, 'PVE 地图库为空或没有可玩地图');
    }
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const map = app.pveMaps.get(pick.id);
    if (!map) return fail(reply, 404, ERROR_CODES.MAP_NOT_FOUND, '随机地图读取失败');
    return ok(reply, { map } satisfies PveRandomMapResult);
  });

  app.get('/api/pve/maps/:id/preview', async (request, reply) => {
    refreshPveMaps(app);
    const { id } = request.params as { id: string };
    const map = app.pveMaps.get(id);
    if (!map) return fail(reply, 404, ERROR_CODES.MAP_NOT_FOUND, '地图不存在');
    return ok(reply, { row: map.row, column: map.column, battlefield: map.battlefield });
  });

  app.get('/api/pve/maps/:id', async (request, reply) => {
    refreshPveMaps(app);
    const { id } = request.params as { id: string };
    const map = app.pveMaps.get(id);
    if (!map) return fail(reply, 404, ERROR_CODES.MAP_NOT_FOUND, '地图不存在');
    return ok(reply, map);
  });

  // ---------- 普通 AI 权重 ----------

  app.get('/api/pve/ai/weights', { preHandler: authPreHandler }, async (_request, reply) => {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(app.pveWeightsPath, 'utf8'));
    } catch {
      return fail(reply, 503, ERROR_CODES.AI_WEIGHTS_UNAVAILABLE, '普通 AI 权重文件不可用');
    }
    const rec = raw as { version?: unknown; weights?: unknown; mid?: unknown; late?: unknown };
    const w = (rec.weights ?? rec) as { mid?: unknown; late?: unknown };
    const valid = (v: unknown): v is number[] =>
      Array.isArray(v) && v.length === 6 && v.every((n) => typeof n === 'number' && Number.isFinite(n));
    if (!valid(w.mid) || !valid(w.late)) {
      return fail(reply, 503, ERROR_CODES.AI_WEIGHTS_UNAVAILABLE, '普通 AI 权重格式异常');
    }
    return ok(reply, {
      version: typeof rec.version === 'number' ? rec.version : 0,
      weights: { mid: w.mid, late: w.late },
    } satisfies PveWeightsResult);
  });

  // ---------- 存档（一账号一行；新覆盖旧；对局结束前端无条件 DELETE） ----------

  app.put(
    '/api/pve/save',
    { preHandler: authPreHandler, bodyLimit: SAVE_BODY_LIMIT },
    async (request, reply) => {
      const parsed = parseSaveBody(request.body, app.pveSaveMaxBytes);
      if ('error' in parsed) return fail(reply, 400, ERROR_CODES.INVALID_PARAMS, parsed.error);
      const userId = request.user!.userId;
      const now = Date.now();
      const values = {
        userId,
        gameId: parsed.body.gameId,
        mapTitle: parsed.body.mapTitle,
        turn: parsed.body.turn,
        phase: parsed.body.phase,
        currentSeat: parsed.body.currentSeat,
        currentForce: parsed.body.currentForce,
        payload: parsed.serialized,
        updatedAt: now,
      };
      app.db
        .insert(pveSaves)
        .values(values)
        .onConflictDoUpdate({
          target: pveSaves.userId,
          set: {
            gameId: values.gameId,
            mapTitle: values.mapTitle,
            turn: values.turn,
            phase: values.phase,
            currentSeat: values.currentSeat,
            currentForce: values.currentForce,
            payload: values.payload,
            updatedAt: values.updatedAt,
          },
        })
        .run();
      return ok(reply, { savedAt: now });
    },
  );

  app.get('/api/pve/save', { preHandler: authPreHandler }, async (request, reply) => {
    const row = app.db.select().from(pveSaves).where(eq(pveSaves.userId, request.user!.userId)).get();
    if (!row) return ok(reply, { save: null } satisfies PveSaveResponse);
    try {
      const save = JSON.parse(row.payload) as PveSavePayload;
      return ok(reply, { save } satisfies PveSaveResponse);
    } catch {
      return fail(reply, 500, ERROR_CODES.INVALID_PARAMS, '存档数据损坏');
    }
  });

  app.get('/api/pve/save/meta', { preHandler: authPreHandler }, async (request, reply) => {
    const row = app.db.select().from(pveSaves).where(eq(pveSaves.userId, request.user!.userId)).get();
    if (!row) return ok(reply, { exists: false } satisfies PveSaveMetaResponse);
    return ok(reply, {
      exists: true,
      gameId: row.gameId,
      mapTitle: row.mapTitle,
      turn: row.turn,
      phase: row.phase as PveSaveMetaResponse['phase'],
      currentSeat: row.currentSeat,
      currentForce: row.currentForce,
      savedAt: row.updatedAt,
    } satisfies PveSaveMetaResponse);
  });

  app.delete('/api/pve/save', { preHandler: authPreHandler }, async (request, reply) => {
    const result = app.db.delete(pveSaves).where(eq(pveSaves.userId, request.user!.userId)).run();
    return ok(reply, { deleted: result.changes > 0 });
  });
};
