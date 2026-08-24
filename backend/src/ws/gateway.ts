import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { CHAT, WS_CLOSE_CODES } from '@dl/shared';
import {
  ChatSendSchema,
  ConsensusResultSchema,
  IntentSubmitSchema,
  ReconnectMsgSchema,
  SettlementDismissedSchema,
  TimeSyncMsgSchema,
} from '@dl/shared';
import type {
  ChatMsg,
  ConsensusConfirmedMsg,
  ConsensusPayload,
  GameOverMsg,
  IntentBroadcastMsg,
  PlayerDisconnectMsg,
  PlayerReconnectMsg,
  ReconnectAckMsg,
  RoomManagerEvent,
  RoomServerMsg,
  TimeSyncMsg,
} from '@dl/shared';
import type { RoomManager } from '../room/manager.js';
import type { Game, GameManager } from '../game/manager.js';
import { ConsensusManager, type ConsensusFatalCode } from '../game/consensus.js';
import { DisconnectWatch } from '../game/disconnectWatch.js';
import type { TicketService } from '../auth/ticket.js';
import { createRateLimiter } from '../utils/rateLimit.js';
import { config } from '../config.js';
import { settleMatch } from '../stats/settlement.js';

const HEARTBEAT_SWEEP_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;

interface RoomConnection {
  ws: WebSocket;
  roomId: string;
  userId: number;
  username: string;
  /** 握手 URL 上报的 reducer 版本（重连时与对局记录比对，不一致关闭码 4003） */
  reducerVersion?: string;
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
  private readonly consensus: ConsensusManager;
  private readonly disconnectWatch: DisconnectWatch;

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
    this.consensus = new ConsensusManager(
      this.games,
      {
        onConfirmed: (gameId, consensusId, payload) => this.onConsensusConfirmed(gameId, consensusId, payload),
        onFatal: (gameId, code) => this.onConsensusFatal(gameId, code),
      },
      config.consensusTimeoutMs,
    );
    this.disconnectWatch = new DisconnectWatch(
      {
        onDisconnectDetected: (gameId, seat) => this.onPlayerDisconnectDetected(gameId, seat),
        onGraceExpired: (gameId, seat) => this.onDisconnectGraceExpired(gameId, seat),
      },
      config.disconnectDetectMs,
      config.disconnectGraceMs,
    );
  }

  /** RoomManager 状态事件 → 房间频道广播（含清理离开者连接） */
  publish(event: RoomManagerEvent): void {
    this.broadcast(event.roomId, event);
    // GAME_START：把房间内当前在线的参战者标记为对局参与者在线（共识期望集合的数据源）
    if (event.type === 'GAME_START') {
      const game = this.games.get(event.gameId);
      if (game) {
        for (const conn of this.conns) {
          if (conn.roomId !== event.roomId) continue;
          const seat = this.rooms.seatOf(conn.roomId, conn.userId);
          if (seat !== -1) this.games.setConnected(game, seat, true, Date.now());
        }
      }
    }
    if (event.type === 'PLAYER_LEAVE') {
      // 结算展示期离开房间 = 已退出结算页：计入关闭账本，全员关闭后立即回落
      if (event.playerId !== undefined) {
        const gameId = this.rooms.gameIdOf(event.roomId);
        const game = gameId ? this.games.get(gameId) : undefined;
        if (game && game.status === 'finished') {
          game.dismissedPlayerIds.add(event.playerId);
          this.maybeReopenOnAllDismissed(game);
        }
      }
      const target = event.playerId;
      for (const conn of this.conns) {
        if (conn.roomId !== event.roomId) continue;
        if (conn.userId === target) {
          this.remove(conn);
          conn.ws.close(1000, 'left_room');
        }
      }
      return;
    }
    if (event.type === 'ROOM_DISBANDED') {
      for (const conn of this.conns) {
        if (conn.roomId !== event.roomId) continue;
        this.remove(conn);
        conn.ws.close(1000, 'room_disbanded');
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
    const reducerVersion = url.searchParams.get('reducerVersion') ?? undefined;

    const info = this.tickets.consume(ticket);
    const room = info ? this.rooms.get(roomId) : undefined;
    const member = room?.players.get(info?.userId ?? -1);
    if (!info) return this.reject(request, socket, head, WS_CLOSE_CODES.TICKET_INVALID, 'ticket 无效');
    if (!room) return this.reject(request, socket, head, WS_CLOSE_CODES.ROOM_NOT_FOUND, '房间不存在');
    if (!member) return this.reject(request, socket, head, WS_CLOSE_CODES.SEAT_INVALID, '不在该房间中，请先加入');

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.onConnection(ws, roomId, info.userId, info.username, reducerVersion);
    });
  }

  /** 完成握手后立即以关闭码拒绝，客户端可读到具体 code */
  private reject(request: IncomingMessage, socket: Duplex, head: Buffer, code: number, reason: string): void {
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      ws.close(code, reason);
    });
  }

  private onConnection(ws: WebSocket, roomId: string, userId: number, username: string, reducerVersion?: string): void {
    // 同用户同房间旧连接顶替
    for (const conn of this.conns) {
      if (conn.roomId === roomId && conn.userId === userId) {
        this.remove(conn);
        conn.ws.close(WS_CLOSE_CODES.DUPLICATE_CONNECTION, '已被新连接顶替');
      }
    }

    const conn: RoomConnection = { ws, roomId, userId, username, reducerVersion, lastSeen: Date.now(), alive: true };
    this.conns.add(conn);
    this.log.info({ roomId, userId }, 'ws connected');
    // CONNECT_ACK：对局进行中带 gameId/lastEventId（前端据此决定重连重放）
    const gameId = this.rooms.gameIdOf(roomId);
    const game = gameId ? this.games.get(gameId) : undefined;
    this.send(conn, {
      type: 'CONNECT_ACK',
      roomId,
      ...(game && game.status === 'in_game' ? { gameId: game.id, lastEventId: game.eventIdCounter } : {}),
    });
    this.rooms.setOnline(userId, roomId, true);
    // 对局进行中：参战者连接即视为重连成功（取消断线时间线、恢复在线状态）
    const seat = this.rooms.seatOf(roomId, userId);
    if (game && seat !== -1) {
      if (game.status === 'in_game') {
        this.games.setConnected(game, seat, true, Date.now());
        this.disconnectWatch.reconnect(game.id, seat);
      }
      this.broadcast(roomId, { type: 'PLAYER_RECONNECT', gameId: game.id, seat } satisfies PlayerReconnectMsg, userId);
    }

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
      // 对局进行中的参战玩家完全离线 → 启动断线时间线（t=10s 检测 / t=120s 代发投降）
      const gameId = this.rooms.gameIdOf(roomId);
      const game = gameId ? this.games.get(gameId) : undefined;
      const seat = this.rooms.seatOf(roomId, userId);
      if (!stillOnline && game && game.status === 'in_game' && seat !== -1) {
        this.games.setConnected(game, seat, false, Date.now());
        this.disconnectWatch.disconnect(game.id, seat);
      }
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
    if (msg?.type === 'CONSENSUS_RESULT') {
      this.onConsensusResult(conn, parsed);
      return;
    }
    if (msg?.type === 'RECONNECT') {
      this.onReconnect(conn, parsed);
      return;
    }
    if (msg?.type === 'TIME_SYNC') {
      this.onTimeSync(conn, parsed);
      return;
    }
    if (msg?.type === 'SETTLEMENT_DISMISSED') {
      this.onSettlementDismissed(conn, parsed);
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

  /** 共识结果上报（P2）：结构校验 → 观战忽略 → 收集器判定（全票确认/分歧/超时） */
  private onConsensusResult(conn: RoomConnection, parsed: unknown): void {
    const result = ConsensusResultSchema.safeParse(parsed);
    if (!result.success) {
      this.send(conn, { type: 'ERROR', code: 'INVALID_PARAMS', message: '共识上报结构非法', fatal: false });
      return;
    }
    const gameId = this.rooms.gameIdOf(conn.roomId);
    const game = gameId ? this.games.get(gameId) : undefined;
    if (!game || game.status !== 'in_game') {
      // 对局未进行/已结束的迟到上报：丢弃 + 日志（边界表）
      this.log.warn({ roomId: conn.roomId, userId: conn.userId }, 'CONSENSUS_RESULT 对局未在进行，丢弃');
      return;
    }
    const seat = this.rooms.seatOf(conn.roomId, conn.userId);
    if (seat === -1) {
      this.log.warn({ roomId: conn.roomId, userId: conn.userId }, '观战发送共识上报，忽略');
      return;
    }
    this.consensus.submit(game, seat, result.data.consensusId, result.data.result);
  }

  /** 断线重连握手（§3.7）：版本比对 → 分批重放 → 追平继续 */
  private onReconnect(conn: RoomConnection, parsed: unknown): void {
    const msg = ReconnectMsgSchema.safeParse(parsed);
    if (!msg.success) {
      this.send(conn, { type: 'ERROR', code: 'INVALID_PARAMS', message: '重连消息结构非法', fatal: false });
      return;
    }
    const game = this.games.get(msg.data.gameId);
    if (!game) {
      this.send(conn, { type: 'ERROR', code: 'RECONNECT_FAILED', message: '对局不存在', fatal: true });
      return;
    }
    // reducerVersion 与对局记录不一致 → 4003（"版本已更新，本局无法返回"）
    if (conn.reducerVersion !== undefined && conn.reducerVersion !== game.reducerVersion) {
      conn.ws.close(WS_CLOSE_CODES.VERSION_MISMATCH, 'reducerVersion 不一致');
      return;
    }
    if (game.status === 'finished') {
      // 对局已正常结束：转发流中最后一条 GAME_OVER（终局信息）
      const over = this.readLastGameOver(game);
      if (over) this.send(conn, over);
      return;
    }
    if (game.status !== 'in_game') {
      // 中止对局：房间已回 ROOM_OPEN，推送房间状态由前端跳回房间页
      const room = this.rooms.get(game.roomId);
      if (room) this.send(conn, { type: 'ROOM_UPDATE', roomId: room.id, room: this.rooms.toRoomData(room) });
      return;
    }
    const after = Math.max(0, msg.data.lastEventId);
    const { events, nextCursor } = this.games.readEvents(game.id, after, 500);
    const ack: ReconnectAckMsg = {
      type: 'RECONNECT_ACK',
      gameId: game.id,
      lastEventId: game.eventIdCounter,
      batch: events,
      ...(nextCursor > 0 ? { nextBatchCursor: nextCursor } : {}),
    };
    this.send(conn, ack);
    this.log.info({ roomId: conn.roomId, userId: conn.userId, from: after, count: events.length }, '重连重放');
  }

  /** 从对局流日志找最后一条 GAME_OVER（服务器不跑 reducer，终局信息只能取自流） */
  private readLastGameOver(game: { id: string }): GameOverMsg | null {
    const { events } = this.games.readEvents(game.id, 0, Number.MAX_SAFE_INTEGER);
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i]?.type === 'GAME_OVER') return events[i] as unknown as GameOverMsg;
    }
    return null;
  }

  /** TIME_SYNC 转发（仅活动 seat 发，服务器不校验归属；回环除外） */
  private onTimeSync(conn: RoomConnection, parsed: unknown): void {
    const msg = TimeSyncMsgSchema.safeParse(parsed);
    if (!msg.success) return; // 结构非法：静默丢弃
    this.broadcast(conn.roomId, msg.data as TimeSyncMsg, conn.userId);
  }

  /** 结算页关闭上报：仅参战玩家计数；全员关闭后房间立即回落 ROOM_OPEN（保留期兜底） */
  private onSettlementDismissed(conn: RoomConnection, parsed: unknown): void {
    const msg = SettlementDismissedSchema.safeParse(parsed);
    if (!msg.success) return; // 结构非法：静默丢弃
    const game = this.games.get(msg.data.gameId);
    if (!game || game.status !== 'finished') return; // 仅对局正常结束后有效
    const room = this.rooms.get(game.roomId);
    if (!room || room.status !== 'GAME_OVER') return; // 已回落/中止：忽略迟到上报
    const seat = this.rooms.seatOf(game.roomId, conn.userId);
    const participant = game.participants.get(seat);
    if (!participant || participant.isAI || participant.playerId === null) return; // 观战/AI 不计
    game.dismissedPlayerIds.add(conn.userId);
    this.maybeReopenOnAllDismissed(game);
  }

  /** 全员（本局参战玩家）已关闭结算页/已离开房间 → 立即回落 ROOM_OPEN */
  private maybeReopenOnAllDismissed(game: Game): void {
    const required = [...game.participants.values()]
      .filter((p) => p.playerId !== null)
      .map((p) => p.playerId!);
    if (required.every((id) => game.dismissedPlayerIds.has(id))) {
      this.rooms.reopenRoom(game.roomId);
      this.log.info({ gameId: game.id, roomId: game.roomId }, '全员已退出结算页，房间回落 ROOM_OPEN');
    }
  }

  /** t=10s：广播 PLAYER_DISCONNECT + 共识期望剔除 + 参与者状态 */
  private onPlayerDisconnectDetected(gameId: string, seat: number): void {
    const game = this.games.get(gameId);
    if (!game || game.status !== 'in_game') return;
    const msg: PlayerDisconnectMsg = { type: 'PLAYER_DISCONNECT', gameId, seat, at: Date.now() };
    this.broadcast(game.roomId, msg);
    this.consensus.removeSeat(gameId, seat);
    this.log.info({ gameId, seat }, '玩家断线确认（>10s）');
  }

  /** t=120s：以 from:'SERVER' 注入 SURRENDER(timeout)（分配 eventId → 持久化 → 广播） */
  private onDisconnectGraceExpired(gameId: string, seat: number): void {
    const game = this.games.get(gameId);
    if (!game || game.status !== 'in_game') return;
    const eventId = this.games.allocateEventId(game);
    const broadcast: IntentBroadcastMsg = {
      type: 'INTENT_BROADCAST',
      from: 'SERVER',
      fromSeat: seat,
      intent: { intentType: 'SURRENDER', seat, reason: 'timeout' },
      eventId,
    };
    this.games.appendEvent(game, broadcast);
    this.broadcast(game.roomId, broadcast);
    this.log.info({ gameId, seat, eventId }, '断线宽限超时，服务器代发投降');
  }

  /** 全票一致：分配 eventId → 持久化 → 广播 CONSENSUS_CONFIRMED；FORCE_CLEAR 登记账本；VICTORY 追加 GAME_OVER + 结算 */
  private onConsensusConfirmed(gameId: string, consensusId: string, payload: ConsensusPayload): void {
    const game = this.games.get(gameId);
    if (!game || game.status !== 'in_game') return;
    const eventId = this.games.allocateEventId(game);
    const confirmed: ConsensusConfirmedMsg = { type: 'CONSENSUS_CONFIRMED', consensusId, confirmed: payload, eventId };
    this.games.appendEvent(game, confirmed);
    this.broadcast(game.roomId, confirmed);

    if (payload.kind === 'FORCE_CLEAR') {
      this.games.addClearedSeat(game, payload.seat);
      return;
    }
    // VICTORY：对局结束 + 结算记录 + 积分结算 + GAME_OVER（同 eventId 序）
    this.disconnectWatch.clearGame(game.id);
    this.games.markFinished(game);
    const finishedAt = Date.now();
    this.games.recordMatchHistory(game, payload.winners, payload.winningTeam, finishedAt);
    // 结算在 recordMatchHistory 之后（回填其 score_changes 行）；此时对局流已含全部 INTENT_BROADCAST，步数统计准确
    settleMatch(this.app.db, this.games, game, payload.winners);
    const overEventId = this.games.allocateEventId(game);
    const over: GameOverMsg = {
      type: 'GAME_OVER',
      gameId,
      winners: payload.winners,
      winningTeam: payload.winningTeam,
      forces: game.seatAssignments.map((sa) => ({
        seat: sa.seat,
        playerId: sa.playerId === null ? null : String(sa.playerId),
        isAI: sa.isAI,
        cleared: game.clearedSeats.has(sa.seat),
      })),
      eventId: overEventId,
    };
    this.games.appendEvent(game, over);
    this.broadcast(game.roomId, over);
    this.rooms.finishGame(game.roomId);
    this.log.info({ gameId, winners: payload.winners }, '对局结束（VICTORY 共识确认）');
  }

  /** 分歧/超时：fatal ERROR → 对局中止（不结算）→ 房间回 ROOM_OPEN 可重开 */
  private onConsensusFatal(gameId: string, code: ConsensusFatalCode): void {
    const game = this.games.get(gameId);
    if (!game || game.status !== 'in_game') return;
    this.disconnectWatch.clearGame(game.id);
    this.games.markAborted(game);
    this.broadcast(game.roomId, {
      type: 'ERROR',
      code,
      message: code === 'CONSENSUS_MISMATCH' ? '对局状态异常，本局中止不结算' : '共识未收齐，本局中止不结算',
      fatal: true,
    });
    this.rooms.abortGame(game.roomId);
    this.log.error({ gameId, code }, '共识中止（对局不结算）');
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
    this.consensus.dispose();
    this.disconnectWatch.dispose();
    for (const conn of this.conns) conn.ws.terminate();
    this.conns.clear();
    this.wss.close();
  }
}
