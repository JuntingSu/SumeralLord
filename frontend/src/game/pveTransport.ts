// PVE 本地传输层：扮演“服务器”分配 eventId、广播意图、驱动 AI、回显共识、合成 GAME_OVER。
// 不经过 WebSocket；游戏状态以完整 GameState 初始化（新局或读档），支持悔棋回滚到指定 eventId。
import { applyIntent, normalizeAiLevel, planAiTurn } from '@dl/shared';
import type {
  ConsensusPayload,
  GameOverMsg,
  GameState,
  PveGameConfig,
  PlayerIntent,
  RoomServerMsg,
} from '@dl/shared';
import type { GameTransport } from '../stores/game';
import type { WsStatus } from '../ws/client';

export interface PveTransportOptions {
  config: PveGameConfig;
  initialState: GameState;
  /** 普通 AI 的 MCTS 规划（由页面注入 Worker 客户端）；缺失时尝试懒加载 */
  onPlanMcts?: (state: GameState, seat: number) => Promise<PlayerIntent[]>;
  /** 懒加载普通 AI（触发器可能中途把某势力改为难度 2） */
  ensurePlanner?: () => Promise<((state: GameState, seat: number) => Promise<PlayerIntent[]>) | null>;
  /** 普通 AI 不可用，已降级为简单 AI */
  onAiFallback?: (seat: number, reason: string) => void;
  onThinking?: (thinking: boolean) => void;
  /** AI 出招间隔（给动画留时间） */
  stepDelayMs?: number;
}

/** 休闲语义：连续切换阶段至回合结束 */
function skipIntents(board: GameState, seat: number): PlayerIntent[] {
  if (board.currentSeat === seat && board.phase === 'ACTION') {
    return [{ intentType: 'SWITCH_PHASE' }, { intentType: 'SWITCH_PHASE' }];
  }
  return [{ intentType: 'SWITCH_PHASE' }];
}

export class PveTransport implements GameTransport {
  private readonly config: PveGameConfig;
  private readonly messageHandlers = new Set<(msg: RoomServerMsg) => void>();
  private readonly statusHandlers = new Set<(status: WsStatus) => void>();
  private readonly stepDelayMs: number;
  private board: GameState;
  private eventId = 0;
  private connected = false;
  private closed = false;
  private planQueue: PlayerIntent[] = [];
  private planSeat = -1;
  private aiTimer: ReturnType<typeof setTimeout> | null = null;
  private thinking = false;
  private planGeneration = 0;
  private gameOverEmitted = false;
  private skipOnce = false;
  private planner: ((state: GameState, seat: number) => Promise<PlayerIntent[]>) | null = null;
  private plannerUnavailable = false;

  constructor(private readonly opts: PveTransportOptions) {
    this.config = opts.config;
    this.board = structuredClone(opts.initialState);
    this.stepDelayMs = opts.stepDelayMs ?? 120;
  }

  onMessage(handler: (msg: RoomServerMsg) => void): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onStatus(handler: (status: WsStatus) => void): () => void {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  }

  async connect(): Promise<void> {
    if (this.closed) return;
    this.emitStatus('connecting');
    this.emitStatus('open');
    this.connected = true;
    this.emit({ type: 'CONNECT_ACK', roomId: 'pve', gameId: this.config.gameId });
    this.drive();
  }

  close(): void {
    this.closed = true;
    this.connected = false;
    this.clearAiTimer();
    this.planQueue = [];
    this.thinking = false;
    this.planGeneration += 1;
    this.emitStatus('closed');
  }

  /** 玩家意图：分配 eventId → ACK（本端应用）→ 驱动 AI */
  submitIntent(clientTempId: string, intent: PlayerIntent): void {
    if (this.closed) return;
    const eventId = ++this.eventId;
    const seat = this.board.controlledSeat ?? this.config.playerSeat;
    const beforeControlled = this.board.controlledSeat;
    const result = applyIntent(this.board, {
      actor: { kind: 'PLAYER', seat },
      intent,
    });
    if (result.ok) {
      this.board = result.state;
      this.syncControl(beforeControlled);
    }
    this.emit({ type: 'INTENT_ACK', clientTempId, eventId });
    this.scheduleDrive();
  }

  /** 共识回显：本地没有其他端，直接确认；VICTORY 追加 GAME_OVER */
  submitConsensus(consensusId: string, result: ConsensusPayload): void {
    if (this.closed) return;
    const trigger = Number(consensusId.split(':')[0]);
    const refId = `${Number.isFinite(trigger) ? trigger : 0}*`;
    setTimeout(() => {
      if (this.closed) return;
      this.emit({ type: 'CONSENSUS_CONFIRMED', consensusId, confirmed: result, refId });
      if (result.kind === 'VICTORY') this.emitGameOver(result);
    }, 0);
  }

  sendTimeSync(): void {
    // PVE 无计时
  }

  sendChat(): boolean {
    return false;
  }

  sendReconnect(): void {
    // 本地对局无重连
  }

  sendSettlementDismissed(): void {
    // 无服务器结算
  }

  async fetchEvents(): Promise<{ events: Array<Record<string, unknown>>; nextCursor: number }> {
    return { events: [], nextCursor: 0 };
  }

  /** 悔棋：把影子状态回滚到指定 eventId，清掉在途 AI 计划；不广播 */
  rewindTo(state: GameState, eventId: number): void {
    this.clearAiTimer();
    this.planQueue = [];
    this.planSeat = -1;
    this.thinking = false;
    this.planGeneration += 1;
    this.opts.onThinking?.(false);
    this.board = structuredClone(state);
    this.eventId = eventId;
    this.gameOverEmitted = state.finished;
    this.skipOnce = false;
  }

  /** 存档快照（完整 GameState + 展示元信息） */
  snapshot(): {
    state: GameState;
    meta: { turn: number; phase: GameState['phase']; currentSeat: number; currentForceName: string };
  } {
    const current = this.board.forces.find((f) => f.seat === this.board.currentSeat);
    return {
      state: structuredClone(this.board),
      meta: {
        turn: this.board.turn,
        phase: this.board.phase,
        currentSeat: this.board.currentSeat,
        currentForceName: current?.name ?? '',
      },
    };
  }

  // ---------- AI 驱动 ----------

  private scheduleDrive(): void {
    setTimeout(() => this.drive(), 0);
  }

  private drive(): void {
    if (this.closed || !this.connected || this.thinking || this.aiTimer !== null || this.planQueue.length > 0) {
      return;
    }
    if (this.board.finished) {
      this.emitGameOverFromState();
      return;
    }
    const seat = this.board.currentSeat;
    const force = this.board.forces.find((f) => f.seat === seat);
    if (!force || !force.exists || !force.alive || !force.isAI) return;
    if (this.board.controlledSeat === seat) return;
    if (this.board.phase !== 'ACTION' && this.board.phase !== 'ADD_POINT') return;

    // 上一条 AI 意图被 reducer 拒绝：本回合降级为跳过，避免同一非法计划循环
    if (this.skipOnce) {
      this.skipOnce = false;
      this.planSeat = seat;
      this.planQueue = skipIntents(this.board, seat);
      this.pump();
      return;
    }

    const level = normalizeAiLevel(force.computer ?? 1);
    if (level === 2 && !this.plannerUnavailable) {
      const generation = ++this.planGeneration;
      this.thinking = true;
      this.opts.onThinking?.(true);
      const pending = this.opts.onPlanMcts
        ? this.opts.onPlanMcts(this.board, seat)
        : this.ensurePlannerAndPlan(seat);
      pending
        .then((intents) => {
          if (this.closed || generation !== this.planGeneration) return;
          this.thinking = false;
          this.opts.onThinking?.(false);
          this.planSeat = seat;
          this.planQueue = intents.length > 0 ? intents : skipIntents(this.board, seat);
          this.pump();
        })
        .catch((err: unknown) => {
          if (this.closed || generation !== this.planGeneration) return;
          this.thinking = false;
          this.opts.onThinking?.(false);
          this.plannerUnavailable = true;
          this.opts.onAiFallback?.(seat, err instanceof Error ? err.message : '普通 AI 不可用');
          const plan = planAiTurn(this.board, seat, true);
          const intents = plan.kind === 'intents' ? plan.intents : skipIntents(this.board, seat);
          this.planSeat = seat;
          this.planQueue = intents;
          this.pump();
        });
      return;
    }

    const plan = planAiTurn(this.board, seat, this.plannerUnavailable && level === 2);
    const intents = plan.kind === 'intents' ? plan.intents : skipIntents(this.board, seat);
    if (intents.length === 0) {
      // 加点阶段点数耗尽：AI 驱动代其发起一次 SWITCH_PHASE 结束回合；行动阶段由 AI 计划自行切换
      const force = this.board.forces.find((f) => f.seat === seat);
      if (this.board.phase === 'ADD_POINT' && force && force.points === 0) {
        this.planSeat = seat;
        this.planQueue = [{ intentType: 'SWITCH_PHASE' }];
        this.pump();
      }
      return;
    }
    this.planSeat = seat;
    this.planQueue = intents;
    this.pump();
  }

  private async ensurePlannerAndPlan(seat: number): Promise<PlayerIntent[]> {
    if (!this.planner) {
      const planner = await this.opts.ensurePlanner?.();
      if (!planner) throw new Error('普通 AI 权重不可用');
      this.planner = planner;
    }
    return this.planner(this.board, seat);
  }

  /** 控制权转移：清掉在途 AI 计划，避免继续替旧势力行动 */
  private syncControl(before: number | null): void {
    if (this.board.controlledSeat === before) return;
    this.clearAiTimer();
    this.planQueue = [];
    this.planSeat = -1;
    this.thinking = false;
    this.planGeneration += 1;
    this.opts.onThinking?.(false);
  }

  private pump(): void {
    if (this.closed) return;
    if (this.planQueue.length === 0) {
      this.planSeat = -1;
      this.drive();
      return;
    }
    // 计划跨越了回合边界（不应发生）：丢弃余下意图，交给 drive 重新判定
    if (this.board.currentSeat !== this.planSeat || (this.board.phase !== 'ACTION' && this.board.phase !== 'ADD_POINT')) {
      this.planQueue = [];
      this.planSeat = -1;
      this.drive();
      return;
    }
    const intent = this.planQueue.shift()!;
    const seat = this.planSeat;
    this.aiTimer = setTimeout(() => {
      this.aiTimer = null;
      if (this.closed) return;
      this.emitAiIntent(seat, intent);
      this.pump();
    }, this.stepDelayMs);
  }

  private emitAiIntent(seat: number, intent: PlayerIntent): void {
    const eventId = ++this.eventId;
    const beforeControlled = this.board.controlledSeat;
    const result = applyIntent(this.board, { actor: { kind: 'AI', seat }, intent });
    if (result.ok) {
      this.board = result.state;
      this.syncControl(beforeControlled);
    } else {
      // 状态分歧：本次意图仍入流（保证 eventId 连续），计划作废后降级跳过
      this.planQueue = [];
      this.skipOnce = true;
    }
    this.emit({ type: 'INTENT_BROADCAST', from: 'AI', fromSeat: seat, intent, eventId });
  }

  private clearAiTimer(): void {
    if (this.aiTimer !== null) {
      clearTimeout(this.aiTimer);
      this.aiTimer = null;
    }
  }

  private emitGameOver(payload: { winningTeam: number; winners: string[] }): void {
    if (this.gameOverEmitted) return;
    this.gameOverEmitted = true;
    const over: GameOverMsg = {
      type: 'GAME_OVER',
      gameId: this.config.gameId,
      winners: payload.winners,
      winningTeam: payload.winningTeam,
      forces: this.board.forces
        .filter((f) => f.exists)
        .map((f) => ({
          seat: f.seat,
          playerId: f.playerId === null ? null : String(f.playerId),
          isAI: f.isAI,
          cleared: !f.alive,
        })),
      refId: 'end',
    };
    this.emit(over);
  }

  private emitGameOverFromState(): void {
    this.emitGameOver({
      winningTeam: this.board.winningTeam ?? -1,
      winners: this.board.winners ?? [],
    });
  }

  private emit(msg: RoomServerMsg): void {
    for (const handler of this.messageHandlers) handler(msg);
  }

  private emitStatus(status: WsStatus): void {
    for (const handler of this.statusHandlers) handler(status);
  }
}
