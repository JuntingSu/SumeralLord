// driver.ts — v2 步级对局驱动 + 样本收集（决策定稿 §6）
// 双方 isAI=false + 虚拟 playerId；每步一个原子意图，由外部注入的 Policy 决策；
// 样本 = 动作前局面编码 + 动作先验 π（覆盖全部合法动作）+ 终局标签 z（回填）。
// 对局日志与线上同构（GAME_START / INTENT_BROADCAST×N / GAME_OVER）。
import { applyIntent, initState } from '@dl/shared';
import type { GameStartMsg, GameState, IntentBroadcastMsg, MapFullData, PlayerIntent, RejectReason, RoomTimeSettings } from '@dl/shared';
import { legalActionList, legalMask, actionToIntent } from './actions.js';
import { encodeState } from './encode.js';

/** 训练对局双方虚拟 playerId（无主势力删兵规则的绕行：playerId 非空即保留） */
export const TRAIN_PLAYER_IDS = { 1: 900001, 2: 900002 } as const;

export const TIME_SETTINGS: RoomTimeSettings = { stepTime: 30, gameTime: 600, additionalTime: 10 };

/** 对局上限（决策定稿 §10 调参项，沿用旧值）：60 回合或 1000 步，任一到达判平 */
export const MAX_TURNS = 60;
export const MAX_STEPS = 1000;

/** 动作先验：合法动作索引与概率（prob 可含 0；合计 = 1） */
export interface SparsePi {
  idx: number[];
  prob: number[];
}

/** 一步决策：意图 + 可选动作先验（带先验才收集样本） */
export interface StepDecision {
  intent: PlayerIntent;
  pi?: SparsePi;
}

export type Policy = (state: GameState) => StepDecision | Promise<StepDecision>;

/** 训练样本（每步一条；z 在终局后回填） */
export interface TrainSample {
  gameId: string;
  mapId: string;
  turn: number;
  /** 决策点视角势力（= 当时的行动方） */
  seat: number;
  phase: string;
  nTiles: number;
  /** 地图行数（token 位置推导用） */
  rows: number;
  /** 地图列数（token 位置推导用） */
  columns: number;
  /** CLS 全局特征 */
  cls: number[];
  /** 每格 token */
  tiles: number[][];
  /** 合法动作上的先验：[动作索引, 概率]，覆盖全部合法动作 */
  pi: [number, number][];
  /** 终局标签（行动方视角）：胜 +1 / 负 −1 / 平 0 */
  z: number;
}

export interface GameStats {
  gameId: string;
  mapId: string;
  reason: 'victory' | 'turn_cap' | 'step_cap';
  winningTeam: number | null;
  turns: number;
  steps: number;
  /** 被拒绝而丢弃的意图条数（合法掩码策略下应恒为 0） */
  rejects: number;
  /** 被拒意图明细（诊断/败因分析用） */
  rejectedIntents: Array<{ seat: number; intent: PlayerIntent; reason: RejectReason }>;
}

export interface GameResult {
  finalState: GameState;
  stats: GameStats;
  samples: TrainSample[];
  /** 对局日志行（GAME_START / INTENT_BROADCAST×N / GAME_OVER） */
  log: object[];
}

export interface DriveOptions {
  policy: Policy;
  seed?: string;
  maxTurns?: number;
  maxSteps?: number;
}

function forceLogEntry(state: GameState, seat: number): { seat: number; playerId: string | null; isAI: boolean; cleared: boolean } {
  const f = state.forces.find((x) => x.seat === seat);
  return { seat, playerId: f ? String(f.playerId ?? '') : null, isAI: f?.isAI ?? false, cleared: !f?.alive };
}

/** 跑一局步级对局（策略由调用方注入；每步意图逐条提交，拒绝丢弃并计数） */
export async function playGame(map: MapFullData, opts: DriveOptions): Promise<GameResult> {
  const gameId = 't' + Math.random().toString(36).slice(2, 10);
  const seatAssignments = [
    { seat: 1, playerId: TRAIN_PLAYER_IDS[1], isAI: false },
    { seat: 2, playerId: TRAIN_PLAYER_IDS[2], isAI: false },
  ];
  const seed = opts.seed ?? Math.random().toString(36).slice(2, 12);

  const log: object[] = [];
  log.push({
    type: 'GAME_START',
    roomId: 'train-v2',
    gameId,
    map,
    seatAssignments,
    spawnAssignments: map.player_list.map((p) => ({
      seat: p.seat,
      spawnIndex: map.battlefield.findIndex((bf) => bf[0] === 1 && bf[1] === p.seat),
    })),
    seed,
    timeSettings: TIME_SETTINGS,
    reducerVersion: 'train-v2-0',
  } satisfies GameStartMsg);

  let state = initState({ map, seatAssignments, seed, timeSettings: TIME_SETTINGS }).state;

  const samples: TrainSample[] = [];
  let steps = 0;
  let rejects = 0;
  const rejectedIntents: GameStats['rejectedIntents'] = [];
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
    // 静止态只可能是 ACTION / ADD_POINT（PREPARE/END 为自动阶段）
    if (state.phase !== 'ACTION' && state.phase !== 'ADD_POINT') {
      throw new Error(`unexpected phase ${state.phase} at decision point (turn ${state.turn}, seat ${seat})`);
    }

    // 动作前局面编码 + 掩码 + 策略决策
    const enc = encodeState(state);
    const mask = legalMask(state);
    const decision = await opts.policy(state);
    const pi = decision.pi;
    if (pi !== undefined) {
      const legal = legalActionList(state);
      const piByIdx = new Map(pi.idx.map((idx, i) => [idx, pi.prob[i]]));
      const zipped: [number, number][] = legal.map((idx) => [idx, piByIdx.get(idx) ?? 0]);
      samples.push({
        gameId,
        mapId: map.id,
        turn: state.turn,
        seat,
        phase: state.phase,
        nTiles: state.tiles.length,
        rows: state.rows,
        columns: state.columns,
        cls: enc.cls,
        tiles: enc.tiles,
        pi: zipped,
        z: 0, // 终局后回填
      });
    }

    const applied = applyIntent(state, { actor: { kind: 'PLAYER', seat }, intent: decision.intent });
    if (!applied.ok) {
      rejects++;
      rejectedIntents.push({ seat, intent: decision.intent, reason: applied.reason });
      continue; // 非法意图丢弃（合法掩码策略下不应发生；防御）
    }
    state = applied.state;
    steps++;
    eventId++;
    log.push({
      type: 'INTENT_BROADCAST',
      from: String(seat === 1 ? TRAIN_PLAYER_IDS[1] : TRAIN_PLAYER_IDS[2]),
      fromSeat: seat,
      intent: decision.intent,
      eventId,
    } satisfies IntentBroadcastMsg);
  }

  // 终局标签回填（行动方视角：胜 +1 / 负 −1 / 平 0；上限判平）
  const winningTeam = state.finished ? state.winningTeam : null;
  const teamOf = (s: number) => state.forces.find((f) => f.seat === s)?.team ?? -1;
  for (const s of samples) {
    if (winningTeam === null || winningTeam < 0) {
      s.z = 0;
    } else {
      s.z = teamOf(s.seat) === winningTeam ? 1 : -1;
    }
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
      turns: state.turn,
      steps,
      rejects,
      rejectedIntents,
    },
    samples,
    log,
  };
}

/** 随机策略：在合法动作上均匀采样（阶段 0 冒烟/测试用；π = 均匀分布） */
export function randomPolicy(rng: () => number = Math.random): Policy {
  return (state) => {
    const legal = legalActionList(state);
    const idx = legal[Math.floor(rng() * legal.length)];
    const prob = 1 / legal.length;
    return { intent: actionToIntent(state, idx), pi: { idx: [...legal], prob: legal.map(() => prob) } };
  };
}
