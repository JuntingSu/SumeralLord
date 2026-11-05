// 演示回放读取接口：POST /api/demo/replay
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;
let dir: string;
let demoDir: string;

function demoFile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    type: 'demo-replay',
    reducerVersion: 'test',
    createdAt: '2026-11-04T00:00:00.000Z',
    mapTitle: '测试演示',
    initialState: {
      rows: 2,
      columns: 2,
      tiles: [{}, {}, {}, {}],
      forces: [{ seat: 1 }],
      turnOrder: [1],
      currentSeat: 1,
      turn: 1,
      phase: 'ACTION',
      finished: false,
    },
    steps: [],
    ...overrides,
  };
}

function writeDemo(file: string, content: unknown): void {
  writeFileSync(path.join(demoDir, file), JSON.stringify(content), 'utf8');
}

describe('演示回放读取接口', () => {
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'dl-demo-replay-'));
    const staticRoot = path.join(dir, 'static');
    demoDir = path.join(staticRoot, 'demo');
    mkdirSync(demoDir, { recursive: true });
    writeDemo('sample.json', demoFile());
    writeFileSync(path.join(demoDir, 'badjson.json'), '{', 'utf8');
    writeDemo('badshape.json', demoFile({ version: 2 }));
    writeFileSync(path.join(demoDir, 'huge.json'), '');
    truncateSync(path.join(demoDir, 'huge.json'), 64 * 1024 * 1024 + 1);
    app = await buildApp({
      dbPath: path.join(dir, 'test.db'),
      logger: false,
      staticRoot,
      pveMapsReloadMs: 60_000,
    });
  });

  afterAll(async () => {
    if (app) await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('按 filename 读取回放，支持带 .json 后缀', async () => {
    const a = await app.inject({ method: 'POST', url: '/api/demo/replay', payload: { filename: 'sample' } });
    expect(a.statusCode).toBe(200);
    expect(a.json().data.mapTitle).toBe('测试演示');

    const b = await app.inject({ method: 'POST', url: '/api/demo/replay', payload: { filename: 'sample.json' } });
    expect(b.statusCode).toBe(200);
    expect(b.json().data.type).toBe('demo-replay');
  });

  it('文件不存在返回 404', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/demo/replay', payload: { filename: 'missing' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('DEMO_REPLAY_NOT_FOUND');
  });

  it('非法文件名拒绝路径穿越', async () => {
    for (const filename of ['../secret', 'a/b', 'a\\b', '..', '', 'x'.repeat(100)]) {
      const res = await app.inject({ method: 'POST', url: '/api/demo/replay', payload: { filename } });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('INVALID_PARAMS');
    }
  });

  it('非法 JSON / 结构非法返回 400', async () => {
    const badJson = await app.inject({ method: 'POST', url: '/api/demo/replay', payload: { filename: 'badjson' } });
    expect(badJson.statusCode).toBe(400);
    const badShape = await app.inject({ method: 'POST', url: '/api/demo/replay', payload: { filename: 'badshape' } });
    expect(badShape.statusCode).toBe(400);
  });

  it('超过大小上限返回 413', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/demo/replay', payload: { filename: 'huge' } });
    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe('DEMO_REPLAY_TOO_LARGE');
  });
});
