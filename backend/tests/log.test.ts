// BM7a/BM7b：回放日志与战绩查询（GAME_START 首行持久化 / log 鉴权与分页 / history 鉴权）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { matchHistory } from '../src/db/schema.js';

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

/** 完整开局流程：A 建房 → B 加入 → 选势力 → 双准备 → A 开始，返回 gameId */
async function startGame(roomName = 'log测试房'): Promise<string> {
  const a = users.get('alice')!;
  const b = users.get('bob')!;
  const auth = (u: UserEntry) => ({ authorization: `Bearer ${u.token}` });
  const create = await app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: auth(a),
    payload: {
      name: roomName,
      allowSpectate: true,
      fogMode: false,
      randomSpawn: false,
      mapId: 'map_duo_plain',
      timeSettings: { stepTime: 90, gameTime: 1200, additionalTime: 0 },
    },
  });
  const roomId = create.json().data.roomId as string;
  await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/join`, headers: auth(b), payload: {} });
  await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth(a), payload: { seat: 1 } });
  await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth(b), payload: { seat: 2 } });
  await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/ready`, headers: auth(a), payload: { ready: true } });
  await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/ready`, headers: auth(b), payload: { ready: true } });
  const start = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/start`, headers: auth(a), payload: {} });
  expect(start.statusCode).toBe(200);
  return start.json().data.gameId as string;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'dl-log-'));
  app = await buildApp({ dbPath: path.join(dir, 'test.db'), logger: false, skinDir: path.join(dir, 'skin') });
  await app.ready();
  await newUser('alice');
  await newUser('bob');
  await newUser('carol');
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('BM7a 回放日志（GET /api/game/:gameId/log）', () => {
  let gameId: string;
  beforeAll(async () => {
    gameId = await startGame();
  });

  it('GAME_START 持久化为 JSONL 首行，log 返回开局负载', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/game/${gameId}/log`,
      headers: { authorization: `Bearer ${users.get('alice')!.token}` },
    });
    expect(res.statusCode).toBe(200);
    const { start, events, nextCursor } = res.json().data;
    expect(start).not.toBeNull();
    expect(start.type).toBe('GAME_START');
    expect(start.gameId).toBe(gameId);
    expect(start.map.player_list.length).toBe(2);
    expect(start.seatAssignments).toHaveLength(2);
    expect(start.timeSettings.stepTime).toBe(90);
    expect(events).toEqual([]);
    expect(nextCursor).toBe(0);
  });

  it('意图事件可经 log 分页读取', async () => {
    // 模拟服务器写入一条意图流消息（gateway 职责，测试直接驱动持久化层）
    app.games.appendEvent(app.games.get(gameId)!, {
      type: 'INTENT_BROADCAST',
      eventId: 1,
      from: '9',
      fromSeat: 1,
      intent: { intentType: 'SWITCH_PHASE' },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/game/${gameId}/log?after=0&limit=10`,
      headers: { authorization: `Bearer ${users.get('bob')!.token}` },
    });
    expect(res.statusCode).toBe(200);
    const { start, events } = res.json().data;
    expect(start).not.toBeNull(); // 首行 GAME_START 仍被识别
    expect(events).toHaveLength(1);
    expect(events[0].eventId).toBe(1);
    expect(events[0].intent.intentType).toBe('SWITCH_PHASE');
  });

  it('鉴权：未参与对局的用户 403；不存在对局 404', async () => {
    const carol = users.get('carol')!;
    const res = await app.inject({
      method: 'GET',
      url: `/api/game/${gameId}/log`,
      headers: { authorization: `Bearer ${carol.token}` },
    });
    expect(res.statusCode).toBe(403);
    const missing = await app.inject({
      method: 'GET',
      url: '/api/game/gNoSuchGame/log',
      headers: { authorization: `Bearer ${carol.token}` },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('BM7b 战绩查询（GET /api/users/:id/history）', () => {
  it('返回本人对局记录（含回放所需 gameId 与胜负）；按结束时间倒序', async () => {
    const a = users.get('alice')!;
    const b = users.get('bob')!;
    const now = Date.now();
    app.db.insert(matchHistory).values({
      gameId: 'gHist1',
      roomId: 'rHist1',
      startedAt: now - 10_000,
      finishedAt: now - 5_000,
      winners: JSON.stringify([String(a.id)]),
      winningTeam: 1,
      participants: JSON.stringify([
        { seat: 1, playerId: a.id, isAI: false },
        { seat: 2, playerId: b.id, isAI: false },
      ]),
      aborted: 0,
    }).run();
    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${a.id}/history`,
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(res.statusCode).toBe(200);
    const { history } = res.json().data;
    expect(history.length).toBeGreaterThanOrEqual(1);
    const mine = history.find((h: { gameId: string }) => h.gameId === 'gHist1');
    expect(mine).toBeDefined();
    expect(mine.winners).toEqual([String(a.id)]);
    expect(mine.winningTeam).toBe(1);
    expect(mine.aborted).toBe(false);
    expect(mine.participants).toHaveLength(2);
    // 倒序
    const times = history.map((h: { finishedAt: number }) => h.finishedAt);
    expect([...times].sort((x, y) => y - x)).toEqual(times);
  });

  it('鉴权：仅本人可查', async () => {
    const a = users.get('alice')!;
    const b = users.get('bob')!;
    const res = await app.inject({
      method: 'GET',
      url: `/api/users/${a.id}/history`,
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
