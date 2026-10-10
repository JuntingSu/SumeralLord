// BM4~BM6 端到端：开局 → 意图中继 → 全票共识 → 断线治理 → 重连（加速参数）
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { matchHistory } from '../src/db/schema.js';
import { buildApp } from '../src/app.js';
import { skinFilePath } from '../src/skin.js';
import { shuffleAssignments } from '../src/game/manager.js';

// 断线/共识时间线加速（须在 config 求值前设置）
vi.hoisted(() => {
  process.env.DL_DISCONNECT_DETECT_MS = '50';
  process.env.DL_DISCONNECT_GRACE_MS = '150';
  process.env.DL_CONSENSUS_TIMEOUT_MS = '300';
});

let app: FastifyInstance;
let dir: string;
let port: number;
const users = new Map<string, { token: string; id: number }>();
let aliceC: Client;
let bobC: Client;

function auth(name: string): { authorization: string } {
  return { authorization: `Bearer ${users.get(name)!.token}` };
}

async function newUser(name: string): Promise<void> {
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: name, password: 'secret1' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: name, password: 'secret1' } });
  const data = login.json().data;
  users.set(name, { token: data.token, id: data.user.id });
}

class Client {
  readonly ws: WebSocket;
  readonly messages: Array<Record<string, unknown> & { type: string }> = [];
  private waiters: Array<{ check: (m: Record<string, unknown> & { type: string }) => boolean; resolve: (m: never) => void }> = [];
  private closeWaiters: Array<(code: number, reason: string) => void> = [];
  private closedCode: number | null = null;
  private closeReason = '';

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      this.messages.push(msg);
      this.waiters = this.waiters.filter((w) => {
        if (w.check(msg)) {
          (w.resolve as (m: unknown) => void)(msg);
          return false;
        }
        return true;
      });
    });
    ws.on('close', (code, reason) => {
      this.closedCode = code;
      this.closeReason = reason.toString();
      for (const w of this.closeWaiters.splice(0)) w(code, reason.toString());
    });
    ws.on('error', () => undefined);
  }

  waitFor(match: string | ((m: Record<string, unknown> & { type: string }) => boolean), timeoutMs = 4000): Promise<Record<string, unknown> & { type: string }> {
    const check = typeof match === 'string' ? (m: Record<string, unknown> & { type: string }) => m.type === match : match;
    const existing = this.messages.find(check);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`waitFor(${String(match)}) 超时，已收到: ${this.messages.map((m) => m.type).join(',')}`)),
        timeoutMs,
      );
      this.waiters.push({
        check,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  waitClose(timeoutMs = 4000): Promise<number> {
    if (this.closedCode !== null) return Promise.resolve(this.closedCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitClose 超时')), timeoutMs);
      this.closeWaiters.push((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  close(): void {
    this.ws.close();
  }
}

async function wsConnect(roomId: string, user: string, reducerVersion = 'test-ver'): Promise<Client> {
  const res = await app.inject({ method: 'GET', url: '/api/ws-ticket', headers: auth(user) });
  const ticket = res.json().data.ticket as string;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}&roomId=${roomId}&reducerVersion=${reducerVersion}`);
  const client = new Client(ws);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return client;
}

/** 用户退出其当前所在房间（清理跨测试残留，避免 ALREADY_IN_ROOM） */
async function leaveAllRooms(user: string): Promise<void> {
  const mine = await app.inject({ method: 'GET', url: '/api/rooms/mine', headers: auth(user) });
  const room = mine.json().data as { id?: string } | null;
  if (room?.id) {
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/leave`, headers: auth(user) });
  }
}

/** 双人房间：aName 建房 + 选 seat1，bName 加入 + 选 seat2；双方 ready 后 start */
async function setupRoom(aName: string, bName: string, aiTakeover = false, randomSpawn = false): Promise<string> {
  await leaveAllRooms(aName);
  await leaveAllRooms(bName);
  const create = await app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: auth(aName),
    payload: {
      name: '对局测试房',
      allowSpectate: true,
      fogMode: false,
      randomSpawn,
      aiTakeover,
      mapId: 'map_duo_plain',
      timeSettings: { stepTime: 90, gameTime: 1200, additionalTime: 0 },
    },
  });
  if (create.statusCode !== 200) console.log('DBG create:', create.statusCode, JSON.stringify(create.body));
  expect(create.statusCode).toBe(200);
  const roomId = create.json().data.roomId as string;
  await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/join`, headers: auth(bName), payload: {} });
  // 先选势力再准备（准备前置：必须已选势力）
  await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth(aName), payload: { seat: 1 } });
  await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth(bName), payload: { seat: 2 } });
  await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/ready`, headers: auth(aName), payload: { ready: true } });
  await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/ready`, headers: auth(bName), payload: { ready: true } });
  return roomId;
}

async function startGame(roomId: string, hostName = 'alice'): Promise<string> {
  const res = await app.inject({ method: "POST", url: `/api/rooms/${roomId}/start`, headers: auth(hostName), payload: {} });
  expect(res.statusCode).toBe(200);
  return res.json().data.gameId as string;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'dl-game-'));
  app = await buildApp({
    dbPath: path.join(dir, 'test.db'),
    logger: false,
    skinDir: path.join(dir, 'skin'),
    authRate: { registerPerMin: 1000, loginPerMin: 1000 },
    roomOpts: { gameHardCapMs: 2000, gameOverRetainMs: 1000, sweepIntervalMs: 300 },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
  for (const name of ['alice', 'bob', 'carol', 'eve', 'frank', 'grace', 'henry', 'ivy']) await newUser(name);
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('BM4：开局与意图中继', () => {
  let roomId = '';
  let gameId = '';

  it('GAME_START 广播：结构完整（seatAssignments isAI、spawnAssignments、seed、reducerVersion）', async () => {
    roomId = await setupRoom('alice', 'bob');
    aliceC = await wsConnect(roomId, 'alice');
    bobC = await wsConnect(roomId, 'bob');
    gameId = await startGame(roomId);
    const [a, b] = await Promise.all([aliceC.waitFor('GAME_START'), bobC.waitFor('GAME_START')]);
    expect(a.gameId).toBe(gameId);
    expect(a.seed).toBeTruthy();
    expect(a.reducerVersion).toBe('dev-0.1.0');
    expect(a.map).toMatchObject({ id: 'map_duo_plain' });
    expect(a.seatAssignments).toEqual([
      { seat: 1, playerId: users.get('alice')!.id, isAI: false },
      { seat: 2, playerId: users.get('bob')!.id, isAI: false },
    ]);
    expect(a.spawnAssignments).toHaveLength(2);
    expect((a.spawnAssignments as Array<{ seat: number; spawnIndex: number }>)[0]).toMatchObject({ seat: 1, spawnIndex: expect.any(Number) });
    expect(b.gameId).toBe(gameId);
  });

  it('意图中继：ACK 回发送者 + BROADCAST 到对方（eventId 单调、不回环）', async () => {
    aliceC.send({ type: 'INTENT_SUBMIT', clientTempId: 'c1', intent: { intentType: 'SWITCH_PHASE' } });
    const ack = await aliceC.waitFor('INTENT_ACK');
    expect(ack).toMatchObject({ clientTempId: 'c1', eventId: 1 });
    const bcast = await bobC.waitFor('INTENT_BROADCAST');
    expect(bcast).toMatchObject({ eventId: 1, fromSeat: 1, intent: { intentType: 'SWITCH_PHASE' } });
    expect(bcast.from).toBe(String(users.get('alice')!.id));
    // 发送者不回环：alice 不应收到该 INTENT_BROADCAST
    await new Promise((r) => setTimeout(r, 200));
    expect(aliceC.messages.filter((m) => m.type === 'INTENT_BROADCAST')).toHaveLength(0);
    // 第二条意图 eventId 递增
    bobC.send({ type: 'INTENT_SUBMIT', clientTempId: 'c2', intent: { intentType: 'SURRENDER', seat: 2, reason: 'voluntary' } });
    const ack2 = await bobC.waitFor((m) => m.type === 'INTENT_ACK' && m.clientTempId === 'c2');
    expect(ack2.eventId).toBe(2);
  });

  it('观战发意图 → ERROR SPECTATOR_CANNOT_ACT，不中继', async () => {
    const join = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/join`,
      headers: auth('carol'),
      payload: { asSpectator: true },
    });
    expect(join.statusCode).toBe(200);
    const spec = await wsConnect(roomId, 'carol');
    spec.send({ type: 'INTENT_SUBMIT', clientTempId: 'x', intent: { intentType: 'SWITCH_PHASE' } });
    const err = await spec.waitFor((m) => m.type === 'ERROR' && String(m.code).includes('SPECTATOR'));
    expect(String(err.code)).toBe('SPECTATOR_CANNOT_ACT');
    spec.close();
  });

  it('GET /api/game/:id/events 按 eventId 分页读取', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/game/${gameId}/events?after=1&limit=10`, headers: auth('alice') });
    const body = res.json().data;
    expect(body.events.map((e: { eventId: number }) => e.eventId)).toEqual([2]);
  });
});

describe('BM5：全票共识（加速超时 300ms）', () => {
  it('VICTORY 全票确认 → CONSENSUS_CONFIRMED + GAME_OVER + match_history + 房间 GAME_OVER', async () => {
    const roomId = await setupRoom('eve', 'frank');
    const a = await wsConnect(roomId, 'eve');
    const b = await wsConnect(roomId, 'frank');
    const gameId = await startGame(roomId, 'eve');
    await Promise.all([a.waitFor('GAME_START'), b.waitFor('GAME_START')]);

    const payload = { kind: 'VICTORY', winningTeam: 1, winners: [String(users.get('eve')!.id)], losers: [String(users.get('frank')!.id)] };
    a.send({ type: 'CONSENSUS_RESULT', consensusId: '1:victory:0', result: payload });
    b.send({ type: 'CONSENSUS_RESULT', consensusId: '1:victory:0', result: payload });
    const [ca, cb] = await Promise.all([a.waitFor('CONSENSUS_CONFIRMED'), b.waitFor('CONSENSUS_CONFIRMED')]);
    expect(ca).toMatchObject({ consensusId: '1:victory:0', refId: '1*', confirmed: payload });
    const over = await a.waitFor('GAME_OVER');
    expect(over.winners).toEqual(payload.winners);
    expect(over.refId).toBe('end'); // GAME_OVER 非意图 refId（不占意图 eventId 序）
    expect(over.forces).toHaveLength(2);
    // match_history 落库
    const rows = app.db.select().from(matchHistory).where(eq(matchHistory.gameId, gameId)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].aborted).toBe(0);
    expect(JSON.parse(rows[0].winners)).toEqual(payload.winners);
    // 房间状态 → GAME_OVER（对外暴露 game_over，区别于对局中）
    const state = await app.inject({ method: 'GET', url: `/api/rooms/${roomId}`, headers: auth('eve') });
    expect(state.json().data.status).toBe('game_over');
    // 参战玩家状态回落 unready（不再显示"对局中"）
    expect(state.json().data.players.every((p: { state: string }) => p.state === 'unready')).toBe(true);
    a.close();
    b.close();
  });

  it('篡改一端 → CONSENSUS_MISMATCH fatal 中止，房间回 ROOM_OPEN 可重开', async () => {
    const roomId = await setupRoom('eve', 'frank');
    const a = await wsConnect(roomId, 'eve');
    const b = await wsConnect(roomId, 'frank');
    await startGame(roomId, 'eve');
    await Promise.all([a.waitFor('GAME_START'), b.waitFor('GAME_START')]);

    a.send({
      type: 'CONSENSUS_RESULT',
      consensusId: '1:force_clear:2',
      result: { kind: 'FORCE_CLEAR', seat: 2, reason: 'surrender' },
    });
    b.send({
      type: 'CONSENSUS_RESULT',
      consensusId: '1:force_clear:2',
      result: { kind: 'FORCE_CLEAR', seat: 2, reason: 'timeout' }, // 不一致
    });
    const err = await a.waitFor((m) => m.type === 'ERROR' && String(m.code).includes('CONSENSUS'));
    expect(String(err.code)).toBe('CONSENSUS_MISMATCH');
    expect(String(err.fatal)).toBe('true');
    // 对局中止，房间回 ROOM_OPEN，全员 unready
    const state = await app.inject({ method: 'GET', url: `/api/rooms/${roomId}`, headers: auth('eve') });
    expect(state.json().data.status).toBe('waiting');
    expect(state.json().data.players.every((p: { state: string }) => p.state !== 'in_game')).toBe(true);
    a.close();
    b.close();
  });

  it('共识超时（仅一端上报）→ CONSENSUS_TIMEOUT 中止', async () => {
    const roomId = await setupRoom('eve', 'frank');
    const a = await wsConnect(roomId, 'eve');
    const b = await wsConnect(roomId, 'frank');
    await startGame(roomId, 'eve');
    await Promise.all([a.waitFor('GAME_START'), b.waitFor('GAME_START')]);
    a.send({
      type: 'CONSENSUS_RESULT',
      consensusId: '1:force_clear:1',
      result: { kind: 'FORCE_CLEAR', seat: 1, reason: 'surrender' },
    });
    const err = await a.waitFor((m) => m.type === 'ERROR' && String(m.code).includes('CONSENSUS_TIMEOUT'), 5000);
    expect(String(err.code)).toBe('CONSENSUS_TIMEOUT');
    a.close();
    b.close();
  });
});

describe('BM6：断线治理与重连（加速 50ms/150ms）', () => {
  it('断线 >10s(50ms) → PLAYER_DISCONNECT；宽限内重连 → PLAYER_RECONNECT', async () => {
    const roomId = await setupRoom('grace', 'henry');
    const a = await wsConnect(roomId, 'grace');
    const b = await wsConnect(roomId, 'henry');
    await startGame(roomId, 'grace');
    await Promise.all([a.waitFor('GAME_START'), b.waitFor('GAME_START')]);

    b.close(); // henry 断线
    const disc = await a.waitFor('PLAYER_DISCONNECT');
    expect(disc).toMatchObject({ seat: 2 });
    expect(disc.gameId).toBeTruthy();

    // 宽限内重连 → PLAYER_RECONNECT + 断线时间线取消
    const b2 = await wsConnect(roomId, 'henry');
    const reconn = await a.waitFor('PLAYER_RECONNECT');
    expect(reconn).toMatchObject({ seat: 2 });
    // 等待超过代发时限，确认未代发投降（重连取消了时间线）
    await new Promise((r) => setTimeout(r, 300));
    expect(a.messages.filter((m) => m.type === 'INTENT_BROADCAST' && m.from === 'SERVER')).toHaveLength(0);
    b2.close();
    a.close();
  });

  it('宽限超时 → 服务器代发 SURRENDER(timeout)（from=SERVER，eventId 入流）', async () => {
    const roomId = await setupRoom('grace', 'henry');
    const a = await wsConnect(roomId, 'grace');
    const b = await wsConnect(roomId, 'henry');
    const gameId = await startGame(roomId, 'grace');
    await Promise.all([a.waitFor('GAME_START'), b.waitFor('GAME_START')]);

    b.close();
    await a.waitFor('PLAYER_DISCONNECT');
    const bcast = await a.waitFor((m) => m.type === 'INTENT_BROADCAST' && m.from === 'SERVER', 5000);
    expect(bcast).toMatchObject({
      from: 'SERVER',
      fromSeat: 2,
      intent: { intentType: 'SURRENDER', seat: 2, reason: 'timeout' },
    });
    // 已写入对局流
    const res = await app.inject({ method: 'GET', url: `/api/game/${gameId}/events?after=0&limit=100`, headers: auth('grace') });
    const events = res.json().data.events;
    expect(events.some((e: { from: string; intent: { intentType: string } }) => e.from === 'SERVER' && e.intent.intentType === 'SURRENDER')).toBe(true);
    a.close();
  });

  it('RECONNECT：版本不一致 → 关闭码 4003；版本一致 → RECONNECT_ACK 分批重放', async () => {
    const roomId = await setupRoom('grace', 'henry');
    const a = await wsConnect(roomId, 'grace');
    const b = await wsConnect(roomId, 'henry');
    const gameId = await startGame(roomId, 'grace');
    await Promise.all([a.waitFor('GAME_START'), b.waitFor('GAME_START')]);
    a.send({ type: 'INTENT_SUBMIT', clientTempId: 'm1', intent: { intentType: 'SWITCH_PHASE' } });
    await a.waitFor('INTENT_ACK');

    // 版本不一致 → 4003
    const bad = await wsConnect(roomId, 'henry', 'old-version');
    bad.send({ type: 'RECONNECT', lastEventId: 0, gameId });
    const code = await bad.waitClose();
    expect(code).toBe(4003);

    // 版本一致 → RECONNECT_ACK 重放已发生意图
    const good = await wsConnect(roomId, 'henry', 'dev-0.1.0');
    good.send({ type: 'RECONNECT', lastEventId: 0, gameId });
    const ack = await good.waitFor('RECONNECT_ACK');
    expect(ack.gameId).toBe(gameId);
    const batch = ack.batch as Array<Record<string, unknown>>;
    expect(batch.length).toBeGreaterThanOrEqual(1);
    expect(batch[0]).toMatchObject({ eventId: 1, intent: { intentType: 'SWITCH_PHASE' } });
    good.close();
    a.close();
  });

  it('TIME_SYNC 转发（回环除外）', async () => {
    const roomId = await setupRoom('grace', 'henry');
    const a = await wsConnect(roomId, 'grace');
    const b = await wsConnect(roomId, 'henry');
    const gameId = await startGame(roomId, 'grace');
    await Promise.all([a.waitFor('GAME_START'), b.waitFor('GAME_START')]);
    a.send({ type: 'TIME_SYNC', gameId, seat: 1, stepTimeRemain: 45, gameTimeRemain: 800, ts: Date.now() });
    const sync = await b.waitFor('TIME_SYNC');
    expect(sync).toMatchObject({ seat: 1, stepTimeRemain: 45, gameTimeRemain: 800 });
    // 发送者不回环
    await new Promise((r) => setTimeout(r, 150));
    expect(a.messages.filter((m) => m.type === 'TIME_SYNC')).toHaveLength(0);
    a.close();
    b.close();
  });

  it('IN_GAME 硬上限（加速 2s）→ ROOM_DISBANDED(game_timeout)', async () => {
    const roomId = await setupRoom('grace', 'henry');
    const a = await wsConnect(roomId, 'grace');
    const b = await wsConnect(roomId, 'henry');
    await startGame(roomId, 'grace');
    await Promise.all([a.waitFor('GAME_START'), b.waitFor('GAME_START')]);
    const msg = await a.waitFor('ROOM_DISBANDED', 6000);
    expect(String(msg.reason)).toBe('game_timeout');
    a.close();
    b.close();
  });

  it('GAME_OVER 保留期超时（加速 2s）→ 回落 ROOM_OPEN', async () => {
    const roomId = await setupRoom('grace', 'henry');
    const a = await wsConnect(roomId, 'grace');
    const b = await wsConnect(roomId, 'henry');
    await startGame(roomId, 'grace');
    await Promise.all([a.waitFor('GAME_START'), b.waitFor('GAME_START')]);
    const payload = { kind: 'VICTORY', winningTeam: 1, winners: [String(users.get('grace')!.id)], losers: [String(users.get('henry')!.id)] };
    a.send({ type: 'CONSENSUS_RESULT', consensusId: '1:victory:0', result: payload });
    b.send({ type: 'CONSENSUS_RESULT', consensusId: '1:victory:0', result: payload });
    await a.waitFor('GAME_OVER');
    // 等 sweep 回落（roomOpts.sweepIntervalMs=300ms + gameOverRetainMs=1000ms）
    await new Promise((r) => setTimeout(r, 2600));
    const state = await app.inject({ method: 'GET', url: `/api/rooms/${roomId}`, headers: auth('grace') });
    expect(state.json().data.status).toBe('waiting');
    a.close();
    b.close();
  });

  it('全员关闭结算页 → 房间立即回落 ROOM_OPEN（不等保留期）', async () => {
    const roomId = await setupRoom('grace', 'henry');
    const a = await wsConnect(roomId, 'grace');
    const b = await wsConnect(roomId, 'henry');
    const gameId = await startGame(roomId, 'grace');
    await Promise.all([a.waitFor('GAME_START'), b.waitFor('GAME_START')]);
    const payload = { kind: 'VICTORY', winningTeam: 1, winners: [String(users.get('grace')!.id)], losers: [String(users.get('henry')!.id)] };
    a.send({ type: 'CONSENSUS_RESULT', consensusId: '1:victory:0', result: payload });
    b.send({ type: 'CONSENSUS_RESULT', consensusId: '1:victory:0', result: payload });
    await a.waitFor('GAME_OVER');

    // 仅一方关闭结算页 → 仍为 game_over（保留期未到）
    a.send({ type: 'SETTLEMENT_DISMISSED', gameId });
    await new Promise((r) => setTimeout(r, 400));
    let state = await app.inject({ method: 'GET', url: `/api/rooms/${roomId}`, headers: auth('grace') });
    expect(state.json().data.status).toBe('game_over');

    // 另一方关闭 → 立即回落 waiting（不用等 1s 保留期）；轮询等待服务器处理
    b.send({ type: 'SETTLEMENT_DISMISSED', gameId });
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      state = await app.inject({ method: 'GET', url: `/api/rooms/${roomId}`, headers: auth('grace') });
      if (state.json().data.status === 'waiting') break;
    }
    expect(state!.json().data.status).toBe('waiting');
    a.close();
    b.close();
  });

  it('结算期玩家离开房间 → 视为已退出结算页，剩余玩家关闭后立即回落', async () => {
    const roomId = await setupRoom('grace', 'henry');
    const a = await wsConnect(roomId, 'grace');
    const b = await wsConnect(roomId, 'henry');
    const gameId = await startGame(roomId, 'grace');
    await Promise.all([a.waitFor('GAME_START'), b.waitFor('GAME_START')]);
    const payload = { kind: 'VICTORY', winningTeam: 1, winners: [String(users.get('grace')!.id)], losers: [String(users.get('henry')!.id)] };
    a.send({ type: 'CONSENSUS_RESULT', consensusId: '1:victory:0', result: payload });
    b.send({ type: 'CONSENSUS_RESULT', consensusId: '1:victory:0', result: payload });
    await a.waitFor('GAME_OVER');

    // henry 结算期离开房间（连接被服务端关闭）
    const leave = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/leave`, headers: auth('henry') });
    expect(leave.statusCode).toBe(200);
    await b.waitClose();

    // grace 关闭结算页 → 参战玩家（含已离开者）均已退出 → 立即回落（轮询等待）
    a.send({ type: 'SETTLEMENT_DISMISSED', gameId });
    let state: { json: () => { data: { status: string } } };
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      state = await app.inject({ method: 'GET', url: `/api/rooms/${roomId}`, headers: auth('grace') });
      if (state.json().data.status === 'waiting') break;
    }
    expect(state!.json().data.status).toBe('waiting');
    a.close();
  });
});

describe('BM4：AI 接管与无主势力混编开局', () => {
  it('start 前置：无需全 seat 分配（无主势力可开局，aiTakeover=false → isAI=false）', async () => {
    await leaveAllRooms('ivy');
    const create = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth('ivy'),
      payload: {
        name: '无主房',
        allowSpectate: false,
        fogMode: false,
        randomSpawn: false,
        mapId: 'map_duo_plain',
        timeSettings: { stepTime: 90, gameTime: 1200, additionalTime: 0 },
      },
    });
    expect(create.statusCode).toBe(200);
    const rId = create.json().data.roomId as string;
    await app.inject({ method: 'POST', url: `/api/rooms/${rId}/select-force`, headers: auth('ivy'), payload: { seat: 1 } });
    await app.inject({ method: 'POST', url: `/api/rooms/${rId}/ready`, headers: auth('ivy'), payload: { ready: true } });
    // ivy 只占 seat1（seat2 无主）——开始游戏应成功
    const res = await app.inject({ method: 'POST', url: `/api/rooms/${rId}/start`, headers: auth('ivy'), payload: {} });
    expect(res.statusCode).toBe(200);
  });

  it('aiTakeover=true：无玩家 seat 的 isAI=true（兵保留由前端 reducer 处理）', async () => {
    await leaveAllRooms('ivy');
    const create = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth('ivy'),
      payload: {
        name: 'AI房',
        allowSpectate: false,
        fogMode: false,
        randomSpawn: false,
        aiTakeover: true,
        mapId: 'map_duo_plain',
        timeSettings: { stepTime: 90, gameTime: 1200, additionalTime: 0 },
      },
    });
    expect(create.statusCode).toBe(200);
    const roomId = create.json().data.roomId as string;
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth('ivy'), payload: { seat: 1 } });
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/ready`, headers: auth('ivy'), payload: { ready: true } });
    const c = await wsConnect(roomId, 'ivy');
    const res = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/start`, headers: auth('ivy'), payload: {} });
    expect(res.statusCode).toBe(200);
    const gs = await c.waitFor('GAME_START');
    // ivy 选 seat1 → seat1 归 ivy；未分配的 seat2 由 AI 接管
    const assignments = gs.seatAssignments as Array<{ seat: number; playerId: number | null; isAI: boolean }>;
    expect(assignments.find((a) => a.seat === 1)).toMatchObject({ playerId: users.get('ivy')!.id, isAI: false });
    expect(assignments.find((a) => a.seat === 2)).toMatchObject({ playerId: null, isAI: true });
    c.close();
  });

  it('aiTakeover + 房主指定势力 AI 难度：GAME_START.seatAssignments 携带 computer 覆盖（未指定缺省）', async () => {
    await leaveAllRooms('ivy');
    const create = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth('ivy'),
      payload: {
        name: 'AI 难度房',
        allowSpectate: false,
        fogMode: false,
        randomSpawn: false,
        aiTakeover: true,
        mapId: 'map_duo_plain',
        timeSettings: { stepTime: 90, gameTime: 1200, additionalTime: 0 },
      },
    });
    expect(create.statusCode).toBe(200);
    const roomId = create.json().data.roomId as string;
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth('ivy'), payload: { seat: 1 } });
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/ready`, headers: auth('ivy'), payload: { ready: true } });
    // 房主为 seat2 指定难度 1（AI 专属）
    const set = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/force-ai`,
      headers: auth('ivy'),
      payload: { seat: 2, aiLevel: 1 },
    });
    expect(set.statusCode).toBe(200);
    const c = await wsConnect(roomId, 'ivy');
    const res = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/start`, headers: auth('ivy'), payload: {} });
    expect(res.statusCode).toBe(200);
    const gs = await c.waitFor('GAME_START');
    const assignments = gs.seatAssignments as Array<{
      seat: number;
      playerId: number | null;
      isAI: boolean;
      computer?: number;
    }>;
    // 指定难度的 AI 席位：isAI=true 且 computer=指定值
    expect(assignments.find((a) => a.seat === 2)).toMatchObject({ playerId: null, isAI: true, computer: 1 });
    // 有玩家的席位不携带 computer 覆盖
    const seat1 = assignments.find((a) => a.seat === 1);
    expect(seat1).toMatchObject({ playerId: users.get('ivy')!.id, isAI: false });
    expect(seat1?.computer).toBeUndefined();
    c.close();
  });

  it('AI_INTENT_SUBMIT：AI 席位意图中继（from=AI、fromSeat=aiSeat、eventId 入流、ACK 回发送者）；非 AI 席位/观战拒绝', async () => {
    await leaveAllRooms('ivy');
    await leaveAllRooms('carol');
    const create = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth('ivy'),
      payload: {
        name: 'AI 中继房',
        allowSpectate: true,
        fogMode: false,
        randomSpawn: false,
        aiTakeover: true,
        mapId: 'map_duo_plain',
        timeSettings: { stepTime: 90, gameTime: 1200, additionalTime: 0 },
      },
    });
    expect(create.statusCode).toBe(200);
    const roomId = create.json().data.roomId as string;
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth('ivy'), payload: { seat: 1 } });
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/ready`, headers: auth('ivy'), payload: { ready: true } });
    const ivyC = await wsConnect(roomId, 'ivy');
    // 观战者（接收广播；服务器中继不回环发送者）
    const join = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/join`, headers: auth('carol'), payload: { asSpectator: true } });
    expect(join.statusCode).toBe(200);
    const spec = await wsConnect(roomId, 'carol');
    const res = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/start`, headers: auth('ivy'), payload: {} });
    expect(res.statusCode).toBe(200);
    const gs = await ivyC.waitFor('GAME_START');
    expect((gs.seatAssignments as Array<{ seat: number; isAI: boolean }>).find((a) => a.seat === 2)?.isAI).toBe(true);

    // 合法：AI 席位意图中继（不校验当前回合——由各端 reducer 确定性拒绝，服务器零游戏逻辑）
    ivyC.send({ type: 'AI_INTENT_SUBMIT', clientTempId: 'ai1', aiSeat: 2, intent: { intentType: 'SWITCH_PHASE' } });
    const ack = await ivyC.waitFor('INTENT_ACK');
    expect(ack).toMatchObject({ clientTempId: 'ai1', eventId: 1 });
    const bcast = await spec.waitFor('INTENT_BROADCAST');
    expect(bcast).toMatchObject({ eventId: 1, from: 'AI', fromSeat: 2, intent: { intentType: 'SWITCH_PHASE' } });
    // 发送者不回环
    await new Promise((r) => setTimeout(r, 200));
    expect(ivyC.messages.filter((m) => m.type === 'INTENT_BROADCAST')).toHaveLength(0);

    // 非法：aiSeat 非 AI 席位 → ERROR INVALID_INTENT，不中继
    ivyC.send({ type: 'AI_INTENT_SUBMIT', clientTempId: 'bad1', aiSeat: 1, intent: { intentType: 'SWITCH_PHASE' } });
    const err = await ivyC.waitFor((m) => m.type === 'ERROR' && String(m.code) === 'INVALID_INTENT');
    expect(String(err.code)).toBe('INVALID_INTENT');

    // 非法：观战提交 AI 意图 → SPECTATOR_CANNOT_ACT
    spec.send({ type: 'AI_INTENT_SUBMIT', clientTempId: 'bad2', aiSeat: 2, intent: { intentType: 'SWITCH_PHASE' } });
    const err2 = await spec.waitFor((m) => m.type === 'ERROR' && String(m.code) === 'SPECTATOR_CANNOT_ACT');
    expect(String(err2.code)).toBe('SPECTATOR_CANNOT_ACT');

    ivyC.close();
    spec.close();
  });
});

// ---------- randomSpawn：已选势力集合内随机重排玩家分配 ----------

/** 构造最小合法 PNG（签名 + IHDR 宽高），decodePngDataUrl 只校验这两处（同 profile.test.ts） */
function fakePng(w = 192, h = 216): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0); // IHDR 长度
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(w, 8); // 绝对偏移 16 = width
  ihdr.writeUInt32BE(h, 12); // 绝对偏移 20 = height
  return Buffer.concat([sig, ihdr]);
}

const pngDataUrl = (buf: Buffer) => `data:image/png;base64,${buf.toString('base64')}`;

describe('randomSpawn：已选势力集合内随机重排玩家分配', () => {
  it('shuffleAssignments 单测：已占 seat 集合内玩家重排，未选势力不动、入参不篡改', () => {
    const input: Array<{ seat: number; playerId: number | null; isAI: boolean }> = [
      { seat: 1, playerId: 101, isAI: false },
      { seat: 3, playerId: 103, isAI: false },
      { seat: 5, playerId: 105, isAI: false },
      { seat: 2, playerId: null, isAI: true }, // 未选势力（AI 位）不参与
    ];
    const out = shuffleAssignments(input);
    expect(out.map((a) => a.seat).sort()).toEqual([1, 2, 3, 5]);
    expect(
      out
        .filter((a) => a.playerId !== null)
        .map((a) => a.playerId)
        .sort(),
    ).toEqual([101, 103, 105]);
    expect(out.find((a) => a.seat === 2)).toMatchObject({ playerId: null, isAI: true });
    // 每个已占 seat 恰好一名玩家（不重复）
    const occupied = out.filter((a) => a.playerId !== null);
    expect(new Set(occupied.map((a) => a.playerId)).size).toBe(3);
    // 入参未被修改
    expect(input[0]).toEqual({ seat: 1, playerId: 101, isAI: false });
  });

  it('randomSpawn=true：双人开局 seatAssignments 是玩家在已选势力内的合法重排', async () => {
    const roomId = await setupRoom('alice', 'bob', false, true);
    const c = await wsConnect(roomId, 'alice');
    await startGame(roomId);
    const gs = await c.waitFor('GAME_START');
    const assignments = gs.seatAssignments as Array<{ seat: number; playerId: number | null; isAI: boolean }>;
    expect(assignments).toHaveLength(2);
    expect(assignments.map((a) => a.seat).sort()).toEqual([1, 2]);
    expect(
      assignments
        .map((a) => a.playerId)
        .filter((p): p is number => p !== null)
        .sort(),
    ).toEqual([users.get('alice')!.id, users.get('bob')!.id].sort());
    expect(new Set(assignments.map((a) => a.playerId)).size).toBe(2);
    c.close();
  });

  it('randomSpawn=true + 未选势力排除：AI 接管位不参与重排', async () => {
    await leaveAllRooms('ivy');
    const create = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth('ivy'),
      payload: {
        name: '随机AI房',
        allowSpectate: false,
        fogMode: false,
        randomSpawn: true,
        aiTakeover: true,
        mapId: 'map_duo_plain',
        timeSettings: { stepTime: 90, gameTime: 1200, additionalTime: 0 },
      },
    });
    expect(create.statusCode).toBe(200);
    const roomId = create.json().data.roomId as string;
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth('ivy'), payload: { seat: 1 } });
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/ready`, headers: auth('ivy'), payload: { ready: true } });
    const c = await wsConnect(roomId, 'ivy');
    const res = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/start`, headers: auth('ivy'), payload: {} });
    expect(res.statusCode).toBe(200);
    const gs = await c.waitFor('GAME_START');
    const assignments = gs.seatAssignments as Array<{ seat: number; playerId: number | null; isAI: boolean }>;
    expect(assignments.find((a) => a.seat === 1)).toMatchObject({ playerId: users.get('ivy')!.id, isAI: false });
    expect(assignments.find((a) => a.seat === 2)).toMatchObject({ playerId: null, isAI: true });
    c.close();
  });

  it('randomSpawn=true + usePersonalSkin：皮肤旗帜跟随玩家重排后的 seat', async () => {
    await leaveAllRooms('alice');
    await leaveAllRooms('bob');
    // alice 上传个人皮肤
    const skin = await app.inject({
      method: 'POST',
      url: '/api/users/me/skin',
      headers: auth('alice'),
      payload: { solid: pngDataUrl(fakePng()), hollow: pngDataUrl(fakePng()) },
    });
    expect(skin.statusCode).toBe(200);
    // 注册会为每个账号自动生成默认皮肤；删掉 bob 的，保留「无皮肤玩家保持地图原旗帜」分支
    unlinkSync(skinFilePath(app.skinDir, users.get('bob')!.id));
    unlinkSync(skinFilePath(app.skinDir, users.get('bob')!.id, true));
    const create = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth('alice'),
      payload: {
        name: '随机皮肤房',
        allowSpectate: false,
        fogMode: false,
        randomSpawn: true,
        usePersonalSkin: true,
        mapId: 'map_duo_plain',
        timeSettings: { stepTime: 90, gameTime: 1200, additionalTime: 0 },
      },
    });
    expect(create.statusCode).toBe(200);
    const roomId = create.json().data.roomId as string;
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/join`, headers: auth('bob'), payload: {} });
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth('alice'), payload: { seat: 1 } });
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth('bob'), payload: { seat: 2 } });
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/ready`, headers: auth('alice'), payload: { ready: true } });
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/ready`, headers: auth('bob'), payload: { ready: true } });
    const c = await wsConnect(roomId, 'alice');
    await startGame(roomId);
    const gs = await c.waitFor('GAME_START');
    const assignments = gs.seatAssignments as Array<{ seat: number; playerId: number | null; isAI: boolean }>;
    const aliceSeat = assignments.find((a) => a.playerId === users.get('alice')!.id)!.seat;
    const players = (gs.map as { player_list: Array<{ seat: number; flag: number }> }).player_list;
    expect(players.find((p) => p.seat === aliceSeat)!.flag).toBe(-users.get('alice')!.id);
    // bob 无皮肤 → 其 seat 保持地图原旗帜（正数）
    const bobSeat = assignments.find((a) => a.playerId === users.get('bob')!.id)!.seat;
    expect(players.find((p) => p.seat === bobSeat)!.flag).toBeGreaterThan(0);
    c.close();
  });
});
