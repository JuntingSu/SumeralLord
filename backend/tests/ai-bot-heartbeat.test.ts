// 回归：AI 托管 bot 在玩家长时间不结束回合时必须保持在线（否则 AI 回合无人驱动）。
// 网关 60s 无上行消息判定连接超时；bot 原先从不发 PING，玩家回合超过该窗口就会被断开。
// 测试用加速心跳（timeout=1s / sweep=200ms）+ bot PING=100ms；若 bot 不发 PING，
// 会被判定超时且 restartMax=0 不重拉 → 结束回合后 AI 永不行动。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

let app: FastifyInstance;
let dir: string;
let port: number;
let token = '';
const botLog: string[] = [];

class Client {
  readonly ws: WebSocket;
  readonly messages: Array<Record<string, unknown> & { type: string }> = [];
  private waiters: Array<{ check: (m: Record<string, unknown> & { type: string }) => boolean; resolve: (m: never) => void }> = [];
  private readonly ping: NodeJS.Timeout;

  constructor(ws: WebSocket) {
    this.ws = ws;
    // 模拟真实前端 WsClient 的定期 PING，避免测试端自己被加速心跳判超时
    this.ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'PING' }));
    }, 100);
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'PONG') return;
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

  waitFor(match: string | ((m: Record<string, unknown> & { type: string }) => boolean), timeoutMs = 6000): Promise<Record<string, unknown> & { type: string }> {
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
    clearInterval(this.ping);
    this.ws.close();
  }
}

async function request(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<{ statusCode: number; json: () => { data?: unknown } }> {
  return app.inject({
    method,
    url,
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'dl-ai-bot-hb-'));
  app = await buildApp({
    dbPath: path.join(dir, 'test.db'),
    logger: false,
    skinDir: path.join(dir, 'skin'),
    authRate: { registerPerMin: 1000, loginPerMin: 1000 },
    gatewayOpts: { heartbeatSweepMs: 200, heartbeatTimeoutMs: 1000 },
    aiBotOpts: {
      bootDir: path.join(dir, 'bot_boot'),
      botPingIntervalMs: 100,
      restartBackoffMs: 50,
      // 心跳误杀后不允许重拉，确保「bot 被断开 → AI 不行动」在测试中必然暴露
      restartMax: 0,
      onOutput: (_gameId, line) => botLog.push(line),
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
  await request('POST', '/api/auth/register', { username: 'alice', password: 'secret1' });
  const login = await request('POST', '/api/auth/login', { username: 'alice', password: 'secret1' });
  token = (login.json().data as { token: string }).token;
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
}, 30000);

describe('AI 托管 bot 心跳（顺序执行）', () => {
  it(
    '玩家超过心跳窗口不结束回合，bot 仍在线并在轮到 AI 时行动',
    async () => {
      const create = await request('POST', '/api/rooms', {
        name: 'bot 心跳房',
        allowSpectate: false,
        fogMode: false,
        randomSpawn: false,
        aiTakeover: true,
        mapId: 'map_duo_plain',
        timeSettings: { stepTime: 90, gameTime: 1200, additionalTime: 0 },
      });
      expect(create.statusCode).toBe(200);
      const roomId = (create.json().data as { roomId: string }).roomId;
      await request('POST', `/api/rooms/${roomId}/select-force`, { seat: 1 });
      await request('POST', `/api/rooms/${roomId}/ready`, { ready: true });

      const ticket = (await request('GET', '/api/ws-ticket')).json().data as { ticket: string };
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket.ticket}&roomId=${roomId}&reducerVersion=dev-0.1.0`);
      const client = new Client(ws);
      await new Promise((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });

      const start = await request('POST', `/api/rooms/${roomId}/start`, {});
      expect(start.statusCode).toBe(200);
      await client.waitFor('GAME_START');
      expect(app.aiBots.size).toBe(1);

      // 玩家「回合结束得很晚」：静默超过 2 个心跳超时窗口（只发 PING，不发意图）
      await new Promise((r) => setTimeout(r, 2500));
      expect(app.aiBots.size).toBe(1);
      expect(botLog.filter((l) => l.includes('ws 关闭') || l.includes('bot 退出') || l.includes('重拉'))).toEqual([]);

      // 玩家结束回合 → 轮到 AI → bot 必须仍在线并提交意图
      client.send({ type: 'INTENT_SUBMIT', clientTempId: 'h1', intent: { intentType: 'SWITCH_PHASE' } });
      await client.waitFor((m) => m.type === 'INTENT_ACK' && m.clientTempId === 'h1');
      client.send({ type: 'INTENT_SUBMIT', clientTempId: 'h2', intent: { intentType: 'SWITCH_PHASE' } });
      await client.waitFor((m) => m.type === 'INTENT_ACK' && m.clientTempId === 'h2');

      const ai = await client.waitFor((m) => m.type === 'INTENT_BROADCAST' && m.from === 'AI', 8000);
      expect(ai).toMatchObject({ fromSeat: 2, intent: { intentType: 'SWITCH_PHASE' } });

      // 收尾：投降 + 模拟客户端共识上报，确保 bot 在 app.close 前被清理
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
      const waitStart = Date.now();
      while (app.aiBots.size > 0 && Date.now() - waitStart < 6000) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(app.aiBots.size).toBe(0);

      client.close();
    },
    30000,
  );
});
