import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

interface UserEntry {
  token: string;
  id: number;
}

let app: FastifyInstance;
let dir: string;
const users = new Map<string, UserEntry>();

async function newUser(name: string): Promise<UserEntry> {
  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: name, password: 'secret1' },
  });
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

function createPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: '测试房间',
    allowSpectate: true,
    fogMode: false,
    randomSpawn: false,
    mapId: 'map_duo_plain',
    timeSettings: { stepTime: 90, gameTime: 1200, additionalTime: 0 },
    ...overrides,
  };
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'dl-rooms-'));
  app = await buildApp({
    dbPath: path.join(dir, 'test.db'),
    logger: false,
    skinDir: path.join(dir, 'skin'),
    authRate: { registerPerMin: 1000, loginPerMin: 1000 },
  });
  for (const name of ['alice', 'bob', 'carol', 'dave', 'eve']) await newUser(name);
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

// 顺序状态机测试：后面的用例依赖前面用例建立的房间状态
describe('房间生命周期（顺序执行）', () => {
  let room1 = '';
  let room2 = '';

  it('创建房间：返回 roomId 与完整 RoomData', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/rooms', headers: auth('alice'), payload: createPayload({ name: '房间一' }) });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    room1 = data.roomId;
    expect(data.room.hostId).toBe(users.get('alice')!.id);
    expect(data.room.status).toBe('waiting');
    expect(data.room.playerNum).toBe(2); // map_duo_plain
    expect(data.room.players).toHaveLength(1);
    expect(data.room.players[0]).toMatchObject({ username: 'alice', state: 'unready' });
    expect(data.room.forces).toHaveLength(2);
    expect(data.room.forces.every((f: { playerId: number | null }) => f.playerId === null)).toBe(true);
  });

  it('未认证创建/加入 → 401', async () => {
    const create = await app.inject({ method: 'POST', url: '/api/rooms', payload: createPayload() });
    expect(create.statusCode).toBe(401);
    const join = await app.inject({ method: 'POST', url: `/api/rooms/${room1}/join` });
    expect(join.statusCode).toBe(401);
  });

  it('地图不存在 → 400 MAP_NOT_FOUND', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/rooms', headers: auth('bob'), payload: createPayload({ mapId: 'map_nothing' }) });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('MAP_NOT_FOUND');
  });

  it('房间名超长 → 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/rooms', headers: auth('bob'), payload: createPayload({ name: 'x'.repeat(21) }) });
    expect(res.statusCode).toBe(400);
  });

  it('列表包含房间，计数正确', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/rooms', headers: auth('bob') });
    expect(res.statusCode).toBe(200);
    const list = res.json().data as Array<Record<string, unknown>>;
    const item = list.find((r) => r.id === room1);
    expect(item).toMatchObject({ name: '房间一', currentPlayers: 1, spectatorCount: 0, maxPlayers: 2, status: 'waiting', hasPassword: false });
  });

  it('bob 加入 → 满员前一人', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/rooms/${room1}/join`, headers: auth('bob'), payload: { asSpectator: false } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.room.players).toHaveLength(2);
  });

  it('carol 加入满员房间 → 400 ROOM_FULL', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/rooms/${room1}/join`, headers: auth('carol'), payload: { asSpectator: false } });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('ROOM_FULL');
  });

  it('carol 观战加入 → 成功且不计入满员', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/rooms/${room1}/join`, headers: auth('carol'), payload: { asSpectator: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.room.players.find((p: { username: string }) => p.username === 'carol').state).toBe('spectating');
  });

  it('重复加入同一房间 → 幂等成功', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/rooms/${room1}/join`, headers: auth('bob'), payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.room.players).toHaveLength(3);
  });

  it('已在房间中创建/加入其他房间 → 409 ALREADY_IN_ROOM', async () => {
    const create = await app.inject({ method: 'POST', url: '/api/rooms', headers: auth('alice'), payload: createPayload() });
    expect(create.statusCode).toBe(409);
    expect(create.json().code).toBe('ALREADY_IN_ROOM');
  });

  it('房主退出 → 房主顺位继承给最早加入的玩家', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/rooms/${room1}/leave`, headers: auth('alice') });
    expect(res.statusCode).toBe(200);
    const get = await app.inject({ method: 'GET', url: `/api/rooms/${room1}`, headers: auth('bob') });
    const room = get.json().data;
    expect(room.hostId).toBe(users.get('bob')!.id);
    expect(room.players).toHaveLength(2);
  });

  it('创建带密码房间 + 密码校验', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth('alice'),
      payload: createPayload({ name: '房间二', password: 'pw123', mapId: 'map_trio_tripod', allowSpectate: false }),
    });
    expect(create.statusCode).toBe(200);
    room2 = create.json().data.roomId;

    const noPw = await app.inject({ method: 'POST', url: `/api/rooms/${room2}/join`, headers: auth('dave'), payload: { asSpectator: false } });
    expect(noPw.statusCode).toBe(403);
    expect(noPw.json().code).toBe('PASSWORD_WRONG');

    const badPw = await app.inject({ method: 'POST', url: `/api/rooms/${room2}/join`, headers: auth('dave'), payload: { password: 'wrong1', asSpectator: false } });
    expect(badPw.statusCode).toBe(403);

    const okJoin = await app.inject({ method: 'POST', url: `/api/rooms/${room2}/join`, headers: auth('dave'), payload: { password: 'pw123', asSpectator: false } });
    expect(okJoin.statusCode).toBe(200);
  });

  it('不允许观战的房间：观战加入 → 403 SPECTATE_NOT_ALLOWED', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/rooms/${room2}/join`, headers: auth('eve'), payload: { asSpectator: true } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('SPECTATE_NOT_ALLOWED');
  });

  it('房主改设置开启观战与AI接管 → 观战加入成功', async () => {
    const patch = await app.inject({ method: 'PATCH', url: `/api/rooms/${room2}/settings`, headers: auth('alice'), payload: { allowSpectate: true, aiTakeover: true } });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().data.allowSpectate).toBe(true);
    expect(patch.json().data.aiTakeover).toBe(true);

    const join = await app.inject({
      method: 'POST',
      url: `/api/rooms/${room2}/join`,
      headers: auth('eve'),
      payload: { password: 'pw123', asSpectator: true }, // 带密码房间观战同样需要密码
    });
    expect(join.statusCode).toBe(200);
  });

  it('非房主房主操作 → 403 NOT_HOST', async () => {
    const kick = await app.inject({ method: 'POST', url: `/api/rooms/${room2}/kick`, headers: auth('dave'), payload: { playerId: users.get('eve')!.id } });
    expect(kick.statusCode).toBe(403);
    expect(kick.json().code).toBe('NOT_HOST');
    const patch = await app.inject({ method: 'PATCH', url: `/api/rooms/${room2}/settings`, headers: auth('dave'), payload: { fogMode: true } });
    expect(patch.statusCode).toBe(403);
  });

  it('房主踢出观战者 → 成功；踢自己/不存在玩家 → 400', async () => {
    const kick = await app.inject({ method: 'POST', url: `/api/rooms/${room2}/kick`, headers: auth('alice'), payload: { playerId: users.get('eve')!.id } });
    expect(kick.statusCode).toBe(200);
    expect(kick.json().data.players).toHaveLength(2);

    const self = await app.inject({ method: 'POST', url: `/api/rooms/${room2}/kick`, headers: auth('alice'), payload: { playerId: users.get('alice')!.id } });
    expect(self.statusCode).toBe(400);
    const nobody = await app.inject({ method: 'POST', url: `/api/rooms/${room2}/kick`, headers: auth('alice'), payload: { playerId: 99999 } });
    expect(nobody.json().code).toBe('NOT_IN_ROOM');
  });

  it('转让房主 → hostId 变更', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/rooms/${room2}/transfer-host`, headers: auth('alice'), payload: { toPlayerId: users.get('dave')!.id } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.hostId).toBe(users.get('dave')!.id);
  });

  it('换图 → forces 重置为新地图结构，已准备玩家全部回落未准备', async () => {
    // 先选势力再准备（准备前置：必须已选势力）
    await app.inject({ method: 'POST', url: `/api/rooms/${room2}/select-force`, headers: auth('alice'), payload: { seat: 1 } });
    await app.inject({ method: 'POST', url: `/api/rooms/${room2}/select-force`, headers: auth('dave'), payload: { seat: 2 } });
    // 全员准备
    const readyA = await app.inject({ method: 'POST', url: `/api/rooms/${room2}/ready`, headers: auth('alice'), payload: { ready: true } });
    expect(readyA.statusCode).toBe(200);
    const readyD = await app.inject({ method: 'POST', url: `/api/rooms/${room2}/ready`, headers: auth('dave'), payload: { ready: true } });
    expect(readyD.statusCode).toBe(200);

    const res = await app.inject({ method: 'POST', url: `/api/rooms/${room2}/change-map`, headers: auth('dave'), payload: { mapId: 'map_quad_ocean' } });
    expect(res.statusCode).toBe(200);
    const room = res.json().data;
    expect(room.mapId).toBe('map_quad_ocean');
    expect(room.playerNum).toBe(4);
    expect(room.forces).toHaveLength(4);
    expect(room.forces.every((f: { playerId: number | null }) => f.playerId === null)).toBe(true);
    // 已准备状态被重置
    expect(room.players.every((p: { state: string }) => p.state === 'unready')).toBe(true);
  });

  it('未选势力准备 → 403 FORCE_NOT_SELECTED；已准备玩家取消势力 → 状态回落未准备', async () => {
    // 选势力后准备成功
    await app.inject({ method: 'POST', url: `/api/rooms/${room2}/select-force`, headers: auth('alice'), payload: { seat: 1 } });
    const ready = await app.inject({ method: 'POST', url: `/api/rooms/${room2}/ready`, headers: auth('alice'), payload: { ready: true } });
    expect(ready.statusCode).toBe(200);

    // 已准备玩家取消势力 → 准备状态同步回落
    const cancel = await app.inject({ method: 'POST', url: `/api/rooms/${room2}/select-force`, headers: auth('alice'), payload: { seat: -1 } });
    expect(cancel.statusCode).toBe(200);
    const aliceState = (cancel.json().data.players as Array<{ username: string; state: string }>).find((p) => p.username === 'alice');
    expect(aliceState?.state).toBe('unready');

    // 未选势力再准备 → 拒绝
    const reject = await app.inject({ method: 'POST', url: `/api/rooms/${room2}/ready`, headers: auth('alice'), payload: { ready: true } });
    expect(reject.statusCode).toBe(403);
    expect(reject.json().code).toBe('FORCE_NOT_SELECTED');
  });

  it('清除密码 → 无密码加入成功', async () => {
    await app.inject({ method: 'PATCH', url: `/api/rooms/${room2}/settings`, headers: auth('dave'), payload: { password: null } });
    const join = await app.inject({ method: 'POST', url: `/api/rooms/${room2}/join`, headers: auth('eve'), payload: { asSpectator: false } });
    expect(join.statusCode).toBe(200);
  });

  it('解散房间（房主）→ 从列表消失', async () => {
    const res = await app.inject({ method: 'POST', url: `/api/rooms/${room2}/disband`, headers: auth('dave') });
    expect(res.statusCode).toBe(200);
    const list = await app.inject({ method: 'GET', url: '/api/rooms', headers: auth('dave') });
    expect((list.json().data as Array<{ id: string }>).some((r) => r.id === room2)).toBe(false);
  });

  it('房主退出后仅剩观战者 → 观战者继任房主；全部退出 → 房间移除', async () => {
    await app.inject({ method: 'POST', url: `/api/rooms/${room1}/leave`, headers: auth('bob') });
    const get = await app.inject({ method: 'GET', url: `/api/rooms/${room1}`, headers: auth('carol') });
    const room = get.json().data;
    expect(room.hostId).toBe(users.get('carol')!.id);

    await app.inject({ method: 'POST', url: `/api/rooms/${room1}/leave`, headers: auth('carol') });
    const list = await app.inject({ method: 'GET', url: '/api/rooms', headers: auth('carol') });
    expect((list.json().data as Array<{ id: string }>).some((r) => r.id === room1)).toBe(false);
  });

  it('不存在的房间 → 404 ROOM_NOT_FOUND', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/rooms/r00000000', headers: auth('alice') });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('ROOM_NOT_FOUND');
  });
});

describe('GET /api/rooms/mine（服务器为准的状态恢复）', () => {
  it('加入后返回房间，退出后返回 null', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth('alice'),
      payload: createPayload({ name: '我的房间' }),
    });
    expect(create.statusCode).toBe(200);
    const roomId = create.json().data.roomId as string;

    const mine1 = await app.inject({ method: 'GET', url: '/api/rooms/mine', headers: auth('alice') });
    expect(mine1.statusCode).toBe(200);
    expect(mine1.json().data.id).toBe(roomId);

    const mineBob = await app.inject({ method: 'GET', url: '/api/rooms/mine', headers: auth('bob') });
    expect(mineBob.json().data).toBeNull();

    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/leave`, headers: auth('alice') });
    const mine2 = await app.inject({ method: 'GET', url: '/api/rooms/mine', headers: auth('alice') });
    expect(mine2.json().data).toBeNull();
  });
});

describe('空闲自动解散（注入短超时）', () => {
  it('超时房间被扫描移除', async () => {
    const dir2 = mkdtempSync(path.join(tmpdir(), 'dl-sweep-'));
    const sweepApp = await buildApp({
      dbPath: path.join(dir2, 't.db'),
      logger: false,
      skinDir: path.join(dir2, 'skin'),
      authRate: { registerPerMin: 1000, loginPerMin: 1000 },
      roomOpts: { idleMs: 80, sweepIntervalMs: 30 },
    });
    try {
      await sweepApp.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'sweeper', password: 'secret1' } });
      const login = await sweepApp.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'sweeper', password: 'secret1' } });
      const token = login.json().data.token;
      const create = await sweepApp.inject({
        method: 'POST',
        url: '/api/rooms',
        headers: { authorization: `Bearer ${token}` },
        payload: createPayload(),
      });
      expect(create.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 250));
      const list = await sweepApp.inject({ method: 'GET', url: '/api/rooms', headers: { authorization: `Bearer ${token}` } });
      expect(list.json().data).toHaveLength(0);
    } finally {
      await sweepApp.close();
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

describe('房主移出势力（/force-remove）', () => {
  it('房主可将已准备玩家移出势力，被移者回落未准备', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth('alice'),
      payload: createPayload({ name: '移出势力测试' }),
    });
    const roomId = create.json().data.roomId as string;
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/join`, headers: auth('bob'), payload: { asSpectator: false } });
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth('bob'), payload: { seat: 1 } });
    const ready = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/ready`, headers: auth('bob'), payload: { ready: true } });
    expect(ready.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/force-remove`,
      headers: auth('alice'),
      payload: { seat: 1 },
    });
    expect(res.statusCode).toBe(200);
    const room = res.json().data;
    const force = (room.forces as Array<{ seat: number; playerId: number | null }>).find((f) => f.seat === 1);
    expect(force?.playerId).toBeNull();
    const bobState = (room.players as Array<{ username: string; state: string }>).find((p) => p.username === 'bob');
    expect(bobState?.state).toBe('unready');

    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/disband`, headers: auth('alice') });
  });

  it('非房主移出势力 → 403 NOT_HOST；移出空势力/自己 → 400', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth('alice'),
      payload: createPayload({ name: '移出势力测试2' }),
    });
    const roomId = create.json().data.roomId as string;
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/join`, headers: auth('bob'), payload: { asSpectator: false } });
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth('bob'), payload: { seat: 1 } });

    const notHost = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/force-remove`,
      headers: auth('bob'),
      payload: { seat: 2 },
    });
    expect(notHost.statusCode).toBe(403);
    expect(notHost.json().code).toBe('NOT_HOST');

    const empty = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/force-remove`,
      headers: auth('alice'),
      payload: { seat: 2 },
    });
    expect(empty.statusCode).toBe(400);

    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth('alice'), payload: { seat: 2 } });
    const self = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/force-remove`,
      headers: auth('alice'),
      payload: { seat: 2 },
    });
    expect(self.statusCode).toBe(400);

    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/disband`, headers: auth('alice') });
  });
});

describe('房主指定势力 AI 难度（/force-ai）', () => {
  it('开启 AI 接管后，房主可为无主势力指定/清除 AI 难度', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth('alice'),
      payload: createPayload({ name: 'AI 难度测试', aiTakeover: true }),
    });
    const roomId = create.json().data.roomId as string;
    const set = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/force-ai`,
      headers: auth('alice'),
      payload: { seat: 2, aiLevel: 1 },
    });
    expect(set.statusCode).toBe(200);
    const force = (set.json().data.forces as Array<{ seat: number; aiLevel: number | null }>).find((f) => f.seat === 2);
    expect(force?.aiLevel).toBe(1);
    // 清除指定 → 恢复可选
    const clear = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/force-ai`,
      headers: auth('alice'),
      payload: { seat: 2, aiLevel: null },
    });
    expect(clear.statusCode).toBe(200);
    const force2 = (clear.json().data.forces as Array<{ seat: number; aiLevel: number | null }>).find((f) => f.seat === 2);
    expect(force2?.aiLevel).toBeNull();
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/disband`, headers: auth('alice') });
  });

  it('非房主 → 403 NOT_HOST；未开启 AI 接管 → 400 AI_TAKEOVER_OFF；非法难度 → 400', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth('alice'),
      payload: createPayload({ name: 'AI 难度测试2' }), // aiTakeover 默认 false
    });
    const roomId = create.json().data.roomId as string;
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/join`, headers: auth('bob'), payload: { asSpectator: false } });
    // 未开启 AI 接管
    const off = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/force-ai`,
      headers: auth('alice'),
      payload: { seat: 2, aiLevel: 1 },
    });
    expect(off.statusCode).toBe(400);
    expect(off.json().code).toBe('AI_TAKEOVER_OFF');
    // 非法难度（5 不在 1/2/3/255）
    const bad = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/force-ai`,
      headers: auth('alice'),
      payload: { seat: 2, aiLevel: 5 },
    });
    expect(bad.statusCode).toBe(400);
    // 非房主
    const notHost = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/force-ai`,
      headers: auth('bob'),
      payload: { seat: 2, aiLevel: 1 },
    });
    expect(notHost.statusCode).toBe(403);
    expect(notHost.json().code).toBe('NOT_HOST');
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/disband`, headers: auth('alice') });
  });

  it('已占势力指定 → 400 FORCE_OCCUPIED；AI 锁定势力玩家不可选取 → 409 FORCE_AI_LOCKED', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth('alice'),
      payload: createPayload({ name: 'AI 锁定测试', aiTakeover: true }),
    });
    const roomId = create.json().data.roomId as string;
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/join`, headers: auth('bob'), payload: { asSpectator: false } });
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth('bob'), payload: { seat: 1 } });
    // 已占势力不可指定（提示先移出）
    const occupied = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/force-ai`,
      headers: auth('alice'),
      payload: { seat: 1, aiLevel: 2 },
    });
    expect(occupied.statusCode).toBe(400);
    expect(occupied.json().code).toBe('FORCE_OCCUPIED');
    // 指定 seat2 为 AI 难度 3
    const set = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/force-ai`,
      headers: auth('alice'),
      payload: { seat: 2, aiLevel: 3 },
    });
    expect(set.statusCode).toBe(200);
    // bob 取消 seat1 后尝试选取 AI 专属的 seat2 → 拒绝
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth('bob'), payload: { seat: -1 } });
    const locked = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/select-force`,
      headers: auth('bob'),
      payload: { seat: 2 },
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().code).toBe('FORCE_AI_LOCKED');
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/disband`, headers: auth('alice') });
  });

  it('关闭 AI 接管 → 清除全部势力 AI 难度指定', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth('alice'),
      payload: createPayload({ name: 'AI 清空测试', aiTakeover: true }),
    });
    const roomId = create.json().data.roomId as string;
    await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/force-ai`,
      headers: auth('alice'),
      payload: { seat: 2, aiLevel: 255 },
    });
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/rooms/${roomId}/settings`,
      headers: auth('alice'),
      payload: { aiTakeover: false },
    });
    expect(patch.statusCode).toBe(200);
    const forces = patch.json().data.forces as Array<{ seat: number; aiLevel: number | null }>;
    expect(forces.every((f) => f.aiLevel === null)).toBe(true);
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/disband`, headers: auth('alice') });
  });
});
