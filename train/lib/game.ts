// 对局驱动（训练管线）：纯 AI 对局演算 + 回合上限 + 计分
// - allowAiOnly=true 跑通 AI-only 对局（M1 补丁）
// - 回合上限截断：turn > turnCap 时停止，计分 = 截断 ≈ 近败（−0.9）
// - 计分协议：终端 = outcome + (1 − 2p̂)，p̂ = b（seat1 先手）/ 1−b（后手）
import { applyIntent, initState, planAiTurn } from '@dl/shared';
import type { GameState, MapFullData, PlayerIntent, SeatAssignment } from '@dl/shared';

/** 策略：给定局面返回一条意图（无状态，每次重规划） */
export type Policy = (state: GameState, seat: number, aiSeed: string) => PlayerIntent;

export interface PlayOptions {
  /** 回合上限（全局轮次；0 = 不限） */
  turnCap: number;
  /** 每 seat 的独立 AI 随机种子（训练协议：m 的随机流独立于局内种子） */
  aiSeeds: Record<number, string>;
  /** 驱动安全上限（防止死循环；默认 5000 步） */
  maxPlies?: number;
}

export interface GameResult {
  state: GameState;
  /** 自然终局（分出胜负） */
  finished: boolean;
  /** 回合上限截断 */
  truncated: boolean;
  winningTeam: number | null;
  /** 已执行意图数 */
  plies: number;
  /** 结束时的全局轮次 */
  turns: number;
}

/** 用 withSeed 覆盖 state.seed（仅影响 planAiTurn 等 AI 决策随机源，不影响 reducer 演算） */
export function withSeed(state: GameState, seed: string): GameState {
  return { ...state, seed };
}

/** 规则 AI（难度1）策略：取 planAiTurn 计划的首条意图；计划为空时切阶段 */
export function rulePolicy(state: GameState, seat: number, aiSeed: string): PlayerIntent {
  const plan = planAiTurn(withSeed(state, aiSeed), seat);
  if (plan.kind === 'intents' && plan.intents.length > 0) return plan.intents[0];
  return { intentType: 'SWITCH_PHASE' };
}

/**
 * 完整对局驱动：双方按 Policy 交替出招，直至终局/截断/安全上限。
 * 仅允许 ACTION / ADD_POINT 阶段出招（PREPARE/END 由 reducer 级联自动处理）。
 */
export function playGame(map: MapFullData, seatAssignments: SeatAssignment[], policies: Record<number, Policy>, opts: PlayOptions): GameResult {
  const maxPlies = opts.maxPlies ?? 5000;
  let st = initState({
    map,
    seatAssignments,
    seed: 'game',
    timeSettings: { stepTime: 60, gameTime: 600, additionalTime: 0 },
    allowAiOnly: true,
  }).state;

  let plies = 0;
  for (; plies < maxPlies; plies++) {
    if (st.finished) break;
    if (opts.turnCap > 0 && st.turn > opts.turnCap) break;
    const seat = st.currentSeat;
    const policy = policies[seat];
    if (!policy) throw new Error(`缺 seat${seat} 策略`);
    const intent = policy(st, seat, opts.aiSeeds[seat] ?? 'default-ai-seed');
    const r = applyIntent(st, { actor: { kind: 'PLAYER', seat }, intent });
    if (r.ok) {
      st = r.state;
      continue;
    }
    // 意图被拒（理论不应发生）：兜底切阶段，避免卡死
    const s = applyIntent(st, { actor: { kind: 'PLAYER', seat }, intent: { intentType: 'SWITCH_PHASE' } });
    if (!s.ok) break; // 无法推进 → 视为异常结束
    st = s.state;
  }

  const truncated = !st.finished && plies >= maxPlies ? true : !st.finished && opts.turnCap > 0 && st.turn > opts.turnCap;
  return {
    state: st,
    finished: st.finished,
    truncated,
    winningTeam: st.finished ? st.winningTeam : null,
    plies,
    turns: st.turn,
  };
}

/**
 * 单方计分（训练/评测用）：seat 视角。
 * 终端：outcome + (1 − 2p̂)；截断：−0.9。
 * p̂ = b（seat 为先手，即 seat1）/ 1−b（后手）。
 */
export function scoreFor(result: GameResult, seat: number, b: number): number {
  if (result.truncated || !result.finished) return -0.9;
  const force = result.state.forces.find((f) => f.seat === seat);
  const won = !!force && result.winningTeam !== null && force.team === result.winningTeam;
  const outcome = won ? 1 : -1;
  const prior = seat === 1 ? b : 1 - b;
  return outcome + (1 - 2 * prior);
}
