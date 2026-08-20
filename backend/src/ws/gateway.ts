import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { CHAT, WS_CLOSE_CODES } from '@dl/shared';
import { ChatSendSchema, IntentSubmitSchema } from '@dl/shared';
import type { ChatMsg, IntentBroadcastMsg, RoomManagerEvent, RoomServerMsg } from '@dl/shared';
import type { RoomManager } from '../room/manager.js';
import type { GameManager } from '../game/manager.js';
import type { TicketService } from '../auth/ticket.js';
import { createRateLimiter } from '../utils/rateLimit.js';

const HEARTBEAT_SWEEP_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;

interface RoomConnection {
  ws: WebSocket;
  roomId: string;
  userId: number;
  username: string;
  lastSeen: number;
  alive: boolean;
}

/**
 * 房间阶段 WS 网关（BM3）：
 * - 一次性 ticket 握手 + 房间成员校验；同用户新连接顶替旧连接（4006）
 * - 心跳 PING/PONG，60s 无消息判定断线
 * - 订阅 RoomManager 状态事件并广播；CHAT 转发（长度/频率限制）
 * - 断开 → 玩家标记离线（ROOM_UPDATE 广播）
 */
export class WsGateway {
  private readonly wss: WebSocketServer;
  private readonly conns = new Set<RoomConnection>();
  private readonly chatLimiter = createRateLimiter(CHAT.RATE_PER_MIN, 60_000);
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly app: FastifyInstance,
    private readonly rooms: RoomManager,
    private readonly games: GameManager,
    private readonly tickets: TicketService,
    private readonly log: FastifyBaseLogger,
  ) {
    this.wss = new WebSocketServer({ noServer: true });
    this.app.server.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket as Duplex, head));
    this.sweeper = setInterval(() => this.sweepHeartbeat(), HEARTBEAT_SWEEP_MS);
    this.sweeper.unref();
  }

  /** RoomManager 状态事件 → 房间频道广播（含清理离开者连接） */
  publish(event: RoomManagerEvent): void {
    this.broadcast(event.roomId, event);
    if (event.type === 'PLAYER_LEAVE' || event.type === 'ROOM_DISBANDED') {
      const target = event.type === 'PLAYER_LEAVE' ? event.playerId : null;
      for (const conn of this.conns) {
        if (conn.roomId !== event.roomId) continue;
        if (event.type === 'ROOM_DISBANDED' || conn.userId === target) {
          this.remove(conn);
          conn.ws.close(1000, event.type === 'ROOM_DISBANDED' ? 'room_disbanded' : 'left_room');
        }
      }
    }
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const ticket = url.searchParams.get('ticket') ?? '';
    const roomId = url.searchParams.get('roomId') ?? '';

    const info = this.tickets.consume(ticket);
    const room = info ? this.rooms.get(roomId) : undefined;
    const member = room?.players.get(info?.userId ?? -1);
    if (!info) return this.reject(request, socket, head, WS_CLOSE_CODES.TICKET_INVALID, 'ticket 无效');
    if (!room) return this.reject(request, socket, head, WS_CLOSE_CODES.ROOM_NOT_FOUND, '房间不存在');
    if (!member) return this.reject(request, socket, head, WS_CLOSE_CODES.SEAT_INVALID, '不在该房间中，请先加入');

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.onConnection(ws, roomId, info.userId, info.username);
    });
  }

  /** 完成握手后立即以关闭码拒绝，客户端可读到具体 code */
  private reject(request: IncomingMessage, socket: Duplex, head: Buffer, code: number, reason: string): void {
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      ws.close(code, reason);
    });
  }

  private onConnection(ws: WebSocket, roomId: string, userId: number, username: string): void {
    // 同用户同房间旧连接顶替
    for (const conn of this.conns) {
      if (conn.roomId === roomId && conn.userId === userId) {
        this.remove(conn);
        conn.ws.close(WS_CLOSE_CODES.DUPLICATE_CONNECTION, '已被新连接顶替');
      }
    }

    const conn: RoomConnection = { ws, roomId, userId, username, lastSeen: Date.now(), alive: true };
    this.conns.add(conn);
    this.log.info({ roomId, userId }, 'ws connected');
    this.send(conn, { type: 'CONNECT_ACK', roomId });
    this.rooms.setOnline(userId, roomId, true);

    ws.on('message', (raw) => {
      conn.lastSeen = Date.now();
      this.onMessage(conn, raw.toString());
    });
    ws.on('close', () => {
      this.remove(conn);
      this.log.info({ roomId, userId }, 'ws closed');
      // 仍有该用户的其他连接则不算离线
      const stillOnline = [...this.conns].some((c) => c.roomId === roomId && c.userId === userId);
      if (!stillOnline) this.rooms.setOnline(userId, roomId, false);
    });
    ws.on('error', () => undefined);
  }

  private onMessage(conn: RoomConnection, raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // 非 JSON 消息直接丢弃
    }
    const msg = parsed as { type?: string };
    if (msg?.type === 'PING') {
      this.send(conn, { type: 'PONG' });
      return;
    }
    if (msg?.type === 'CHAT') {
      const chat = ChatSendSchema.safeParse(parsed);
      if (!chat.success) {
        this.send(conn, { type: 'ERROR', code: 'INVALID_PARAMS', message: '消息内容非法（1-200 字符）', fatal: false });
        return;
      }
      if (chat.data.text.length > CHAT.MAX_LENGTH) {
        this.send(conn, { type: 'ERROR', code: 'INVALID_PARAMS', message: '消息过长', fatal: false });
        return;
      }
      if (!this.chatLimiter(`${conn.roomId}:${conn.userId}`)) {
        this.send(conn, { type: 'ERROR', code: 'RATE_LIMITED', message: '发言太频繁，请稍后再试', fatal: false });
        return;
      }
      const chatMsg: ChatMsg = {
        type: 'CHAT',
        roomId: conn.roomId,
        from: conn.userId,
        username: conn.username,
        text: chat.data.text,
        ts: Date.now(),
      };
      this.broadcast(conn.roomId, chatMsg);
      return;
    }
    if (msg?.type === 'INTENT_SUBMIT') {
      this.onIntentSubmit(conn, parsed);
      return;
    }
    this.send(conn, { type: 'ERROR', code: 'INVALID_PARAMS', message: `未知消息类型: ${msg?.type ?? 'null'}`, fatal: false });
  }

  /** 意图中继（P1）：分配 eventId → 持久化 → ACK 发送者 → 广播他人（不回环） */
  private onIntentSubmit(conn: RoomConnection, parsed: unknown): void {
    const submit = IntentSubmitSchema.safeParse(parsed);
    if (!submit.success) {
      this.send(conn, { type: 'ERROR', code: 'INVALID_INTENT', message: '意图结构非法', fatal: false });
      return;
    }
    const gameId = this.rooms.gameIdOf(conn.roomId);
    const game = gameId ? this.games.get(gameId) : undefined;
    if (!game || game.status !== 'in_game') {
      // 对局未开始/已结束：丢弃 + 日志（前端 reducer 也有 NO_GAME 拒绝，双保险）
      this.log.warn({ roomId: conn.roomId, userId: conn.userId }, 'INTENT_SUBMIT 对局未在进行，丢弃');
      return;
    }
    const fromSeat = this.rooms.seatOf(conn.roomId, conn.userId);
    if (fromSeat === -1) {
      // 观战/未分配势力者发意图：告警 + 回 ERROR，不中继
      this.log.warn({ roomId: conn.roomId, userId: conn.userId }, '观战/无席位玩家尝试发意图');
      this.send(conn, { type: 'ERROR', code: 'SPECTATOR_CANNOT_ACT', message: '观战中，无法影响对局', fatal: false });
      return;
    }
    const eventId = this.games.allocateEventId(game);
    const broadcast: IntentBroadcastMsg = {
      type: 'INTENT_BROADCAST',
      from: String(conn.userId),
      fromSeat,
      intent: submit.data.intent,
      eventId,
    };
    this.games.appendEvent(game, broadcast);
    this.send(conn, { type: 'INTENT_ACK', clientTempId: submit.data.clientTempId, eventId });
    this.broadcast(conn.roomId, broadcast, conn.userId);
  }

  private broadcast(roomId: string, msg: RoomServerMsg | RoomManagerEvent, excludeUserId?: number): void {
    const data = JSON.stringify(msg);
    for (const conn of this.conns) {
      if (conn.roomId === roomId && conn.ws.readyState === conn.ws.OPEN && conn.userId !== excludeUserId) {
        conn.ws.send(data);
      }
    }
  }

  private send(conn: RoomConnection, msg: RoomServerMsg): void {
    if (conn.ws.readyState === conn.ws.OPEN) conn.ws.send(JSON.stringify(msg));
  }

  private remove(conn: RoomConnection): void {
    this.conns.delete(conn);
  }

  private sweepHeartbeat(): void {
    const now = Date.now();
    for (const conn of this.conns) {
      if (now - conn.lastSeen > HEARTBEAT_TIMEOUT_MS) {
        this.log.info({ roomId: conn.roomId, userId: conn.userId }, 'ws heartbeat timeout');
        conn.ws.terminate(); // 触发 close 流程（离线标记在 close 回调统一处理）
      }
    }
  }

  close(): void {
    clearInterval(this.sweeper);
    for (const conn of this.conns) conn.ws.terminate();
    this.conns.clear();
    this.wss.close();
  }
}
