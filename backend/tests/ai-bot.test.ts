// AI 服务端托管（ai-bot 子进程）集成测试：《AI参与对局机制修改方案》§七
// 场景：alice 建房（开启 AI 接管）→ seat1 alice、seat2 AI(255 休闲)
// 1) 开局 → AiBotManager 自动 spawn 真实子进程并通过 /ws-bot 连接
// 2) alice 结束回合 → AI 回合由 bot 驱动（INTENT_BROADCAST from:'AI'），回合回到 alice
// 3) alice 投降 → VICTORY（AI 队获胜，winners 空）→ bot 进程被 kill、结算排除 AI
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { matchHistory, users } from '../src/db/schema.js';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;
let dir: string;
let port: number;
let aliceId = 0;
let aliceToken = '';
const botLog: string[] = [];

function auth(name: string): { authorization: string } {
  return { authorization: `Bearer ${name === 'alice' ? aliceToken : ''}` };
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

  waitFor(match: string | ((m: Record<string, unknown> & { type: string }) => boolean), timeoutMs = 8000): Promise<Record<string, unknown> & { type: string }> {
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

/** 轮询直到条件成立（进程清理等异步断言） */
async function until(check: () => boolean, timeoutMs = 6000, stepMs = 100): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('until() 超时');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'dl-ai-bot-'));
  app = await buildApp({
    dbPath: path.join(dir, 'test.db'),
    logger: false,
    skinDir: path.join(dir, 'skin'),
    authRate: { registerPerMin: 1000, loginPerMin: 1000 },
    aiBotOpts: {
      bootDir: path.join(dir, 'bot_boot'),
      onOutput: (_gameId, line) => botLog.push(line),
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'alice', password: 'secret1' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'secret1' } });
  const data = login.json().data;
  aliceId = data.user.id as number;
  aliceToken = data.token as string;
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

/** alice 退出其当前所在房间（清理跨测试残留，避免 ALREADY_IN_ROOM） */
async function leaveRoom(): Promise<void> {
  const mine = await app.inject({ method: 'GET', url: '/api/rooms/mine', headers: auth('alice') });
  const room = mine.json().data as { id?: string } | null;
  if (room?.id) {
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/leave`, headers: auth('alice') });
  }
}

/** 单人 + AI 接管房间：alice 建房（map_duo_plain 双势力），选 seat1，ready（不 start） */
async function setupAiRoom(): Promise<string> {
  await leaveRoom();
  const create = await app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: auth('alice'),
    payload: {
      name: 'AI 托管测试房',
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
  await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth('alice'), payload: { seat: 1 } });
  await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/ready`, headers: auth('alice'), payload: { ready: true } });
  return roomId;
}

/** 开局并返回 gameId */
async function startRoom(roomId: string): Promise<string> {
  const start = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/start`, headers: auth('alice'), payload: {} });
  expect(start.statusCode).toBe(200);
  return start.json().data.gameId as string;
}

/** 结束对局并等待 bot 被清理：alice 投降 → VICTORY（AI 队）→ GAME_OVER */
async function finishGame(client: Client): Promise<void> {
  client.send({ type: 'INTENT_SUBMIT', clientTempId: 'fin-1', intent: { intentType: 'SURRENDER', seat: 1, reason: 'voluntary' } });
  const ack = await client.waitFor((m) => m.type === 'INTENT_ACK' && m.clientTempId === 'fin-1');
  // 测试端模拟客户端 reducer 的共识上报（服务器不跑 reducer）：FORCE_CLEAR + VICTORY 全票
  client.send({
    type: 'CONSENSUS_RESULT',
    consensusId: `${ack.eventId as number}:force_clear:1`,
    result: { kind: 'FORCE_CLEAR', seat: 1, reason: 'surrender' },
  });
  client.send({
    type: 'CONSENSUS_RESULT',
    consensusId: `${ack.eventId as number}:victory:0`,
    result: { kind: 'VICTORY', winningTeam: 2, winners: [], losers: [] },
  });
  await client.waitFor('GAME_OVER', 10000);
  await until(() => app.aiBots.size === 0);
}

/** alice WS 连接（房间内） */
async function aliceConnect(roomId: string): Promise<Client> {
  const res = await app.inject({ method: 'GET', url: '/api/ws-ticket', headers: auth('alice') });
  const ticket = res.json().data.ticket as string;
  const w = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}&roomId=${roomId}&reducerVersion=dev-0.1.0`);
  const c = new Client(w);
  await new Promise((resolve, reject) => {
    w.once('open', resolve);
    w.once('error', reject);
  });
  return c;
}

describe('AI 服务端托管（ai-bot 子进程）', () => {
  it(
    '开局自动 spawn 子进程；alice 结束回合后 AI 回合由 bot 驱动并回到 alice；投降后 bot 被清理',
    async () => {
      botLog.length = 0;
      const roomId = await setupAiRoom();
      const client = await aliceConnect(roomId);
      const gameId = await startRoom(roomId);
      expect(app.aiBots.size).toBe(1);
      expect(await import('node:fs').then((fs) => fs.existsSync(path.join(dir, 'bot_boot', `${gameId}.json`)))).toBe(true);

      const startMsg = await client.waitFor('GAME_START');
      expect((startMsg.seatAssignments as Array<{ seat: number; playerId: number | null; isAI: boolean }>)).toEqual([
        { seat: 1, playerId: aliceId, isAI: false },
        { seat: 2, playerId: null, isAI: true },
      ]);

      // alice 先手（seat1 < seat2）：跳过行动 + 加点两阶段结束回合
      client.send({ type: 'INTENT_SUBMIT', clientTempId: 'a1', intent: { intentType: 'SWITCH_PHASE' } });
      await client.waitFor((m) => m.type === 'INTENT_ACK' && m.clientTempId === 'a1');
      client.send({ type: 'INTENT_SUBMIT', clientTempId: 'a2', intent: { intentType: 'SWITCH_PHASE' } });
      await client.waitFor((m) => m.type === 'INTENT_ACK' && m.clientTempId === 'a2');

      // AI 回合：bot 经服务器中继提交（from:'AI'、fromSeat=2、SWITCH_PHASE×2），回合回到 alice
      const ai1 = await client.waitFor((m) => m.type === 'INTENT_BROADCAST' && m.from === 'AI', 15000);
      expect(ai1).toMatchObject({ fromSeat: 2, intent: { intentType: 'SWITCH_PHASE' } });
      const ai2 = await client.waitFor((m) => m.type === 'INTENT_BROADCAST' && m.from === 'AI' && (m.eventId as number) > (ai1.eventId as number), 15000);
      expect(ai2).toMatchObject({ fromSeat: 2, intent: { intentType: 'SWITCH_PHASE' } });

      // 回合回到 alice：alice 的下一意图获得递增 eventId
      client.send({ type: 'INTENT_SUBMIT', clientTempId: 'a3', intent: { intentType: 'SWITCH_PHASE' } });
      const ack3 = await client.waitFor((m) => m.type === 'INTENT_ACK' && m.clientTempId === 'a3');
      expect(ack3.eventId).toBeGreaterThan(ai2.eventId as number);

      // 回归：连接成功后的超时 timer 必须清除——存活超过连接超时窗口（10s）不退出、不重拉
      await new Promise((r) => setTimeout(r, 10_500));
      expect(app.aiBots.size).toBe(1);
      expect(botLog.filter((l) => l.includes('bot 退出') || l.includes('重拉'))).toEqual([]);

      // 结束对局（投降 → AI 胜）并等待 bot 清理（避免跨测试残留）
      await finishGame(client);
      expect(await import('node:fs').then((fs) => fs.existsSync(path.join(dir, 'bot_boot', `${gameId}.json`)))).toBe(false);
      client.close();
    },
    30000,
  );

  it(
    'alice 投降 → VICTORY（AI 队，winners 空）→ bot 进程被 kill；结算排除 AI、人类记败',
    async () => {
      const roomId = await setupAiRoom();
      const client = await aliceConnect(roomId);
      const gameId = await startRoom(roomId);
      expect(app.aiBots.size).toBe(1);

      await client.waitFor('GAME_START');

      // alice 投降 → reducer 事件链含 FORCE_CLEAR(alice) + VICTORY(队伍2, winners=[] losers=[alice])
      client.send({ type: 'INTENT_SUBMIT', clientTempId: 's1', intent: { intentType: 'SURRENDER', seat: 1, reason: 'voluntary' } });
      const ack = await client.waitFor((m) => m.type === 'INTENT_ACK' && m.clientTempId === 's1');
      // 测试端模拟客户端 reducer 的共识上报（服务器不跑 reducer）：FORCE_CLEAR + VICTORY 全票
      client.send({
        type: 'CONSENSUS_RESULT',
        consensusId: `${ack.eventId as number}:force_clear:1`,
        result: { kind: 'FORCE_CLEAR', seat: 1, reason: 'surrender' },
      });
      client.send({
        type: 'CONSENSUS_RESULT',
        consensusId: `${ack.eventId as number}:victory:0`,
        result: { kind: 'VICTORY', winningTeam: 2, winners: [], losers: [String(aliceId)] },
      });
    const over = await client.waitFor('GAME_OVER', 10000);
    expect(over).toMatchObject({ winningTeam: 2, winners: [] });

      // bot 进程被 kill（VICTORY 确认路径）
      await until(() => app.aiBots.size === 0);
      // boot 文件清理
      expect(await import('node:fs').then((fs) => fs.existsSync(path.join(dir, 'bot_boot', `${gameId}.json`)))).toBe(false);

      // 结算：match_history 记录（winners 空、winningTeam=2、score_changes 空数组——步数 ≤25 不计入对局数，既有口径）
      const rows = app.db.select().from(matchHistory).where(eq(matchHistory.gameId, gameId)).all();
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].winners)).toEqual([]);
      expect(rows[0].winningTeam).toBe(2);
      expect(JSON.parse(rows[0].scoreChanges as string)).toEqual([]);
      const aliceRow = app.db.select().from(users).where(eq(users.id, aliceId)).get();
      expect(aliceRow).not.toBeNull();
      expect(aliceRow!.wins).toBe(0);
      expect(aliceRow!.matches).toBe(0); // 步数 ≤25 不计入对局数（D7 亦遵守该口径）
      client.close();
    },
    30000,
  );
});
