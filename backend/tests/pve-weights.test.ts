import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;
let dir: string;
let token = '';

async function registerLogin(target: FastifyInstance, username: string): Promise<string> {
  await target.inject({ method: 'POST', url: '/api/auth/register', payload: { username, password: 'secret1' } });
  const res = await target.inject({ method: 'POST', url: '/api/auth/login', payload: { username, password: 'secret1' } });
  return res.json().data.token as string;
}

describe('PVE 普通 AI 权重', () => {
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'dl-pve-weights-'));
    const staticRoot = path.join(dir, 'static');
    mkdirSync(path.join(staticRoot, 'pve_maps'), { recursive: true });
    app = await buildApp({
      dbPath: path.join(dir, 'test.db'),
      logger: false,
      staticRoot,
      authRate: { registerPerMin: 100, loginPerMin: 100 },
    });
    token = await registerLogin(app, 'alice');
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('登录后返回 v45 权重（mid/late 各 6 维）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/pve/ai/weights',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { version: number; weights: { mid: number[]; late: number[] } };
    expect(data.version).toBe(45);
    expect(data.weights.mid).toHaveLength(6);
    expect(data.weights.late).toHaveLength(6);
    expect(data.weights.mid.every((n) => typeof n === 'number')).toBe(true);
  });

  it('未登录 → 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/pve/ai/weights' });
    expect(res.statusCode).toBe(401);
  });
});

describe('PVE 普通 AI 权重缺失', () => {
  let missing: FastifyInstance;
  let missingDir: string;

  beforeAll(async () => {
    missingDir = mkdtempSync(path.join(tmpdir(), 'dl-pve-weights-missing-'));
    const staticRoot = path.join(missingDir, 'static');
    mkdirSync(path.join(staticRoot, 'pve_maps'), { recursive: true });
    missing = await buildApp({
      dbPath: path.join(missingDir, 'test.db'),
      logger: false,
      staticRoot,
      authRate: { registerPerMin: 100, loginPerMin: 100 },
      pveWeightsPath: path.join(missingDir, 'no-such-weights.json'),
    });
  });

  afterAll(async () => {
    await missing.close();
    rmSync(missingDir, { recursive: true, force: true });
  });

  it('文件缺失 → 503 AI_WEIGHTS_UNAVAILABLE', async () => {
    const token = await registerLogin(missing, 'bob');
    const res = await missing.inject({
      method: 'GET',
      url: '/api/pve/ai/weights',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('AI_WEIGHTS_UNAVAILABLE');
  });
});
