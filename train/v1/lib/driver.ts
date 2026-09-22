// driver.ts — 自对弈对局驱动 + 样本收集（设计方案 §5 / §9 默认项 4/5/6）
// 双方 isAI=false + 虚拟 playerId（900001/900002）；逐意图 applyIntent（拒绝记录丢弃）；
// 上限 60 回合或 1000 步判平；对局日志 JSONL 与 backend/src/game/manager.ts 落盘格式对齐。
import { applyIntent, initState } from '@dl/shared';
import type { GameStartMsg, GameState, IntentBroadcastMsg, MapFullData, PlayerIntent, RoomTimeSettings } from '@dl/shared';
import { mctsDecide } from './mcts.js';
import type { MctsOptions } from './mcts.js';
import { teFeatures } from './features.js';
import { isLatePhase, type TeWeights } from './eval.js';

/** 训练对局双方虚拟 playerId（§9 默认项 4） */
export const TRAIN_PLAYER_IDS = { 1: 900001, 2: 900002 } as const;

export const TIME_SETTINGS: RoomTimeSettings = { stepTime: 30, gameTime: 600, additionalTime: 10 };

/** 对局上限（§5）：60 回合或 1000 步（双方累计意图条数），任一到达判平 */
export const MAX_TURNS = 60;
export const MAX_STEPS = 1000;

export interface TrainSample {
  gameId: string;
  mapId: string;
  /** 样本视角势力 */
  seat: number;
  /** 回合数（全局轮次） */
  turn: number;
  /** 地图面积（rows×columns；仅旧样本拟合回退用） */
  area: number;
  /** 残局标记（回合数 ≥ T 或 该回合行动阶段结束时双方有子力接触）；拟合选择中盘/残局权重，同 E_te 打分口径 */
  late: boolean;
  /** E_te 6 特征 */
  features: number[];
  /** 距终局的回合数（拟合 w=1/d²） */
  dToEnd: number;
  /** 终局标签：胜 +1 / 负 −1 / 平 0 */
  label: number;
  /** 样本学习权重（缺省 1；人工示范样本 200 倍，拟合 pairwise 权重按 weight/d² 缩放） */
  weight?: number;
}

export interface GameStats {
  gameId: string;
  mapId: string;
  reason: 'victory' | 'turn_cap' | 'step_cap';
  winningTeam: number | null;
  winnerSeats: number[];
  turns: number;
  steps: number;
  /** 被拒绝而丢弃的意图条数（空转 sanity：应≈0） */
  rejects: number;
  /** 各势力意图提交数 */
  stepsBySeat: Record<string, number>;
}

export interface GameResult {
  finalState: GameState;
  stats: GameStats;
  samples: TrainSample[];
  /** 对局日志行（GAME_START / INTENT_BROADCAST×N / GAME_OVER，与 manager.ts 落盘格式一致） */
  log: object[];
}

export interface DriveOptions extends Pick<MctsOptions, 'simulations' | 'turnPlan'> {
  weights: TeWeights;
  /** 根决策模式：sample（自对弈，缺省）/ argmax（基准与验收） */
  mode?: 'argmax' | 'sample';
  temperature?: number;
  maxTurns?: number;
  maxSteps?: number;
  seed?: string;
  /** 每回合结束回调 */
  onTurn?: (seat: number, state: GameState) => void;
}

function forceLogEntry(state: GameState, seat: number): { seat: number; playerId: string | null; isAI: boolean; cleared: boolean } {
  const f = state.forces.find((x) => x.seat === seat);
  return { seat, playerId: f ? String(f.playerId ?? '') : null, isAI: f?.isAI ?? false, cleared: !f?.alive };
}

/** 跑一局自对弈（双方同权重同引擎；根决策默认温度采样） */
export function playSelfPlayGame(map: MapFullData, opts: DriveOptions): GameResult {
  const gameId = 't' + Math.random().toString(36).slice(2, 10);
  const seatAssignments = [
    { seat: 1, playerId: TRAIN_PLAYER_IDS[1], isAI: false },
    { seat: 2, playerId: TRAIN_PLAYER_IDS[2], isAI: false },
  ];
  const seed = opts.seed ?? Math.random().toString(36).slice(2, 12);

  const log: object[] = [];
  const startMsg: GameStartMsg = {
    type: 'GAME_START',
    roomId: 'train',
    gameId,
    map,
    seatAssignments,
    spawnAssignments: map.player_list.map((p) => ({
      seat: p.seat,
      spawnIndex: map.battlefield.findIndex((bf) => bf[0] === 1 && bf[1] === p.seat),
    })),
    seed,
    timeSettings: TIME_SETTINGS,
    reducerVersion: 'train-1',
  };
  log.push(startMsg);

  let state = initState({
    map,
    seatAssignments,
    seed,
    timeSettings: TIME_SETTINGS,
  }).state;

  const samples: TrainSample[] = [];
  let steps = 0;
  let rejects = 0;
  const stepsBySeat: Record<string, number> = { '1': 0, '2': 0 };
  let eventId = 0;
  let reason: GameStats['reason'] = 'victory';
  const maxTurns = opts.maxTurns ?? MAX_TURNS;
  const maxSteps = opts.maxSteps ?? MAX_STEPS;

  while (!state.finished) {
    if (state.turn > maxTurns) {
      reason = 'turn_cap';
      break;
    }
    if (steps >= maxSteps) {
      reason = 'step_cap';
      break;
    }
    const seat = state.currentSeat;
    const turnStart = state;
    // 决策（回合级 MCTS，自对弈温度采样）
    const decision = mctsDecide(state, seat, opts.weights, {
      simulations: opts.simulations,
      mode: opts.mode ?? 'sample',
      temperature: opts.temperature ?? 1,
      turnPlan: opts.turnPlan,
    });
    // 应用计划：行动意图 + 加点意图按序提交；拒绝丢弃（与对局流语义一致）
    const intents = [...decision.plan.actionIntents, ...decision.plan.addPointIntents];
    for (const intent of intents) {
      const r = applyIntent(state, { actor: { kind: 'PLAYER', seat }, intent });
      if (!r.ok) {
        rejects++;
        continue;
      }
      state = r.state;
      steps++;
      stepsBySeat[String(seat)]++;
      eventId++;
      const msg: IntentBroadcastMsg = {
        type: 'INTENT_BROADCAST',
        from: String(seat === 1 ? TRAIN_PLAYER_IDS[1] : TRAIN_PLAYER_IDS[2]),
        fromSeat: seat,
        intent,
        eventId,
      };
      log.push(msg);
      if (state.finished) break;
    }
    opts.onTurn?.(seat, state);
    if (state.finished) break;
    // 双视角对称样本收集：回合结束局面 + 该回合开始局面
    for (const viewer of [1, 2]) {
      samples.push({
        gameId,
        mapId: map.id,
        seat: viewer,
        turn: state.turn,
        area: map.row * map.column,
        features: teFeatures(state, turnStart, viewer),
        late: isLatePhase(state),
        dToEnd: 0, // 终局后回填
        label: 0,
      });
    }
  }

  // 终局标签回填（§5：胜 +1 / 负 −1 / 平 0；上限判平）
  const winningTeam = state.finished ? state.winningTeam : null;
  const teamOf = (s: number) => state.forces.find((f) => f.seat === s)?.team ?? -1;
  const labelOf = (viewer: number): number => {
    if (winningTeam === null || winningTeam < 0) return 0;
    return teamOf(viewer) === winningTeam ? 1 : -1;
  };
  const lastTurn = Math.max(1, state.turn);
  for (const s of samples) {
    s.label = labelOf(s.seat);
    s.dToEnd = Math.max(1, lastTurn - s.turn);
  }

  log.push({
    type: 'GAME_OVER',
    gameId,
    winners: state.finished ? (state.winners ?? []) : [],
    winningTeam: winningTeam ?? -1,
    forces: [forceLogEntry(state, 1), forceLogEntry(state, 2)],
    refId: 'end',
  });

  return {
    finalState: state,
    stats: {
      gameId,
      mapId: map.id,
      reason,
      winningTeam,
      winnerSeats: winningTeam !== null && winningTeam >= 0 ? [1, 2].filter((s) => teamOf(s) === winningTeam) : [],
      turns: state.turn,
      steps,
      rejects,
      stepsBySeat,
    },
    samples,
    log,
  };
}
