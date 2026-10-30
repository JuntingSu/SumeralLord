import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { pveMapJson } from './pve-fixtures.js';

let app: FastifyInstance;
let dir: string;
let mapsDir: string;

function writeMap(file: string, map: unknown): void {
  writeFileSync(path.join(mapsDir, file), JSON.stringify(map), 'utf8');
}

describe('PVE 地图库（懒加载 + mtime 缓存 + 可玩过滤）', () => {
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'dl-pve-maps-'));
    const staticRoot = path.join(dir, 'static');
    mapsDir = path.join(staticRoot, 'pve_maps');
    mkdirSync(mapsDir, { recursive: true });
    writeMap('duo.json', pveMapJson({ title: '双人图' }));
    writeMap('solo.json', pveMapJson({ title: '单人图', playerNum: 1 }));
    const broken = pveMapJson({ title: '坏图' });
    broken.battlefield.pop();
    writeMap('broken.json', broken);
    writeMap('big.json', pveMapJson({ title: '超宽图', row: 256, column: 1 }));
    app = await buildApp({
      dbPath: path.join(dir, 'test.db'),
      logger: false,
      staticRoot,
      pveMapsReloadMs: 60_000,
    });
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('列表只返回可玩地图（≥2 势力且 ≤255×255），跳过非法图', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pve/maps' });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().data.mapList as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toEqual(['duo']);
  });

  it('search 过滤', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pve/maps?search=' + encodeURIComponent('双人') });
    const ids = (res.json().data.mapList as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toEqual(['duo']);
  });

  it('完整地图与预览', async () => {
    const full = await app.inject({ method: 'GET', url: '/api/pve/maps/duo' });
    expect(full.statusCode).toBe(200);
    expect(full.json().data.id).toBe('duo');
    expect(full.json().data.title).toBe('双人图');

    const preview = await app.inject({ method: 'GET', url: '/api/pve/maps/duo/preview' });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.battlefield).toHaveLength(20);

    const missing = await app.inject({ method: 'GET', url: '/api/pve/maps/missing' });
    expect(missing.statusCode).toBe(404);
  });

  it('random 返回可玩地图的完整数据', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pve/maps/random' });
    expect(res.statusCode).toBe(200);
    const map = res.json().data.map;
    expect(map.id).toBe('duo');
    expect(map.player_num).toBe(2);
  });

  it('新增地图后下一次请求即可见（按需 refresh + mtime 缓存）', async () => {
    writeMap('duo2.json', pveMapJson({ title: '第二张双人图' }));
    const res = await app.inject({ method: 'GET', url: '/api/pve/maps' });
    const ids = (res.json().data.mapList as Array<{ id: string }>).map((m) => m.id);
    expect(ids.sort()).toEqual(['duo', 'duo2']);

    const random = await app.inject({ method: 'GET', url: '/api/pve/maps/random?exclude=duo' });
    expect(random.statusCode).toBe(200);
    expect(random.json().data.map.id).toBe('duo2');
  });

  it('修改地图（size 变化）后元数据更新', async () => {
    writeMap('duo.json', pveMapJson({ title: '双人图-改' }));
    const res = await app.inject({ method: 'GET', url: '/api/pve/maps?search=' + encodeURIComponent('改') });
    const list = res.json().data.mapList as Array<{ id: string; title: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'duo', title: '双人图-改' });
  });

  it('删除文件后从列表消失；空库 random 返回 404', async () => {
    unlinkSync(path.join(mapsDir, 'duo2.json'));
    unlinkSync(path.join(mapsDir, 'duo.json'));
    unlinkSync(path.join(mapsDir, 'solo.json'));
    unlinkSync(path.join(mapsDir, 'broken.json'));
    unlinkSync(path.join(mapsDir, 'big.json'));
    const list = await app.inject({ method: 'GET', url: '/api/pve/maps' });
    expect(list.json().data.mapList).toEqual([]);
    const random = await app.inject({ method: 'GET', url: '/api/pve/maps/random' });
    expect(random.statusCode).toBe(404);
    expect(random.json().code).toBe('MAP_NOT_FOUND');
  });
});
