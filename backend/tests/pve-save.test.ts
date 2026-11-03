import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { initState } from '@dl/shared';
import type { PveSaveBody, PveSavePayload } from '@dl/shared';
import { buildApp } from '../src/app.js';
import { pveSaves } from '../src/db/schema.js';
import { pveMapJson, pveSeatAssignments } from './pve-fixtures.js';

let app: FastifyInstance;
let dir: string;
let alice = '';
let bob = '';

async function registerLogin(target: FastifyInstance, username: string): Promise<string> {
  await target.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username, password: 'secret1' },
  });
  const res = await target.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password: 'secret1' },
  });
  return res.json().data.token as string;
}

function auth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function makeBody(humanUserId: number, gameId = 'pve-1', mapTitle = 'PVE 测试图'): PveSaveBody {
  const map = pveMapJson({ title: mapTitle });
  const seatAssignments = pveSeatAssignments(map, humanUserId);
  const state = initState({
    map,
    seatAssignments,
    seed: 'pve-seed',
    timeSettings: { stepTime: 90, gameTime: 1200, additionalTime: 0 },
  }).state;
  const currentForceName = state.forces.find((f) => f.seat === state.currentSeat)?.name ?? '';
  const payload: PveSavePayload = {
    version: 3,
    gameId,
    reducerVersion: 'test',
    savedAt: Date.now(),
    mapTitle: map.title,
    state,
    config: {
      map,
      seatAssignments,
      fogMode: false,
      usePersonalSkin: false,
      playerSeat: 1,
      humanUserId,
    },
    meta: {
      turn: state.turn,
      phase: state.phase,
      currentSeat: state.currentSeat,
      currentForceName,
    },
  };
  return {
    gameId,
    mapTitle: map.title,
    turn: state.turn,
    phase: state.phase,
    currentSeat: state.currentSeat,
    currentForce: currentForceName,
    payload,
  };
}

describe('PVE 存档', () => {
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'dl-pve-save-'));
    const staticRoot = path.join(dir, 'static');
    mkdirSync(path.join(staticRoot, 'pve_maps'), { recursive: true });
    app = await buildApp({
      dbPath: path.join(dir, 'test.db'),
      logger: false,
      staticRoot,
      authRate: { registerPerMin: 100, loginPerMin: 100 },
    });
    alice = await registerLogin(app, 'alice');
    bob = await registerLogin(app, 'bob');
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('未登录 PUT → 401', async () => {
    const res = await app.inject({ method: 'PUT', url: '/api/pve/save', payload: makeBody(1) });
    expect(res.statusCode).toBe(401);
  });

  it('PUT/GET/meta：完整 GameState 存档往返，一账号一行', async () => {
    const body = makeBody(1, 'pve-1', '第一局');
    const put = await app.inject({ method: 'PUT', url: '/api/pve/save', headers: auth(alice), payload: body });
    expect(put.statusCode).toBe(200);
    expect(typeof put.json().data.savedAt).toBe('number');

    const get = await app.inject({ method: 'GET', url: '/api/pve/save', headers: auth(alice) });
    expect(get.statusCode).toBe(200);
    const save = get.json().data.save as PveSavePayload;
    expect(save.version).toBe(3);
    expect(save.gameId).toBe('pve-1');
    expect(save.state.tiles).toHaveLength(body.payload.state.tiles.length);
    expect(save.config.map.title).toBe('第一局');

    const meta = await app.inject({ method: 'GET', url: '/api/pve/save/meta', headers: auth(alice) });
    expect(meta.json().data).toMatchObject({
      exists: true,
      gameId: 'pve-1',
      mapTitle: '第一局',
      currentSeat: 1,
      currentForce: '势力1',
    });

    const second = makeBody(1, 'pve-2', '第二局');
    await app.inject({ method: 'PUT', url: '/api/pve/save', headers: auth(alice), payload: second });
    const meta2 = await app.inject({ method: 'GET', url: '/api/pve/save/meta', headers: auth(alice) });
    expect(meta2.json().data).toMatchObject({ gameId: 'pve-2', mapTitle: '第二局' });
    expect(app.db.select().from(pveSaves).all()).toHaveLength(1);
  });

  it('账号隔离：bob 读不到 alice 的存档', async () => {
    const get = await app.inject({ method: 'GET', url: '/api/pve/save', headers: auth(bob) });
    expect(get.json().data.save).toBeNull();
    const meta = await app.inject({ method: 'GET', url: '/api/pve/save/meta', headers: auth(bob) });
    expect(meta.json().data).toEqual({ exists: false });

    const put = await app.inject({ method: 'PUT', url: '/api/pve/save', headers: auth(bob), payload: makeBody(2, 'pve-bob', 'Bob 的图') });
    expect(put.statusCode).toBe(200);
    const aliceMeta = await app.inject({ method: 'GET', url: '/api/pve/save/meta', headers: auth(alice) });
    expect(aliceMeta.json().data.mapTitle).toBe('第二局');
  });

  it('DELETE 无条件删除本人存档（不看 gameId），幂等', async () => {
    const first = await app.inject({ method: 'DELETE', url: '/api/pve/save', headers: auth(alice) });
    expect(first.json().data.deleted).toBe(true);
    const after = await app.inject({ method: 'GET', url: '/api/pve/save', headers: auth(alice) });
    expect(after.json().data.save).toBeNull();
    const second = await app.inject({ method: 'DELETE', url: '/api/pve/save', headers: auth(alice) });
    expect(second.json().data.deleted).toBe(false);
    // bob 的存档不受影响
    const bobGet = await app.inject({ method: 'GET', url: '/api/pve/save', headers: auth(bob) });
    expect(bobGet.json().data.save.gameId).toBe('pve-bob');
  });

  it('非法 payload → 400', async () => {
    const body = makeBody(1);
    (body.payload as unknown as { state: unknown }).state = null;
    const res = await app.inject({ method: 'PUT', url: '/api/pve/save', headers: auth(alice), payload: body });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INVALID_PARAMS');
  });
});

describe('PVE 存档大小上限（注入小上限）', () => {
  let small: FastifyInstance;
  let smallDir: string;

  beforeAll(async () => {
    smallDir = mkdtempSync(path.join(tmpdir(), 'dl-pve-save-small-'));
    const staticRoot = path.join(smallDir, 'static');
    mkdirSync(path.join(staticRoot, 'pve_maps'), { recursive: true });
    small = await buildApp({
      dbPath: path.join(smallDir, 'test.db'),
      logger: false,
      staticRoot,
      authRate: { registerPerMin: 100, loginPerMin: 100 },
      pveSaveMaxBytes: 1024,
    });
  });

  afterAll(async () => {
    await small.close();
    rmSync(smallDir, { recursive: true, force: true });
  });

  it('超过上限 → 400', async () => {
    const token = await registerLogin(small, 'carol');
    const res = await small.inject({ method: 'PUT', url: '/api/pve/save', headers: auth(token), payload: makeBody(1) });
    expect(res.statusCode).toBe(400);
    expect(res.json().message).toContain('上限');
  });
});
