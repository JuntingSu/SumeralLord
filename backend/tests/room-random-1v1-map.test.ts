// 随机 1v1 对称地图房间：房间设置开关 → 势力重置为先手/后手 → 开局现场生成对称地图
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { TERRAIN, symmetryImageOf, type MapFullData, type SeatAssignment, type SymmetryMode } from '@dl/shared';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;
let dir: string;
const users = new Map<string, { token: string; id: number }>();

async function newUser(name: string): Promise<{ token: string; id: number }> {
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: name, password: 'secret1' } });
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: name, password: 'secret1' },
  });
  const data = login.json().data;
  const entry = { token: data.token as string, id: data.user.id as number };
  users.set(name, entry);
  return entry;
}

function auth(name: string): { authorization: string } {
  return { authorization: `Bearer ${users.get(name)!.token}` };
}

/** 某势力（seat）的有主据点 */
function ownedSpawn(map: MapFullData, seat: number): { index: number; strength: number } {
  for (let i = 0; i < map.battlefield.length; i++) {
    const [terrain, owner, strength] = map.battlefield[i];
    if (terrain === TERRAIN.CITY && owner === seat) return { index: i, strength };
  }
  throw new Error(`地图中找不到 seat${seat} 的有主据点`);
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'dl-sym1v1-'));
  app = await buildApp({
    dbPath: path.join(dir, 'test.db'),
    logger: false,
    skinDir: path.join(dir, 'skin'),
    authRate: { registerPerMin: 1000, loginPerMin: 1000 },
  });
  for (const name of ['symhost', 'symguest']) await newUser(name);
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('随机 1v1 对称地图房间', () => {
  it('开启开关：势力重置为先手/后手两人、已准备玩家回落；关闭后恢复原地图势力', async () => {
    const host = 'symhost';
    const create = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth(host),
      payload: {
        name: '随机1v1测试房',
        allowSpectate: true,
        fogMode: false,
        randomSpawn: false,
        mapId: 'map_duo_plain',
        timeSettings: { stepTime: 90, gameTime: 1200, additionalTime: 0 },
      },
    });
    expect(create.statusCode).toBe(200);
    const created = create.json().data.room;
    const roomId = create.json().data.roomId as string;
    const originalForceNames = (created.forces as Array<{ name: string }>).map((f) => f.name);
    expect(created.random1v1Map).toBe(false);

    // 先选势力并准备，用于验证切换模式会让已准备玩家回落
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth(host), payload: { seat: 1 } });
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/ready`, headers: auth(host), payload: { ready: true } });

    const on = await app.inject({
      method: 'PATCH',
      url: `/api/rooms/${roomId}/settings`,
      headers: auth(host),
      payload: { random1v1Map: true },
    });
    expect(on.statusCode).toBe(200);
    const patched = on.json().data;
    expect(patched.random1v1Map).toBe(true);
    expect((patched.forces as Array<{ name: string }>).map((f) => f.name)).toEqual(['先手', '后手']);
    expect((patched.forces as Array<{ seat: number }>).map((f) => f.seat)).toEqual([1, 2]);
    expect((patched.forces as Array<{ playerId: number | null }>).every((f) => f.playerId === null)).toBe(true);
    expect(patched.playerNum).toBe(2);
    expect((patched.players as Array<{ id: number; state: string }>).find((p) => p.id === users.get(host)!.id)!.state).toBe(
      'unready',
    );

    // 该模式下不允许更换地图（否则会破坏先手/后手不变式）
    const changeMap = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/change-map`,
      headers: auth(host),
      payload: { mapId: 'map_duo_plain' },
    });
    expect(changeMap.statusCode).toBe(400);

    // 关闭后按原地图重建势力
    const off = await app.inject({
      method: 'PATCH',
      url: `/api/rooms/${roomId}/settings`,
      headers: auth(host),
      payload: { random1v1Map: false },
    });
    expect(off.statusCode).toBe(200);
    expect(off.json().data.random1v1Map).toBe(false);
    expect((off.json().data.forces as Array<{ name: string }>).map((f) => f.name)).toEqual(originalForceNames);

    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/disband`, headers: auth(host), payload: {} });
  });

  it('开局使用现场生成的对称地图：两势力先手/后手、先手→seat1、后手→seat2', async () => {
    const host = 'symhost';
    const guest = 'symguest';
    const create = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth(host),
      payload: {
        name: '随机1v1对局房',
        allowSpectate: true,
        fogMode: false,
        randomSpawn: false,
        mapId: 'map_duo_plain',
        timeSettings: { stepTime: 90, gameTime: 1200, additionalTime: 0 },
      },
    });
    const roomId = create.json().data.roomId as string;
    await app.inject({ method: 'PATCH', url: `/api/rooms/${roomId}/settings`, headers: auth(host), payload: { random1v1Map: true } });
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/join`, headers: auth(guest), payload: {} });
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth(host), payload: { seat: 1 } });
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth(guest), payload: { seat: 2 } });
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/ready`, headers: auth(host), payload: { ready: true } });
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/ready`, headers: auth(guest), payload: { ready: true } });

    const start = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/start`, headers: auth(host), payload: {} });
    expect(start.statusCode).toBe(200);
    const gameId = start.json().data.gameId as string;

    const meta = await app.inject({ method: 'GET', url: `/api/game/${gameId}/meta`, headers: auth(host) });
    expect(meta.statusCode).toBe(200);
    const { map, seatAssignments } = meta.json().data as { map: MapFullData; seatAssignments: SeatAssignment[] };

    // 现场生成的对称地图（不来自房间所选地图）
    expect(map.id.startsWith('sym1v1-')).toBe(true);
    expect(map.player_num).toBe(2);
    expect(map.player_list.map((p) => p.name)).toEqual(['先手', '后手']);
    expect(map.row % 2).toBe(1);
    expect(map.column % 2).toBe(1);

    // 两座有主据点：先手 seat1 兵力 3 / 后手 seat2 兵力 4
    const s1 = ownedSpawn(map, 1);
    const s2 = ownedSpawn(map, 2);
    expect(s1.strength).toBe(3);
    expect(s2.strength).toBe(4);

    // 地形满足中心对称或轴对称之一
    const holds = (mode: SymmetryMode) =>
      map.battlefield.every((tile, i) => {
        const img = symmetryImageOf(i, map.row, map.column, mode);
        return img < 0 || map.battlefield[img][0] === tile[0];
      });
    expect(holds('center') || holds('axis')).toBe(true);

    // randomSpawn 关闭：先手玩家 → seat1，后手玩家 → seat2
    expect(seatAssignments.find((a) => a.seat === 1)!.playerId).toBe(users.get(host)!.id);
    expect(seatAssignments.find((a) => a.seat === 2)!.playerId).toBe(users.get(guest)!.id);
  });
});
