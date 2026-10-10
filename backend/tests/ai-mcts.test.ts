// AI 服务端托管（ai-bot 子进程）集成测试：难度2 = 训练 MCTS AI
// 场景：alice 建房（AI 接管）→ seat1 alice、seat2 AI(难度2 普通，训练 MCTS AI)
// 1) 开局 → AiBotManager 自动 spawn 真实子进程并通过 /ws-bot 连接
// 2) alice 结束回合 → AI 回合由 bot 驱动（INTENT_BROADCAST from:'AI'，难度2 产生真实计划），回合回到 alice
// 3) alice 投降 → VICTORY → bot 进程被 kill
// 注：注入仓库内 v45 权重文件 → 断言 bot 侧「已加载训练权重」（覆盖 DL_AI_WEIGHTS/权重加载路径）
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;
let dir: string;
let port: number;
let aliceId = 0;
let aliceToken = '';
const botLog: string[] = [];

/** 仓库内 v45 权重（train/v1/runs/weights/v45.json，相对本测试文件上溯两级 = 仓库根） */
const v45Weights = fileURLToPath(new URL('../../train/v1/runs/weights/v45.json', import.meta.url));

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

async function until(check: () => boolean, timeoutMs = 6000, stepMs = 100): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('until() 超时');
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'dl-ai-mcts-'));
  app = await buildApp({
    dbPath: path.join(dir, 'test.db'),
    logger: false,
    skinDir: path.join(dir, 'skin'),
    authRate: { registerPerMin: 1000, loginPerMin: 1000 },
    aiBotOpts: {
      bootDir: path.join(dir, 'bot_boot'),
      weightsPath: v45Weights,
      onOutput: (_gameId, line) => botLog.push(line),
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { username: 'alice', password: 'secret1' } });
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'alice', password: 'secret1' } });
  aliceId = login.json().data.user.id as number;
  aliceToken = login.json().data.token as string;
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function leaveRoom(): Promise<void> {
  const mine = await app.inject({ method: 'GET', url: '/api/rooms/mine', headers: auth('alice') });
  const room = mine.json().data as { id?: string } | null;
  if (room?.id) {
    await app.inject({ method: 'POST', url: `/api/rooms/${room.id}/leave`, headers: auth('alice') });
  }
}

/** 单人 + AI 接管房间：alice 建房（map_duo_plain），选 seat1，seat2 指定 AI 难度2，ready */
async function setupAiRoom(): Promise<string> {
  await leaveRoom();
  const create = await app.inject({
    method: 'POST',
    url: '/api/rooms',
    headers: auth('alice'),
    payload: {
      name: 'AI MCTS 测试房',
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
  // seat2 指定难度2（普通）= 训练 MCTS AI
  const fa = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/force-ai`, headers: auth('alice'), payload: { seat: 2, aiLevel: 2 } });
  expect(fa.statusCode).toBe(200);
  await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/ready`, headers: auth('alice'), payload: { ready: true } });
  return roomId;
}

async function startRoom(roomId: string): Promise<string> {
  const start = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/start`, headers: auth('alice'), payload: {} });
  expect(start.statusCode).toBe(200);
  return start.json().data.gameId as string;
}

async function finishGame(client: Client): Promise<void> {
  client.send({ type: 'INTENT_SUBMIT', clientTempId: 'fin-1', intent: { intentType: 'SURRENDER', seat: 1, reason: 'voluntary' } });
  const ack = await client.waitFor((m) => m.type === 'INTENT_ACK' && m.clientTempId === 'fin-1');
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

describe('AI 服务端托管（难度2 = 训练 MCTS AI）', () => {
  it(
    '难度2 AI 回合由训练 MCTS AI 驱动（产生真实计划），回合回到 alice，投降后 bot 被清理',
    async () => {
      botLog.length = 0;
      const roomId = await setupAiRoom();
      const client = await aliceConnect(roomId);
      const gameId = await startRoom(roomId);
      expect(app.aiBots.size).toBe(1);

      const startMsg = await client.waitFor('GAME_START');
      const assignments = startMsg.seatAssignments as Array<{ seat: number; playerId: number | null; isAI: boolean; computer?: number }>;
      expect(assignments).toEqual([
        { seat: 1, playerId: aliceId, isAI: false },
        { seat: 2, playerId: null, isAI: true, computer: 2 },
      ]);

      // alice 先手：跳过行动 + 加点两阶段结束回合
      client.send({ type: 'INTENT_SUBMIT', clientTempId: 'a1', intent: { intentType: 'SWITCH_PHASE' } });
      await client.waitFor((m) => m.type === 'INTENT_ACK' && m.clientTempId === 'a1');
      client.send({ type: 'INTENT_SUBMIT', clientTempId: 'a2', intent: { intentType: 'SWITCH_PHASE' } });
      await client.waitFor((m) => m.type === 'INTENT_ACK' && m.clientTempId === 'a2');

      // AI 回合：bot 经服务器中继提交（from:'AI'、fromSeat=2）；难度2 = 训练 MCTS（注入 v45 权重）
      const ai1 = await client.waitFor((m) => m.type === 'INTENT_BROADCAST' && m.from === 'AI', 30000);
      expect(ai1.fromSeat).toBe(2);
      const aiIntentType = (ai1.intent as { intentType: string }).intentType;
      expect(['MOVE', 'ATTACK', 'SWITCH_PHASE', 'ADD_POINT']).toContain(aiIntentType);
      // 训练 AI 每回合规划一次：AI 回合应产生 ≥2 条意图（如 铺场+加点 或 切阶段+加点），而非休闲单切
      const aiMore = await client.waitFor(
        (m) => m.type === 'INTENT_BROADCAST' && m.from === 'AI' && (m.eventId as number) > (ai1.eventId as number),
        30000,
      );
      expect(aiMore.fromSeat).toBe(2);
      // v45 权重注入生效：bot 侧记录「已加载训练权重」，且无加载失败
      await until(() => botLog.some((l) => l.includes('已加载训练权重')), 6000);
      expect(botLog.filter((l) => l.includes('权重加载失败') || l.includes('权重文件格式异常'))).toEqual([]);

      // 回合回到 alice：下一意图 eventId 递增
      client.send({ type: 'INTENT_SUBMIT', clientTempId: 'a3', intent: { intentType: 'SWITCH_PHASE' } });
      const ack3 = await client.waitFor((m) => m.type === 'INTENT_ACK' && m.clientTempId === 'a3');
      expect(ack3.eventId).toBeGreaterThan(aiMore.eventId as number);

      await finishGame(client);
      client.close();
    },
    120_000,
  );
});
