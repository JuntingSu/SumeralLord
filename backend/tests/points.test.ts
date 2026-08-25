// 积分系统集成测试：注册 100 分 → VICTORY 结算 → 步数>25 对局数 → 离线按败方 → 中止/平局不结算 → 历史/排行榜
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { ScoreChangeEntry } from '@dl/shared';
import { matchHistory, users as usersTable } from '../src/db/schema.js';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db/client.js';

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

function auth(name: string): { authorization: string } {
  return { authorization: `Bearer ${users.get(name)!.token}` };
}

async function newUser(name: string): Promise<void> {
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: name, password: 'secret1' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: name, password: 'secret1' } });
  const data = login.json().data;
  users.set(name, { token: data.token, id: data.user.id });
}

/** 本人最新统计（score/matches/wins） */
async function me(name: string): Promise<{ score: number; matches: number; wins: number }> {
  const res = await app.inject({ method: 'GET', url: '/api/users/me', headers: auth(name) });
  expect(res.statusCode).toBe(200);
  const user = res.json().data.user as { score: number; matches: number; wins: number };
  return { score: user.score, matches: user.matches, wins: user.wins };
}

class Client {
  readonly ws: WebSocket;
  readonly messages: Array<Record<string, unknown> & { type: string }> = [];
  private waiters: Array<{ check: (m: Record<string, unknown> & { type: string }) => boolean; resolve: (m: never) => void }> = [];

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

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  close(): void {
    this.ws.close();
  }
}

async function wsConnect(roomId: string, user: string): Promise<Client> {
  const res = await app.inject({ method: 'GET', url: '/api/ws-ticket', headers: auth(user) });
  const ticket = res.json().data.ticket as string;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}&roomId=${roomId}&reducerVersion=test-ver`);
  const client = new Client(ws);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return client;
}

async function leaveAllRooms(user: string): Promise<void> {
  const mine = await app.inject({ method: 'GET', url: '/api/rooms/mine', headers: auth(user) });
  const room = mine.json().data as { id?: string } | null;
  if (room?.id) {
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/leave`, headers: auth(user) });
  }
}

/** 双人房间（seat1/seat2 各一真人）：aName 建房 + 选 seat1，bName 加入 + 选 seat2；双方 ready */
async function setupRoom(aName: string, bName: string): Promise<string> {
  await leaveAllRooms(aName);
  await leaveAllRooms(bName);
  const create = await app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: auth(aName),
    payload: {
      name: '积分测试房',
      allowSpectate: true,
      fogMode: false,
      randomSpawn: false,
      aiTakeover: false,
      mapId: 'map_duo_plain',
      timeSettings: { stepTime: 90, gameTime: 1200, additionalTime: 0 },
    },
  });
  expect(create.statusCode).toBe(200);
  const roomId = create.json().data.roomId as string;
  await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/join`, headers: auth(bName), payload: {} });
  await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth(aName), payload: { seat: 1 } });
  await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth(bName), payload: { seat: 2 } });
  await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/ready`, headers: auth(aName), payload: { ready: true } });
  await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/ready`, headers: auth(bName), payload: { ready: true } });
  return roomId;
}

async function startGame(roomId: string, hostName: string): Promise<string> {
  const res = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/start`, headers: auth(hostName), payload: {} });
  expect(res.statusCode).toBe(200);
  return res.json().data.gameId as string;
}

/** 双端上报同一 VICTORY 并等待 GAME_OVER */
async function reportVictory(a: Client, b: Client, winners: string[]): Promise<void> {
  const payload = { kind: 'VICTORY', winningTeam: 1, winners, losers: [] };
  a.send({ type: 'CONSENSUS_RESULT', consensusId: '1:victory:0', result: payload });
  b.send({ type: 'CONSENSUS_RESULT', consensusId: '1:victory:0', result: payload });
  await Promise.all([a.waitFor('CONSENSUS_CONFIRMED'), b.waitFor('CONSENSUS_CONFIRMED')]);
  await a.waitFor('GAME_OVER');
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'dl-points-'));
  app = await buildApp({
    dbPath: path.join(dir, 'test.db'),
    logger: false,
    authRate: { registerPerMin: 1000, loginPerMin: 1000 },
    roomOpts: { gameHardCapMs: 2000, gameOverRetainMs: 1000, sweepIntervalMs: 300 },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
  for (const name of ['alice', 'bob', 'carol', 'eve', 'frank', 'grace', 'henry', 'zeta', 'ivan', 'judy']) await newUser(name);
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('注册即 100 分', () => {
  it('新用户 GET /api/users/me → score=100, matches=0, wins=0；登录响应亦含 score', async () => {
    const s = await me('zeta');
    expect(s).toEqual({ score: 100, matches: 0, wins: 0 });
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'zeta', password: 'secret1' },
    });
    expect(login.json().data.user.score).toBe(100);
  });
});

describe('不计入对局数（0 步）则不结算积分', () => {
  it('eve 胜 / frank 败但 0 步 → 双方积分不变（100）、matches 不变、score_changes=[]、无胜场', async () => {
    const roomId = await setupRoom('eve', 'frank');
    const a = await wsConnect(roomId, 'eve');
    const b = await wsConnect(roomId, 'frank');
    const gameId = await startGame(roomId, 'eve');
    await Promise.all([a.waitFor('GAME_START'), b.waitFor('GAME_START')]);

    await reportVictory(a, b, [String(users.get('eve')!.id)]);
    a.close();
    b.close();

    const [eve, frank] = await Promise.all([me('eve'), me('frank')]);
    expect(eve).toEqual({ score: 100, matches: 0, wins: 0 }); // 0 步 < 25：不计入对局数 → 不结算积分
    expect(frank).toEqual({ score: 100, matches: 0, wins: 0 });

    const rows = app.db.select().from(matchHistory).where(eq(matchHistory.gameId, gameId)).all();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].scoreChanges)).toEqual([]);
  });
});

describe('步数 > 25 → 计入对局数并结算积分（观战者不计）', () => {
  it('先发 26 条 SWITCH_PHASE 意图再 VICTORY → 双方 matches+1、胜方积分 110/败方 90、胜方 wins+1，观战者 carol 不变', async () => {
    const roomId = await setupRoom('alice', 'bob');
    // carol 以观战身份加入（不参与对局与结算）
    const join = await app.inject({
      method: 'POST',
      url: `/api/rooms/${roomId}/join`,
      headers: auth('carol'),
      payload: { asSpectator: true },
    });
    expect(join.statusCode).toBe(200);
    const a = await wsConnect(roomId, 'alice');
    const b = await wsConnect(roomId, 'bob');
    await startGame(roomId, 'alice');
    await Promise.all([a.waitFor('GAME_START'), b.waitFor('GAME_START')]);

    for (let i = 1; i <= 26; i++) {
      a.send({ type: 'INTENT_SUBMIT', clientTempId: `s${i}`, intent: { intentType: 'SWITCH_PHASE' } });
      await a.waitFor((m) => m.type === 'INTENT_ACK' && m.clientTempId === `s${i}`);
    }
    await reportVictory(a, b, [String(users.get('alice')!.id)]);
    a.close();
    b.close();

    const [alice, bob, carol] = await Promise.all([me('alice'), me('bob'), me('carol')]);
    expect(alice).toEqual({ score: 110, matches: 1, wins: 1 }); // 计入对局数 → 结算积分 + 胜场
    expect(bob).toEqual({ score: 90, matches: 1, wins: 0 });
    expect(carol).toEqual({ score: 100, matches: 0, wins: 0 }); // 观战者不计
  });
});

describe('步数恰好 25 → 不计入对局数也不结算积分（阈值 > 25）', () => {
  it('先发 25 条 SWITCH_PHASE 意图再 VICTORY → 双方 score/matches/wins 均保持初始值，score_changes=[]', async () => {
    const roomId = await setupRoom('ivan', 'judy');
    const a = await wsConnect(roomId, 'ivan');
    const b = await wsConnect(roomId, 'judy');
    const gameId = await startGame(roomId, 'ivan');
    await Promise.all([a.waitFor('GAME_START'), b.waitFor('GAME_START')]);

    for (let i = 1; i <= 25; i++) {
      a.send({ type: 'INTENT_SUBMIT', clientTempId: `s${i}`, intent: { intentType: 'SWITCH_PHASE' } });
      await a.waitFor((m) => m.type === 'INTENT_ACK' && m.clientTempId === `s${i}`);
    }
    await reportVictory(a, b, [String(users.get('ivan')!.id)]);
    a.close();
    b.close();

    const [ivan, judy] = await Promise.all([me('ivan'), me('judy')]);
    expect(ivan).toEqual({ score: 100, matches: 0, wins: 0 }); // 25 步恰未过阈值：不结算
    expect(judy).toEqual({ score: 100, matches: 0, wins: 0 });

    const rows = app.db.select().from(matchHistory).where(eq(matchHistory.gameId, gameId)).all();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].scoreChanges)).toEqual([]);
  });
});

describe('中途离线按败者结算（计入对局数的对局）', () => {
  it('先凑 26 步使对局计入 → bob 断线（50ms 检测）后 alice 单端上报 VICTORY 且 winners 含 bob → bob offline:true/result:lose', async () => {
    const roomId = await setupRoom('grace', 'henry');
    const a = await wsConnect(roomId, 'grace');
    const b = await wsConnect(roomId, 'henry');
    await startGame(roomId, 'grace');
    await Promise.all([a.waitFor('GAME_START'), b.waitFor('GAME_START')]);

    // 先发 26 条 SWITCH_PHASE 凑足步数（>25 计入对局数），再断线验证离线按败方结算
    for (let i = 1; i <= 26; i++) {
      a.send({ type: 'INTENT_SUBMIT', clientTempId: `s${i}`, intent: { intentType: 'SWITCH_PHASE' } });
      await a.waitFor((m) => m.type === 'INTENT_ACK' && m.clientTempId === `s${i}`);
    }

    b.close(); // henry 断线
    await a.waitFor('PLAYER_DISCONNECT');
    // 断线后期望集合剔除 henry，grace 单独可确认；winners 仍含双方 → henry 按败方结算
    const payload = {
      kind: 'VICTORY',
      winningTeam: 1,
      winners: [String(users.get('grace')!.id), String(users.get('henry')!.id)],
      losers: [],
    };
    a.send({ type: 'CONSENSUS_RESULT', consensusId: '1:victory:0', result: payload });
    await a.waitFor('GAME_OVER');
    a.close();

    const [grace, henry] = await Promise.all([me('grace'), me('henry')]);
    expect(grace.score).toBe(110); // 剩余池 10 全归 grace
    expect(henry.score).toBe(90);
    expect(grace.wins).toBe(1); // 在线获胜方胜场 +1
    expect(henry.wins).toBe(0);

    // 结算明细中 henry 为离线败者
    const rows = app.db.select().from(matchHistory).all();
    const row = rows[rows.length - 1];
    const changes = JSON.parse(row.scoreChanges) as ScoreChangeEntry[];
    const henryEntry = changes.find((c) => c.playerId === users.get('henry')!.id)!;
    expect(henryEntry).toMatchObject({ result: 'lose', offline: true, delta: -10, newScore: 90 });
  });
});

describe('中止局与平局不结算', () => {
  it('共识篡改 → fatal 中止 → 双方 score/matches 均不变，无 match_history 行', async () => {
    const before = await me('eve');
    const roomId = await setupRoom('eve', 'frank');
    const a = await wsConnect(roomId, 'eve');
    const b = await wsConnect(roomId, 'frank');
    const gameId = await startGame(roomId, 'eve');
    await Promise.all([a.waitFor('GAME_START'), b.waitFor('GAME_START')]);

    a.send({ type: 'CONSENSUS_RESULT', consensusId: '1:force_clear:2', result: { kind: 'FORCE_CLEAR', seat: 2, reason: 'surrender' } });
    b.send({ type: 'CONSENSUS_RESULT', consensusId: '1:force_clear:2', result: { kind: 'FORCE_CLEAR', seat: 2, reason: 'timeout' } });
    const err = await a.waitFor((m) => m.type === 'ERROR' && String(m.code).includes('CONSENSUS'));
    expect(String(err.code)).toBe('CONSENSUS_MISMATCH');
    a.close();
    b.close();

    const after = await me('eve');
    expect(after).toEqual(before);
    const rows = app.db.select().from(matchHistory).where(eq(matchHistory.gameId, gameId)).all();
    expect(rows).toHaveLength(0);
  });

  it('平局 winners=[] → 双方积分不变、score_changes=[]；matches 不变（0 步）', async () => {
    const before = await me('eve');
    const roomId = await setupRoom('eve', 'frank');
    const a = await wsConnect(roomId, 'eve');
    const b = await wsConnect(roomId, 'frank');
    const gameId = await startGame(roomId, 'eve');
    await Promise.all([a.waitFor('GAME_START'), b.waitFor('GAME_START')]);

    const payload = { kind: 'VICTORY', winningTeam: -1, winners: [], losers: [] };
    a.send({ type: 'CONSENSUS_RESULT', consensusId: '1:victory:0', result: payload });
    b.send({ type: 'CONSENSUS_RESULT', consensusId: '1:victory:0', result: payload });
    await a.waitFor('GAME_OVER');
    a.close();
    b.close();

    const after = await me('eve');
    expect(after).toEqual(before);
    const rows = app.db.select().from(matchHistory).where(eq(matchHistory.gameId, gameId)).all();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].scoreChanges)).toEqual([]);
  });
});

describe('历史记录含本人积分变动', () => {
  it('GET /api/users/:id/history 每行带 scoreChanges，本人 delta 正确（alice 的 26 步胜局）', async () => {
    const alice = users.get('alice')!;
    const res = await app.inject({ method: 'GET', url: `/api/users/${alice.id}/history`, headers: auth('alice') });
    expect(res.statusCode).toBe(200);
    const { history } = res.json().data;
    expect(history.length).toBeGreaterThanOrEqual(1);
    const mine = history.find((h: { gameId: string; scoreChanges: ScoreChangeEntry[] }) => h.scoreChanges.length > 0);
    expect(mine).toBeDefined();
    const myChange = mine.scoreChanges.find((c: ScoreChangeEntry) => c.playerId === alice.id);
    expect(myChange).toBeDefined();
    expect(myChange.delta).toBeGreaterThan(0); // alice 的胜局 +10
  });
});

describe('排行榜', () => {
  it('积分榜/对局数榜排序正确、me.rank 正确、非法类型 400', async () => {
    // 直接构造各用户不同分数/对局数
    app.db.update(usersTable).set({ score: 300, matches: 1 }).where(eq(usersTable.id, users.get('bob')!.id)).run();
    app.db.update(usersTable).set({ score: 200, matches: 5 }).where(eq(usersTable.id, users.get('eve')!.id)).run();
    app.db.update(usersTable).set({ score: 150, matches: 10 }).where(eq(usersTable.id, users.get('frank')!.id)).run();
    app.db.update(usersTable).set({ score: 120, matches: 8 }).where(eq(usersTable.id, users.get('carol')!.id)).run();
    app.db.update(usersTable).set({ score: 50, matches: 2 }).where(eq(usersTable.id, users.get('alice')!.id)).run();
    app.db.update(usersTable).set({ score: 100, matches: 0 }).where(eq(usersTable.id, users.get('grace')!.id)).run();
    app.db.update(usersTable).set({ score: 90, matches: 0 }).where(eq(usersTable.id, users.get('henry')!.id)).run();
    app.db.update(usersTable).set({ score: 100, matches: 0 }).where(eq(usersTable.id, users.get('zeta')!.id)).run();
    // 阈值边界测试用户（ivan/judy）复位为基准值，避免影响榜单
    app.db.update(usersTable).set({ score: 100, matches: 0 }).where(eq(usersTable.id, users.get('ivan')!.id)).run();
    app.db.update(usersTable).set({ score: 100, matches: 0 }).where(eq(usersTable.id, users.get('judy')!.id)).run();

    // 积分榜：bob(300) > eve(200) > frank(150) > carol(120) > grace/zeta/ivan/judy(100,id 升序) > henry(90) > alice(50)
    const scoreRes = await app.inject({ method: 'GET', url: '/api/leaderboard/score', headers: auth('eve') });
    expect(scoreRes.statusCode).toBe(200);
    const scoreBoard = scoreRes.json().data;
    expect(scoreBoard.list.map((e: { username: string }) => e.username)).toEqual([
      'bob', 'eve', 'frank', 'carol', 'grace', 'zeta', 'ivan', 'judy', 'henry', 'alice',
    ]);
    expect(scoreBoard.list[0]).toMatchObject({ username: 'bob', rank: 1, score: 300 });
    expect(scoreBoard.list[1]).toMatchObject({ username: 'eve', rank: 2, score: 200 });
    expect(scoreBoard.me).toMatchObject({ username: 'eve', rank: 2, score: 200, matches: 5 });
    expect(scoreBoard.list.length).toBeLessThanOrEqual(100);

    // 对局数榜：frank(10) > carol(8) > eve(5) > alice(2) > bob(1)，余者 0 局按 id 升序
    const matchRes = await app.inject({ method: 'GET', url: '/api/leaderboard/matches', headers: auth('eve') });
    expect(matchRes.statusCode).toBe(200);
    const matchBoard = matchRes.json().data;
    expect(matchBoard.list.map((e: { username: string }) => e.username)).toEqual([
      'frank', 'carol', 'eve', 'alice', 'bob', 'grace', 'henry', 'zeta', 'ivan', 'judy',
    ]);
    expect(matchBoard.me).toMatchObject({ username: 'eve', rank: 3, matches: 5 });

    const bad = await app.inject({ method: 'GET', url: '/api/leaderboard/nope', headers: auth('eve') });
    expect(bad.statusCode).toBe(400);
  });
});

describe('结算结果接口（用户名 + 全员积分变动）', () => {
  it('0 步对局：返回双方用户名，scoreChanges=[]（不计入不结算）', async () => {
    const roomId = await setupRoom('eve', 'frank');
    const a = await wsConnect(roomId, 'eve');
    const b = await wsConnect(roomId, 'frank');
    const gameId = await startGame(roomId, 'eve');
    await Promise.all([a.waitFor('GAME_START'), b.waitFor('GAME_START')]);

    await reportVictory(a, b, [String(users.get('eve')!.id)]);
    a.close();
    b.close();

    const res = await app.inject({ method: 'GET', url: `/api/game/${gameId}/result`, headers: auth('eve') });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      winners: string[];
      aborted: boolean;
      scoreChanges: ScoreChangeEntry[];
      participants: Array<{ seat: number; playerId: number | null; isAI: boolean; username: string | null }>;
    };
    expect(data.winners).toEqual([String(users.get('eve')!.id)]);
    expect(data.aborted).toBe(false);
    expect(data.scoreChanges).toEqual([]);
    const bySeat = new Map(data.participants.map((p) => [p.seat, p]));
    expect(bySeat.get(1)!.username).toBe('eve');
    expect(bySeat.get(2)!.username).toBe('frank');
  });

  it('26 步对局：返回双方用户名 + 积分变动（胜方正、败方负）', async () => {
    const roomId = await setupRoom('ivan', 'judy');
    const a = await wsConnect(roomId, 'ivan');
    const b = await wsConnect(roomId, 'judy');
    const gameId = await startGame(roomId, 'ivan');
    await Promise.all([a.waitFor('GAME_START'), b.waitFor('GAME_START')]);

    for (let i = 1; i <= 26; i++) {
      a.send({ type: 'INTENT_SUBMIT', clientTempId: `r${i}`, intent: { intentType: 'SWITCH_PHASE' } });
      await a.waitFor((m) => m.type === 'INTENT_ACK' && m.clientTempId === `r${i}`);
    }
    await reportVictory(a, b, [String(users.get('ivan')!.id)]);
    a.close();
    b.close();

    const res = await app.inject({ method: 'GET', url: `/api/game/${gameId}/result`, headers: auth('judy') });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as {
      winners: string[];
      scoreChanges: ScoreChangeEntry[];
      participants: Array<{ seat: number; playerId: number | null; isAI: boolean; username: string | null }>;
    };
    expect(data.winners).toEqual([String(users.get('ivan')!.id)]);
    const ivan = data.scoreChanges.find((c) => c.playerId === users.get('ivan')!.id)!;
    const judy = data.scoreChanges.find((c) => c.playerId === users.get('judy')!.id)!;
    expect(ivan.delta).toBeGreaterThan(0); // 胜方 +（含保底 ≥5）
    expect(judy.delta).toBeLessThan(0); // 败方 -
    const bySeat = new Map(data.participants.map((p) => [p.seat, p]));
    expect(bySeat.get(1)!.username).toBe('ivan');
    expect(bySeat.get(2)!.username).toBe('judy');
  });
});

describe('存量库守卫迁移', () => {
  it('旧版 users/match_history 表 → openDb 补列：旧账号 score=100、旧记录 score_changes=[]', () => {
    const dbPath = path.join(dir, 'legacy.db');
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        default_flag INTEGER NOT NULL DEFAULT 1,
        matches INTEGER NOT NULL DEFAULT 0,
        wins INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE match_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id TEXT NOT NULL UNIQUE,
        room_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        winners TEXT NOT NULL,
        winning_team INTEGER NOT NULL DEFAULT -1,
        participants TEXT NOT NULL,
        aborted INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO users (username, password_hash) VALUES ('olduser', 'hash');
      INSERT INTO match_history (game_id, room_id, started_at, finished_at, winners, winning_team, participants)
        VALUES ('gOld1', 'rOld1', 1, 2, '[]', -1, '[]');
    `);
    legacy.close();

    const { db, sqlite } = openDb(dbPath);
    const cols = sqlite.pragma('table_info(users)') as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'score')).toBe(true);
    const mhCols = sqlite.pragma('table_info(match_history)') as Array<{ name: string }>;
    expect(mhCols.some((c) => c.name === 'score_changes')).toBe(true);

    const oldUser = db.select().from(usersTable).where(eq(usersTable.username, 'olduser')).get()!;
    expect(oldUser.score).toBe(100);
    const oldRow = db.select().from(matchHistory).where(eq(matchHistory.gameId, 'gOld1')).get()!;
    expect(oldRow.scoreChanges).toBe('[]');
    sqlite.close();
  });
});
