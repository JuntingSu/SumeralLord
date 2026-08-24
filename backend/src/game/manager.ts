import { randomUUID, randomBytes, randomInt } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TERRAIN } from '@dl/shared';
import { matchHistory } from '../db/schema.js';
import type { Db } from '../db/client.js';
import type {
  GameStartMsg,
  IntentBroadcastMsg,
  MapFullData,
  SeatAssignment,
  SpawnAssignment,
} from '@dl/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class GameError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'GameError';
  }
}

/** 参战者会话状态（BM5：共识期望集合与断线时间线的数据源；非游戏演算） */
export interface ParticipantState {
  playerId: number | null;
  /** AI seat（playerId=null 且 isAI）不参与共识，connected 恒 false */
  isAI: boolean;
  connected: boolean;
  /** 断线时间戳（断开时刻；重连清除） */
  disconnectedAt?: number;
}

export interface Game {
  id: string;
  roomId: string;
  reducerVersion: string;
  seed: string;
  spawnAssignments: SpawnAssignment[];
  seatAssignments: SeatAssignment[];
  /** 开局地图（重连/观战初始状态数据源，随 meta 接口下发） */
  map: MapFullData;
  timeSettings: { stepTime: number; gameTime: number; additionalTime: number };
  status: 'in_game' | 'finished' | 'aborted';
  clearedSeats: Set<number>;
  /** seat → 参战者状态（开局时从 seatAssignments 构造） */
  participants: Map<number, ParticipantState>;
  /** 已上报"关闭结算页"的参战玩家（全员上报后房间立即回落 ROOM_OPEN） */
  dismissedPlayerIds: Set<number>;
  eventIdCounter: number;
  createdAt: number;
  logFile: string;
}

export interface StartGameInput {
  roomId: string;
  map: MapFullData;
  seatAssignments: SeatAssignment[];
  aiTakeover: boolean;
  randomSpawn: boolean;
  timeSettings: { stepTime: number; gameTime: number; additionalTime: number };
  reducerVersion: string;
}

export interface StartGameResult {
  game: Game;
  startMsg: GameStartMsg;
}

/** 从 battlefield 提取某 seat 的据点地块 index（terrain=1 且 belongs=seat；原"王城"编码 2 已并入据点，见地图结构变更说明） */
export function findKingdom(map: MapFullData, seat: number): number {
  for (let i = 0; i < map.battlefield.length; i++) {
    const [terrain, belongs] = map.battlefield[i];
    if (terrain === TERRAIN.CITY && belongs === seat) return i;
  }
  return -1;
}

/** 对局生命周期与对局流持久化（v1 服务器不跑 reducer，只做元信息 + 事件日志） */
export class GameManager {
  private readonly games = new Map<string, Game>();

  constructor(
    private readonly logDir: string = path.join(__dirname, '../../data/game_logs'),
    private readonly db?: Db,
  ) {
    mkdirSync(this.logDir, { recursive: true });
  }

  create(input: StartGameInput): StartGameResult {
    const gameId = 'g' + randomUUID().replace(/-/g, '').slice(0, 8);
    const kingdoms = input.map.player_list.map((p) => ({ seat: p.seat, index: findKingdom(input.map, p.seat) }));
    const spawnAssignments: SpawnAssignment[] = input.randomSpawn
      ? this.shuffleKingdoms(kingdoms)
      : kingdoms.map((k) => ({ seat: k.seat, spawnIndex: k.index }));

    const game: Game = {
      id: gameId,
      roomId: input.roomId,
      reducerVersion: input.reducerVersion,
      seed: randomBytes(8).toString('hex'),
      spawnAssignments,
      seatAssignments: input.seatAssignments,
      map: input.map,
      timeSettings: input.timeSettings,
      status: 'in_game',
      clearedSeats: new Set(),
      participants: new Map(
        input.seatAssignments.map((a) => [a.seat, { playerId: a.playerId, isAI: a.isAI, connected: false }]),
      ),
      dismissedPlayerIds: new Set(),
      eventIdCounter: 0,
      createdAt: Date.now(),
      logFile: path.join(this.logDir, `${gameId}.jsonl`),
    };
    this.games.set(gameId, game);

    const startMsg: GameStartMsg = {
      type: 'GAME_START',
      roomId: input.roomId,
      gameId,
      map: input.map,
      seatAssignments: input.seatAssignments,
      spawnAssignments,
      seed: game.seed,
      timeSettings: input.timeSettings,
      reducerVersion: input.reducerVersion,
    };
    // BM7a：GAME_START 持久化为 JSONL 首行（回放数据源；对局结束后内存释放仍可重建）
    appendFileSync(game.logFile, JSON.stringify(startMsg) + '\n');
    return { game, startMsg };
  }

  get(gameId: string): Game | undefined {
    return this.games.get(gameId);
  }

  /** 分配下一个 eventId（gameId 内从 1 单调递增） */
  allocateEventId(game: Game): number {
    game.eventIdCounter += 1;
    return game.eventIdCounter;
  }

  /** 对局流消息持久化（广播序 = 分配序 = 写入序） */
  appendEvent(game: Game, msg: object): void {
    appendFileSync(game.logFile, JSON.stringify(msg) + '\n');
  }

  /** 按存储序（广播序 = 写入序）读对局流：
   *  意图消息按 eventId>after 过滤；非意图消息（共识/终局，携带 refId 串）始终包含
   *  （重连清共识账本用；前端补发对无 intent 的消息会跳过）。limit 分页；
   *  nextCursor = 全量最后一个意图 eventId（0 = 无更多）。 */
  readEvents(gameId: string, after: number, limit: number): { events: Array<Record<string, unknown>>; nextCursor: number } {
    const game = this.games.get(gameId);
    if (!game) return { events: [], nextCursor: 0 };
    let lines: string[] = [];
    try {
      lines = readFileSync(game.logFile, 'utf8').split('\n').filter(Boolean);
    } catch {
      return { events: [], nextCursor: 0 };
    }
    const events: Array<Record<string, unknown>> = [];
    let lastIntent = 0;
    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (typeof msg.eventId === 'number') {
          if (msg.eventId > after) {
            events.push(msg);
            lastIntent = msg.eventId;
          }
        } else if (typeof msg.refId === 'string') {
          events.push(msg);
        }
      } catch {
        // 坏行跳过
      }
    }
    const paged = events.slice(0, limit);
    const hasMore = events.length > limit;
    return { events: paged, nextCursor: hasMore ? lastIntent : 0 };
  }

  /** 读对局日志（BM7a 回放）：首行 GAME_START + 从 after 起的对局流分页（内存无关，日志文件即数据源） */
  readLog(gameId: string, after: number, limit: number): { start: GameStartMsg | null; events: Array<Record<string, unknown>>; nextCursor: number } {
    const file = path.join(this.logDir, `${gameId}.jsonl`);
    let lines: string[] = [];
    try {
      lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
    } catch {
      return { start: null, events: [], nextCursor: 0 };
    }
    // 首行 = GAME_START（BM7a 起落盘）；旧日志首行是对局流消息 → start=null（不可回放）
    let start: GameStartMsg | null = null;
    if (lines.length > 0) {
      try {
        const first = JSON.parse(lines[0]) as Record<string, unknown>;
        if (first?.type === 'GAME_START') {
          start = first as unknown as GameStartMsg;
          lines = lines.slice(1);
        }
      } catch {
        // 首行坏 → 按旧日志处理
      }
    }
    const events: Array<Record<string, unknown>> = [];
    let lastIntent = 0;
    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (typeof msg.eventId === 'number') {
          if (msg.eventId > after) {
            events.push(msg);
            lastIntent = msg.eventId;
          }
        } else if (typeof msg.refId === 'string') {
          events.push(msg);
        }
      } catch {
        // 坏行跳过
      }
    }
    const paged = events.slice(0, limit);
    const hasMore = events.length > limit;
    return { start, events: paged, nextCursor: hasMore ? lastIntent : 0 };
  }

  markFinished(game: Game): void {
    game.status = 'finished';
  }

  markAborted(game: Game): void {
    game.status = 'aborted';
  }

  /** 已确认 FORCE_CLEAR 的 seat 登记（会话账本；非游戏演算） */
  addClearedSeat(game: Game, seat: number): void {
    game.clearedSeats.add(seat);
  }

  /** 共识期望集合：在线参战 seat − 已确认清除 seat（AI seat 恒不在内） */
  expectedSeatsOf(game: Game): number[] {
    return [...game.participants.entries()]
      .filter(([seat, p]) => !p.isAI && p.connected && !game.clearedSeats.has(seat))
      .map(([seat]) => seat)
      .sort((a, b) => a - b);
  }

  /** 参战玩家断线/重连状态更新（BM6 disconnectWatch 数据源） */
  setConnected(game: Game, seat: number, connected: boolean, at?: number): void {
    const p = game.participants.get(seat);
    if (!p || p.isAI) return;
    p.connected = connected;
    if (connected) delete p.disconnectedAt;
    else p.disconnectedAt = at;
  }

  /** VICTORY 确认后写结算记录（中止的对局不写） */
  recordMatchHistory(game: Game, winners: string[], winningTeam: number, finishedAt: number): void {
    if (!this.db) return;
    const participants = JSON.stringify(
      [...game.participants.entries()].map(([seat, p]) => ({ seat, playerId: p.playerId, isAI: p.isAI })),
    );
    this.db
      .insert(matchHistory)
      .values({
        gameId: game.id,
        roomId: game.roomId,
        startedAt: game.createdAt,
        finishedAt,
        winners: JSON.stringify(winners),
        winningTeam,
        participants,
        aborted: 0,
      })
      .run();
  }

  dispose(): void {
    this.games.clear();
  }

  /** Fisher-Yates 洗牌（服务器一次性随机，结果随 GAME_START 下发，前端无需重演） */
  private shuffleKingdoms(kingdoms: Array<{ seat: number; index: number }>): SpawnAssignment[] {
    const arr = [...kingdoms];
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randomInt(0, i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr.map((k) => ({ seat: k.seat, spawnIndex: k.index }));
  }
}
