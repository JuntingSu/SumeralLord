import { randomUUID, randomBytes, randomInt } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TERRAIN } from '@dl/shared';
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

export interface Game {
  id: string;
  roomId: string;
  reducerVersion: string;
  seed: string;
  spawnAssignments: SpawnAssignment[];
  status: 'in_game' | 'finished';
  clearedSeats: Set<number>;
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

/** 从 battlefield 提取某 seat 的王城地块 index（terrain=2 且 belongs=seat） */
export function findKingdom(map: MapFullData, seat: number): number {
  for (let i = 0; i < map.battlefield.length; i++) {
    const [terrain, belongs] = map.battlefield[i];
    if (terrain === TERRAIN.KINGDOM && belongs === seat) return i;
  }
  return -1;
}

/** 对局生命周期与对局流持久化（v1 服务器不跑 reducer，只做元信息 + 事件日志） */
export class GameManager {
  private readonly games = new Map<string, Game>();

  constructor(private readonly logDir: string = path.join(__dirname, '../../data/game_logs')) {
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
      status: 'in_game',
      clearedSeats: new Set(),
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
  appendEvent(game: Game, msg: IntentBroadcastMsg | { type: string; [k: string]: unknown }): void {
    appendFileSync(game.logFile, JSON.stringify(msg) + '\n');
  }

  /** 按 eventId 顺序读对局流；after 过滤，limit 分页，返回 nextCursor（0 = 无更多） */
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
    for (const line of lines) {
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (typeof msg.eventId === 'number' && msg.eventId > after) events.push(msg);
      } catch {
        // 坏行跳过
      }
    }
    events.sort((a, b) => Number(a.eventId) - Number(b.eventId));
    const paged = events.slice(0, limit);
    const last = paged.length > 0 ? Number(paged[paged.length - 1].eventId) : 0;
    const hasMore = events.length > limit;
    return { events: paged, nextCursor: hasMore ? last : 0 };
  }

  markFinished(game: Game): void {
    game.status = 'finished';
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
