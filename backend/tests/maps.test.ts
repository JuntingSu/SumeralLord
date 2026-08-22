import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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
});

describe('地图目录热加载（元数据缓存 + 完整地图按需读取）', () => {
  let app: FastifyInstance;
  let dir: string;
  let mapsDir: string;

  const makeMap = (title: string): string =>
    JSON.stringify({
      title,
      author: 'test',
      description: '测试地图',
      row: 2,
      column: 3,
      player_num: 1,
      player_list: [{ name: 'A', team: 1, computer: 0, seat: 1, flag: 0 }],
      battlefield: Array.from({ length: 6 }, () => [0, 0, 0]),
    });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const listIds = async (): Promise<string[]> => {
    const res = await app.inject({ method: 'GET', url: '/api/maps' });
    expect(res.statusCode).toBe(200);
    return (res.json().data.mapList as Array<{ id: string }>).map((m) => m.id);
  };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'dl-maps-hot-'));
    mapsDir = path.join(dir, 'maps');
    mkdirSync(mapsDir, { recursive: true });
    writeFileSync(path.join(mapsDir, 'map_base.json'), makeMap('基础图'));
    app = await buildApp({ dbPath: path.join(dir, 'test.db'), logger: false, staticRoot: dir, mapsReloadMs: 50 });
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('新增地图在刷新间隔后出现在列表，无需重启', async () => {
    writeFileSync(path.join(mapsDir, 'map_new.json'), makeMap('新图'));
    await sleep(150);
    expect(await listIds()).toContain('map_new');
  });

  it('完整地图按需可从磁盘读取', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/maps/map_new' });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.title).toBe('新图');
  });

  it('get 每次返回新对象（完整地图不缓存）', () => {
    const a = app.maps.get('map_new');
    const b = app.maps.get('map_new');
    expect(a).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it('删除地图后从列表消失', async () => {
    rmSync(path.join(mapsDir, 'map_new.json'));
    await sleep(150);
    expect(await listIds()).not.toContain('map_new');
  });

  it('列表返回 row/column 元数据', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/maps' });
    const base = (res.json().data.mapList as Array<{ id: string; row: number; column: number }>).find(
      (m) => m.id === 'map_base',
    );
    expect(base?.row).toBe(2);
    expect(base?.column).toBe(3);
  });
});
