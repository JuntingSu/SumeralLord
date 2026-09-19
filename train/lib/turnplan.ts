// turnplan.ts — 完整回合计划组装（设计方案 §2.3）
// MCTS 每节点动作空间 = 4 条行动方案（top-4）× 1 种加点方案 = 4 个候选回合计划；
// 加点方案在每个行动候选的行动后局面（含相位推进到 ADD_POINT）上独立运行。
import { applyIntent } from '@dl/shared';
import type { GameState, PlayerIntent } from '@dl/shared';
import { planActionPhase, type PlanActionOptions } from './action.js';
import { planAddPoints } from './addpoint.js';
import type { TeWeights } from './eval.js';

export interface TurnPlan {
  /** 行动阶段意图（前置链 + 基础行为 + 防守），在 ACTION 相位应用 */
  actionIntents: PlayerIntent[];
  /** 加点阶段意图（含必要的 SWITCH_PHASE 收尾），在 ADD_POINT 相位应用 */
  addPointIntents: PlayerIntent[];
  /** 回合边界状态：对手行动阶段开始（对局结束则为终局状态） */
  resultState: GameState;
}

export interface TurnPlanOptions {
  action?: PlanActionOptions;
  poolRatio?: number;
}

/**
 * 生成 4 个候选回合计划。
 * state：本势力行动阶段开始局面（phase = ACTION，currentSeat = seat）。
 */
export function planTurnCandidates(
  state: GameState,
  seat: number,
  weights: TeWeights,
  opts?: TurnPlanOptions,
): TurnPlan[] {
  const actions = planActionPhase(state, seat, opts?.action);
  return actions.map((ap) => finishTurnPlan(state, seat, ap.leaf, ap.intents, weights, opts));
}

/** 组装单条回合计划：行动后局面 → ADD_POINT → 加点 → （点数剩余则）SWITCH_PHASE 收尾 */
function finishTurnPlan(
  turnStart: GameState,
  seat: number,
  leaf: GameState,
  actionIntents: PlayerIntent[],
  weights: TeWeights,
  opts?: TurnPlanOptions,
): TurnPlan {
  const addPointIntents: PlayerIntent[] = [];
  let cur = leaf;
  if (cur.finished) {
    return { actionIntents, addPointIntents, resultState: cur };
  }
  // 相位推进：ACTION → ADD_POINT（行动阶段被 reducer 自动跳过时已在 ADD_POINT）
  if (cur.phase === 'ACTION') {
    const r = applyIntent(cur, { actor: { kind: 'PLAYER', seat }, intent: { intentType: 'SWITCH_PHASE' } });
    if (r.ok) {
      cur = r.state;
      addPointIntents.push({ intentType: 'SWITCH_PHASE' });
    }
  }
  // 加点（意图经 reducer 逐条应用，保证与提交后一致；点数用尽 reducer 自动切阶段）
  const planned = planAddPoints(cur, turnStart, seat, weights, opts ? { poolRatio: opts.poolRatio } : undefined);
  for (const intent of planned) {
    if (cur.phase !== 'ADD_POINT') break; // 点数用尽已自动切阶段
    const r = applyIntent(cur, { actor: { kind: 'PLAYER', seat }, intent });
    if (!r.ok) break; // 意外拒绝：停止加点（保守交还）
    cur = r.state;
    addPointIntents.push(intent);
  }
  // 点数未用尽（如无连兵交还）：显式 SWITCH_PHASE 结束回合
  if (cur.phase === 'ADD_POINT') {
    const r = applyIntent(cur, { actor: { kind: 'PLAYER', seat }, intent: { intentType: 'SWITCH_PHASE' } });
    if (r.ok) {
      cur = r.state;
      addPointIntents.push({ intentType: 'SWITCH_PHASE' });
    }
  }
  return { actionIntents, addPointIntents, resultState: cur };
}
