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

/** WS 测试客户端：收集消息 + 条件等待 */
class Client {
  readonly ws: WebSocket;
  readonly messages: Array<Record<string, unknown> & { type: string }> = [];
  private waiters: Array<{ check: (m: Record<string, unknown> & { type: string }) => boolean; resolve: (m: never) => void }> = [];
  private closeWaiters: Array<(code: number) => void> = [];
  private closedCode: number | null = null;

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
    ws.on('close', (code) => {
      this.closedCode = code;
      for (const w of this.closeWaiters.splice(0)) w(code);
    });
    ws.on('error', () => undefined);
  }

  waitFor(match: string | ((m: Record<string, unknown> & { type: string }) => boolean), timeoutMs = 4000): Promise<Record<string, unknown> & { type: string }> {
    const check =
      typeof match === 'string' ? (m: Record<string, unknown> & { type: string }) => m.type === match : match;
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
    });  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  close(): void {
    this.ws.close();
  }
}

async function wsConnect(roomId: string, user: string, ticketOverride?: string): Promise<Client> {
  let ticket = ticketOverride;
  if (!ticket) {
    const res = await app.inject({ method: 'GET', url: '/api/ws-ticket', headers: auth(user) });
    ticket = res.json().data.ticket as string;
  }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}&roomId=${roomId}`);
  const client = new Client(ws); // 先挂监听再等 open，避免早到的服务器消息丢失
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return client;
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'dl-ws-'));
  app = await buildApp({
    dbPath: path.join(dir, 'test.db'),
    logger: false,
    skinDir: path.join(dir, 'skin'),
    authRate: { registerPerMin: 1000, loginPerMin: 1000 },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
  for (const name of ['alice', 'bob', 'carol']) await newUser(name);
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('WS 网关（顺序执行）', () => {
  let roomId = '';

  it('无效 ticket → 关闭码 4001', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=bad-ticket&roomId=x`);
    const code = await new Promise<number>((resolve, reject) => {
      ws.once('close', (c) => resolve(c));
      ws.once('error', reject);
    });
    expect(code).toBe(4001);
  });

  it('成员连接 → CONNECT_ACK，且他人收到 ROOM_UPDATE（上线）', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth('alice'),
      payload: { name: 'ws房间', allowSpectate: true, fogMode: false, randomSpawn: false, mapId: 'map_duo_plain', timeSettings: { stepTime: 90, gameTime: 1200, additionalTime: 0 } },
    });
    roomId = create.json().data.roomId;

    const alice = await wsConnect(roomId, 'alice');
    const ack = await alice.waitFor('CONNECT_ACK');
    expect(ack.roomId).toBe(roomId);
    aliceC = alice;

    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/join`, headers: auth('bob'), payload: { asSpectator: false } });
    await alice.waitFor('PLAYER_JOIN');
    const joinMsg = alice.messages.find((m) => m.type === 'PLAYER_JOIN')!;
    expect((joinMsg.player as { username: string }).username).toBe('bob');
    expect((joinMsg.player as { online: boolean }).online).toBe(false);
  });

  it('PING → PONG', async () => {
    const alice = aliceC;
    alice.send({ type: 'PING' });
    await alice.waitFor('PONG');
  });

  it('bob 连接 → alice 收到 ROOM_UPDATE（bob online）', async () => {
    const bob = await wsConnect(roomId, 'bob');
    bobC = bob;
    const update = await aliceC.waitFor(
      (m) =>
        m.type === 'ROOM_UPDATE' &&
        (m.room as { players: Array<{ username: string; online: boolean }> }).players.some(
          (p) => p.username === 'bob' && p.online,
        ),
    );
    const room = update.room as { players: Array<{ username: string; online: boolean }> };
    expect(room.players.find((p) => p.username === 'bob')?.online).toBe(true);
  });

  it('选势力：先到先得 + 换选清空旧 seat', async () => {
    const alice = aliceC;
    const bob = bobC;

    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth('bob'), payload: { seat: 1 } });
    await alice.waitFor('FORCE_SELECT');
    expect(alice.messages.at(-1)).toMatchObject({ type: 'FORCE_SELECT', seat: 1, playerId: users.get('bob')!.id });

    const conflict = await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth('alice'), payload: { seat: 1 } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('FORCE_TAKEN');

    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/select-force`, headers: auth('bob'), payload: { seat: 2 } });
    await new Promise((r) => setTimeout(r, 300)); // 等换选产生的两条 FORCE_SELECT 事件到齐
    const selects = alice.messages.filter((m) => m.type === 'FORCE_SELECT');
    expect(selects).toEqual([
      { type: 'FORCE_SELECT', roomId, seat: 1, playerId: users.get('bob')!.id },
      { type: 'FORCE_SELECT', roomId, seat: 1, playerId: null },
      { type: 'FORCE_SELECT', roomId, seat: 2, playerId: users.get('bob')!.id },
    ]);
  });

  it('准备状态 → PLAYER_READY 广播（已选势力）', async () => {
    const alice = aliceC;
    const bob = bobC;
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/ready`, headers: auth('bob'), payload: { ready: true } });
    const [a, b] = await Promise.all([alice.waitFor('PLAYER_READY'), bob.waitFor('PLAYER_READY')]);
    expect(a).toMatchObject({ playerId: users.get('bob')!.id, ready: true });
    expect(b).toMatchObject({ playerId: users.get('bob')!.id, ready: true });
  });

  it('聊天广播 + 超长拒绝', async () => {
    const alice = aliceC;
    const bob = bobC;

    alice.send({ type: 'CHAT', text: '大家好' });
    const [a, b] = await Promise.all([alice.waitFor('CHAT'), bob.waitFor('CHAT')]);
    expect(a).toMatchObject({ username: 'alice', text: '大家好' });
    expect(b).toMatchObject({ username: 'alice', text: '大家好' });

    bob.send({ type: 'CHAT', text: 'x'.repeat(201) });
    await bob.waitFor((m) => m.type === 'ERROR' && String(m.message).includes('长'));
    expect(bob.messages.some((m) => m.type === 'CHAT' && String(m.text ?? '').length > 200)).toBe(false);
  });

  it('未知消息类型 → ERROR', async () => {
    const bob = bobC;
    bob.send({ type: 'WHATEVER' });
    const err = await bob.waitFor((m) => m.type === 'ERROR' && String(m.message).includes('WHATEVER'));
    expect(String(err.message)).toContain('WHATEVER');
  });

  it('重复连接 → 旧连接以 4006 关闭', async () => {
    const bobOld = bobC;
    const bobNew = await wsConnect(roomId, 'bob');
    const code = await bobOld.waitClose();
    expect(code).toBe(4006);
    bobC = bobNew;
  });

  it('非成员连接 → 关闭码 4007', async () => {
    const code = await wsConnect(roomId, 'carol').then((c) => c.waitClose());
    expect(code).toBe(4007);
  });

  it('踢人 → 双方收到 PLAYER_LEAVE 与势力释放，被踢者连接被关闭', async () => {
    const bob = bobC;
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/kick`, headers: auth('alice'), payload: { playerId: users.get('bob')!.id } });
    const [leave] = await Promise.all([aliceC.waitFor('PLAYER_LEAVE'), bob.waitFor('PLAYER_LEAVE')]);
    expect(leave).toMatchObject({ playerId: users.get('bob')!.id });
    // 被踢者占用的 seat 2 被释放并广播
    const release = await aliceC.waitFor(
      (m) => m.type === 'FORCE_SELECT' && Number(m.seat) === 2 && m.playerId === null,
    );
    expect(release).toBeTruthy();
    await bob.waitClose();
    const state = await app.inject({ method: 'GET', url: `/api/rooms/${roomId}`, headers: auth('alice') });
    expect(
      (state.json().data.forces as Array<{ playerId: number | null }>).every((f) => f.playerId === null),
    ).toBe(true);
  });

  it('解散 → ROOM_DISBANDED 广播且连接关闭', async () => {
    const alice = aliceC;
    await app.inject({ method: 'POST', url: `/api/rooms/${roomId}/disband`, headers: auth('alice') });
    const msg = await alice.waitFor('ROOM_DISBANDED');
    expect(String(msg.reason)).toBe('host_disband');
    await alice.waitClose();
  });
});

/**
 * 随机出生（randomSpawn）只重排 GAME_START 的 seatAssignments，房间阶段的玩家-势力选择保持不变。
 * 对局内的席位解析（意图/共识/断线/重连）必须以本局最终 seatAssignments 为准，否则会把玩家
 * 的意图标成其房间阶段选择的 seat，导致对端 reducer 判 NOT_YOUR_TURN、回合与计时不跟随。
 */
describe('对局内席位按最终 seatAssignments 解析（顺序执行）', () => {
  it('随机出生换位后，意图中继与重连广播使用玩家最终 seat', async () => {
    const aliceId = users.get('alice')!.id;
    const bobId = users.get('bob')!.id;

    const create = await app.inject({
      method: 'POST',
      url: '/api/rooms',
      headers: auth('alice'),
      payload: {
        name: '随机席位房',
        allowSpectate: false,
        fogMode: false,
        randomSpawn: false,
        mapId: 'map_duo_plain',
        timeSettings: { stepTime: 90, gameTime: 1200, additionalTime: 0 },
      },
    });
    expect(create.statusCode).toBe(200);
    const rid = create.json().data.roomId as string;
    await app.inject({ method: 'POST', url: `/api/rooms/${rid}/join`, headers: auth('bob'), payload: {} });
    // 房间阶段：alice 选 seat1、bob 选 seat2
    await app.inject({ method: 'POST', url: `/api/rooms/${rid}/select-force`, headers: auth('alice'), payload: { seat: 1 } });
    await app.inject({ method: 'POST', url: `/api/rooms/${rid}/select-force`, headers: auth('bob'), payload: { seat: 2 } });
    await app.inject({ method: 'POST', url: `/api/rooms/${rid}/ready`, headers: auth('alice'), payload: { ready: true } });
    await app.inject({ method: 'POST', url: `/api/rooms/${rid}/ready`, headers: auth('bob'), payload: { ready: true } });

    const alice = await wsConnect(rid, 'alice');
    const bob = await wsConnect(rid, 'bob');
    const start = await app.inject({ method: 'POST', url: `/api/rooms/${rid}/start`, headers: auth('alice'), payload: {} });
    expect(start.statusCode).toBe(200);
    const gs = await alice.waitFor('GAME_START');
    await bob.waitFor('GAME_START');
    const game = app.games.get(gs.gameId as string)!;

    // 模拟随机出生换位后的最终分配：alice（房间 seat1）落到对局 seat2，bob（房间 seat2）落到 seat1
    for (const a of game.seatAssignments) {
      if (a.playerId === aliceId) a.playerId = bobId;
      else if (a.playerId === bobId) a.playerId = aliceId;
    }
    expect(app.games.seatOfUser(game, aliceId)).toBe(2);
    expect(app.games.seatOfUser(game, bobId)).toBe(1);

    // alice 在对局中已成为 seat2：对端收到的 fromSeat 必须是 2（而不是房间阶段的 1）
    alice.send({ type: 'INTENT_SUBMIT', clientTempId: 'c-spawn-1', intent: { intentType: 'SWITCH_PHASE' } });
    const cast = await bob.waitFor('INTENT_BROADCAST');
    expect(cast.fromSeat).toBe(2);

    // 重连广播同样按最终 seat
    alice.close();
    await alice.waitClose();
    const alice2 = await wsConnect(rid, 'alice');
    const reconnect = await bob.waitFor('PLAYER_RECONNECT');
    expect(reconnect.seat).toBe(2);

    alice2.close();
    bob.close();
    await app.inject({ method: 'POST', url: `/api/rooms/${rid}/disband`, headers: auth('alice') });
  });
});
