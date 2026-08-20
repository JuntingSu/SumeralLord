// 全票共识收集器（后端方案 §4.1 / P2）。
// 服务器不演算游戏逻辑：只做结构比对（JSON 全等）与期望集合管理；
// 全票一致 → onConfirmed；不一致/5s 超时（剔除断线成员后仍不齐）→ onFatal 中止不结算。
import { GAME } from '@dl/shared';
import type { ConsensusPayload } from '@dl/shared';
import type { Game, GameManager } from './manager.js';

export type ConsensusFatalCode = 'CONSENSUS_MISMATCH' | 'CONSENSUS_TIMEOUT';

export interface ConsensusHooks {
  /** 全票一致：调用方负责分配 eventId、持久化、广播 CONSENSUS_CONFIRMED（VICTORY 时追加 GAME_OVER 与结算） */
  onConfirmed(gameId: string, consensusId: string, payload: ConsensusPayload): void;
  /** 分歧/超时：调用方广播 ERROR(fatal)、对局标记 aborted、房间回 ROOM_OPEN 重开 */
  onFatal(gameId: string, code: ConsensusFatalCode): void;
}

interface ConsensusTracker {
  consensusId: string;
  gameId: string;
  /** 创建时快照 = 在线参战 seat − clearedSeats；断线成员被剔除 */
  expectedSeats: Set<number>;
  /** 按 seat 去重，取首条 */
  received: Map<number, ConsensusPayload>;
  timeoutTimer: NodeJS.Timeout;
  status: 'collecting' | 'confirmed' | 'mismatch' | 'timeout';
}

export class ConsensusManager {
  private readonly trackers = new Map<string, ConsensusTracker>();

  constructor(
    private readonly games: GameManager,
    private readonly hooks: ConsensusHooks,
    private readonly timeoutMs: number = GAME.CONSENSUS_TIMEOUT_MS,
  ) {}

  /** 处理一条 CONSENSUS_RESULT（gateway 已过滤观战与格式校验） */
  submit(game: Game, seat: number, consensusId: string, payload: ConsensusPayload): void {
    if (game.status !== 'in_game') return; // 对局已结束/中止的迟到上报：丢弃（边界表）
    let tracker = this.trackers.get(consensusId);
    if (!tracker) {
      tracker = {
        consensusId,
        gameId: game.id,
        expectedSeats: new Set(this.games.expectedSeatsOf(game)),
        received: new Map(),
        timeoutTimer: setTimeout(() => this.onTimeout(game, consensusId), this.timeoutMs),
        status: 'collecting',
      };
      tracker.timeoutTimer.unref();
      this.trackers.set(consensusId, tracker);
    }
    if (tracker.status !== 'collecting') return; // 已确认/已中止的 tracker：忽略
    if (tracker.received.has(seat)) return; // 同 seat 多次上报：取首条
    tracker.received.set(seat, payload);
    this.recheck(game, tracker);
  }

  /** 参战玩家断线（>10s）：从所有收集中的 tracker 剔除该 seat 并复检（可能就此凑齐） */
  removeSeat(gameId: string, seat: number): void {
    for (const tracker of this.trackers.values()) {
      if (tracker.gameId !== gameId || tracker.status !== 'collecting') continue;
      if (!tracker.expectedSeats.delete(seat)) continue;
      const game = this.games.get(gameId);
      if (game) this.recheck(game, tracker);
    }
  }

  dispose(): void {
    for (const tracker of this.trackers.values()) clearTimeout(tracker.timeoutTimer);
    this.trackers.clear();
  }

  private recheck(game: Game, tracker: ConsensusTracker): void {
    const allReceived = [...tracker.expectedSeats].every((s) => tracker.received.has(s));
    if (!allReceived) return;
    const serialized = new Set<string>();
    for (const payload of tracker.received.values()) serialized.add(JSON.stringify(payload));
    if (serialized.size === 1) {
      tracker.status = 'confirmed';
      clearTimeout(tracker.timeoutTimer);
      this.trackers.delete(tracker.consensusId);
      const first = tracker.received.values().next().value as ConsensusPayload;
      this.hooks.onConfirmed(game.id, tracker.consensusId, first);
    } else {
      this.fatal(game, tracker, 'CONSENSUS_MISMATCH');
    }
  }

  private onTimeout(game: Game, consensusId: string): void {
    const tracker = this.trackers.get(consensusId);
    if (!tracker || tracker.status !== 'collecting') return;
    this.fatal(game, tracker, 'CONSENSUS_TIMEOUT');
  }

  private fatal(game: Game, tracker: ConsensusTracker, code: ConsensusFatalCode): void {
    tracker.status = code === 'CONSENSUS_MISMATCH' ? 'mismatch' : 'timeout';
    clearTimeout(tracker.timeoutTimer);
    // 对局中止：清理该 gameId 的全部 tracker（迟到上报由 game.status 检查兜底）
    for (const [id, t] of this.trackers) {
      if (t.gameId === game.id) {
        clearTimeout(t.timeoutTimer);
        this.trackers.delete(id);
      }
    }
    this.hooks.onFatal(game.id, code);
  }
}
