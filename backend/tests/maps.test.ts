import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'dl-maps-'));
  app = await buildApp({ dbPath: path.join(dir, 'test.db'), logger: false });
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/maps', () => {
  it('无鉴权返回示例地图目录', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/maps' });
    expect(res.statusCode).toBe(200);
    const list = res.json().data.mapList as Array<{ id: string; playerNum: number }>;
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.map((m) => m.id)).toContain('map_duo_plain');
  });

  it('search 按标题/标签过滤', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/maps?search=' + encodeURIComponent('迷雾') });
    const list = res.json().data.mapList as Array<{ id: string }>;
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('map_quad_ocean');
  });
});

describe('GET /api/maps/:id/preview', () => {
  it('返回 row/column/battlefield 且长度匹配', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/maps/map_duo_plain/preview' });
    expect(res.statusCode).toBe(200);
    const preview = res.json().data;
    expect(preview.column).toBe(10);
    expect(preview.row).toBe(7);
    expect(preview.battlefield).toHaveLength(70);
  });

  it('未知地图 → 404 MAP_NOT_FOUND', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/maps/nothing/preview' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('MAP_NOT_FOUND');
  });
});

describe('GET /api/maps/:id', () => {
  it('返回完整地图数据，出生据点归属与 player_list 对应且地块三元组合法', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/maps/map_quad_ocean' });
    expect(res.statusCode).toBe(200);
    const map = res.json().data;
    expect(map.player_num).toBe(4);
    expect(map.player_list).toHaveLength(4);
    expect(map.battlefield).toHaveLength(map.row * map.column);
    // 王城已迁移为据点（编码 2 空缺）：每个玩家恰有一座归属自己的出生据点（terrain=1、belongs=seat、初始兵力 1）
    for (const p of map.player_list) {
      const spawns = map.battlefield.filter((t: number[]) => t[0] === 1 && t[1] === p.seat && t[2] === 1);
      expect(spawns).toHaveLength(1);
    }
    // 全图不再出现 terrain=2
    expect(map.battlefield.some((t: number[]) => t[0] === 2)).toBe(false);
    const validTerrain = new Set([0, 1, 3, 4, 5]);
    const validOwner = (b: number) => b === 128 || b === 255 || b === 0 || (b >= 1 && b <= map.player_num);
    for (const t of map.battlefield) {
      expect(validTerrain.has(t[0])).toBe(true);
      expect(validOwner(t[1])).toBe(true);
      expect(t[2]).toBeGreaterThanOrEqual(0);
    }
    // 2v2 队伍
    expect(map.player_list.map((p: { team: number }) => p.team)).toEqual([1, 1, 2, 2]);
  });

  it('带 // 注释的 example.json 也能加载', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/maps/example' });
    expect(res.statusCode).toBe(200);
    const map = res.json().data;
    expect(map.player_num).toBe(12);
    expect(map.battlefield).toHaveLength(63 * 63);
  });
});
