// Mock 对局中继（前端规划 §5.2 层 2）：遵守 P1/P2 规则的"假服务器"。
// 与真实后端同构：eventId 分配、INTENT_ACK 回发送者、INTENT_BROADCAST 广播其他端、
// CONSENSUS_RESULT 延迟回 CONSENSUS_CONFIRMED、脚本对手注入（走同一 submitIntent 路径）。
// 额外支持跳号模拟（dropEventId 丢弃广播，验证 EVENT_GAP 补发）。
import type { MapFullData, PlayerIntent, RoomServerMsg, SeatAssignment, SpawnAssignment } from '@dl/shared';
import { ConsensusPayloadSchema } from '@dl/shared';
import type { GameTransport } from '../stores/game';

export type WsStatus = 'connecting' | 'open' | 'closed';

export interface MockGameOptions {
  map?: MapFullData;
  seatAssignments?: SeatAssignment[];
  timeSettings?: { stepTime: number; gameTime: number; additionalTime: number };
  /** 开局后按间隔注入的脚本意图（对手回合行为） */
  script?: PlayerIntent[];
  /** 脚本注入间隔 ms */
  scriptIntervalMs?: number;
  /** 跳号模拟：丢弃该 eventId 的 INTENT_BROADCAST（ACK 照发），验证补发路径 */
  dropBroadcastEventId?: number;
  /** 共识确认延迟 ms（模拟其他端全票一致） */
  consensusDelayMs?: number;
}

/** 内置 3x3 双势力小地图（Mock 用例①）：与 reducer 单测同构 */
export function mockMap(): MapFullData {
  return {
    id: 'mock-map',
    version: 1,
    title: 'Mock 3x3',
    description: '',
    author: 'mock',
    timestamp: '2026-08-20 00:00:00.0',
    row: 3,
    column: 3,
    random_spawn: false,
    cylindrical_map: false,
    fog_mode: false,
    online_time_settings: { total_time: 600, round_time: 60, time_bonus: 0 },
    tags: [],
    player_num: 2,
    player_list: [
      { name: '红方', team: 1, computer: 255, seat: 1, flag: 1 },
      { name: '蓝方', team: 2, computer: 255, seat: 2, flag: 2 },
    ],
    // 3x3：index 4 = 中心平原；6/2 为双方据点
    battlefield: [
      [0, 128, 0],
      [0, 128, 0],
      [1, 2, 2],
      [0, 128, 0],
      [0, 128, 0],
      [0, 128, 0],
      [1, 1, 2],
      [0, 128, 0],
      [0, 128, 0],
    ],
  };
}

export function defaultMockSeats(): SeatAssignment[] {
  return [
    { seat: 1, playerId: 1, isAI: false },
    { seat: 2, playerId: 2, isAI: false },
  ];
}

/** Mock 对局事件日志项（与真实 JSONL 单行同构）：
 *  意图消息带 eventId（整数序）；非意图消息（共识/终局）带 refId（不占意图序） */
interface LogEntry {
  /** 意图 eventId；非意图消息为 null */
  eventId: number | null;
  /** 非意图独立序号（"{触发意图eventId}*" / "end"）；意图消息为 undefined */
  refId?: string;
  msg: RoomServerMsg;
}

export class MockWsServer implements GameTransport {
  private eventId = 0;
  private readonly log: LogEntry[] = [];
  private readonly messageHandlers = new Set<(msg: RoomServerMsg) => void>();
  private readonly statusHandlers = new Set<(status: WsStatus) => void>();
  private scriptTimer: number | null = null;
  private closed = false;
  readonly gameId = 'mock-game-1';

  constructor(private readonly opts: MockGameOptions = {}) {}

  onMessage(handler: (msg: RoomServerMsg) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatus(handler: (status: WsStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  async connect(): Promise<void> {
    this.emitStatus('connecting');
    this.emitStatus('open');
    this.emit({ type: 'CONNECT_ACK', roomId: 'mock-room' });
    this.emit(this.startMsg());
    // 脚本对手注入：走同一 submitIntent 路径，保证 eventId 序一致
    const script = this.opts.script ?? [];
    if (script.length > 0) {
      const interval = this.opts.scriptIntervalMs ?? 300;
      let i = 0;
      this.scriptTimer = window.setInterval(() => {
        if (this.closed || i >= script.length) {
          if (this.scriptTimer !== null) window.clearInterval(this.scriptTimer);
          return;
        }
        this.submitIntent(`script-${i}`, script[i], true);
        i += 1;
      }, interval);
    }
  }

  close(): void {
    this.closed = true;
    if (this.scriptTimer !== null) window.clearInterval(this.scriptTimer);
    this.emitStatus('closed');
  }

  /** 意图提交（P1）：分配 eventId → ACK 回发送者 → 广播其他端（可模拟跳号） */
  submitIntent(clientTempId: string, intent: PlayerIntent, fromScript = false): void {
    if (this.closed) return;
    const eventId = ++this.eventId;
    const ack: RoomServerMsg = { type: 'INTENT_ACK', clientTempId, eventId };
    this.log.push({ eventId, msg: ack });
    this.emit(ack);
    const broadcast: RoomServerMsg = {
      type: 'INTENT_BROADCAST',
      from: fromScript ? '2' : '1',
      fromSeat: fromScript ? 2 : 1,
      intent,
      eventId,
    };
    if (this.opts.dropBroadcastEventId === eventId) return; // 模拟服务器丢广播（ACK 已发）
    this.log.push({ eventId, msg: broadcast });
    this.emit(broadcast);
  }

  /** AI 席位意图中继（保留：本地 dev 可经脚本对手模拟 AI 回合；真实对局由服务端 ai-bot 驱动） */
  submitAiIntent(clientTempId: string, aiSeat: number, intent: PlayerIntent): void {
    if (this.closed) return;
    const eventId = ++this.eventId;
    const ack: RoomServerMsg = { type: 'INTENT_ACK', clientTempId, eventId };
    this.log.push({ eventId, msg: ack });
    this.emit(ack);
    const broadcast: RoomServerMsg = {
      type: 'INTENT_BROADCAST',
      from: 'AI',
      fromSeat: aiSeat,
      intent,
      eventId,
    };
    if (this.opts.dropBroadcastEventId === eventId) return;
    this.log.push({ eventId, msg: broadcast });
    this.emit(broadcast);
  }

  /** 共识上报（P2）：延迟回 CONSENSUS_CONFIRMED（refId = "{触发意图eventId}*"，不占意图序） */
  submitConsensus(consensusId: string, result: unknown): void {
    if (this.closed) return;
    const parsed = ConsensusPayloadSchema.safeParse(result);
    if (!parsed.success) return;
    window.setTimeout(() => {
      if (this.closed) return;
      const triggerEventId = Number(consensusId.split(':')[0]);
      const refId = `${triggerEventId}*`;
      const msg: RoomServerMsg = { type: 'CONSENSUS_CONFIRMED', consensusId, confirmed: parsed.data, refId };
      this.log.push({ eventId: null, refId, msg });
      this.emit(msg);
    }, this.opts.consensusDelayMs ?? 100);
  }

  sendTimeSync(): void {
    // Mock 端无需真正同步（单端模拟）
  }

  sendChat(text: string): boolean {
    // Mock 单端模拟：本地回显
    this.emit({ type: 'CHAT', roomId: 'mock-room', from: 0, username: '我', text, ts: Date.now() });
    return true;
  }

  sendReconnect(lastEventId: number, _gameId: string): void {
    const batch = this.log
      .filter((e) => (e.eventId !== null && e.eventId > lastEventId) || e.refId !== undefined)
      .map((e) => e.msg as unknown as Record<string, unknown>);
    this.emit({ type: 'RECONNECT_ACK', gameId: this.gameId, lastEventId: this.eventId, batch });
  }

  sendSettlementDismissed(): void {
    // Mock 单端模拟：无需服务器回落
  }

  /** 补发拉取（EVENT_GAP 同构接口；真实模式走 GET /api/game/:id/events） */
  async fetchEvents(
    _gameId: string,
    after: number,
    limit = 500,
  ): Promise<{ events: Array<Record<string, unknown>>; nextCursor: number }> {
    const pending = this.log.filter((e) => (e.eventId !== null && e.eventId > after) || e.refId !== undefined);
    const events = pending.slice(0, limit).map((e) => e.msg as unknown as Record<string, unknown>);
    let lastIntent = 0;
    for (const e of pending) if (e.eventId !== null) lastIntent = e.eventId;
    return { events, nextCursor: pending.length > limit ? lastIntent : 0 };
  }

  /** Mock 开局构造（与真实 GAME_START 同构；reducer 初始化由前端执行） */
  private startMsg(): RoomServerMsg {
    const map = this.opts.map ?? mockMap();
    const seats = this.opts.seatAssignments ?? defaultMockSeats();
    const spawnAssignments: SpawnAssignment[] = map.player_list.map((p) => {
      const idx = map.battlefield.findIndex(([terrain, belongs]) => terrain === 1 && belongs === p.seat);
      return { seat: p.seat, spawnIndex: idx >= 0 ? idx : 0 };
    });
    return {
      type: 'GAME_START',
      roomId: 'mock-room',
      gameId: this.gameId,
      map,
      seatAssignments: seats,
      spawnAssignments,
      seed: 'mock-seed',
      timeSettings: this.opts.timeSettings ?? { stepTime: 90, gameTime: 1200, additionalTime: 0 },
      reducerVersion: '0.1.0+mock',
    };
  }

  /** 供测试/演示直接驱动 reducer 的辅助：对当前 board 应用一条意图并返回结果 */
  private emit(msg: RoomServerMsg): void {
    for (const h of this.messageHandlers) h(msg);
  }

  private emitStatus(status: WsStatus): void {
    for (const h of this.statusHandlers) h(status);
  }
}
