// eval.ts — E_te / E_ape 权重与打分入口（设计方案 §3）
// E_te：训练对象，双套权重（中盘/残局）由 isLatePhase 切换，初值 = 种子权重 = 基准固定权重。
// E_ape：排序工具，权重固定不训练；前期/残局切换沿用 isLatePhase。
import type { GameState } from '@dl/shared';
import { extractBoard, hasSoldierContact } from './board.js';
import { apeFeatures, teFeatures } from './features.js';

/** E_te 权重（6 维：子力差值/连兵差值/网络脆弱性/网络可靠性/我方威胁性/叫杀得分） */
export interface TeWeights {
  mid: number[];
  late: number[];
}

/** 种子权重表（§3.1，2026-09-20 修订 f5）：冷启动初值 = 基准的固定权重 */
export const SEED_TE_WEIGHTS: TeWeights = {
  // [子力差值, 连兵差值, 网络脆弱性, 网络可靠性, 我方威胁性, 叫杀得分]
  mid: [0.05, 2.0, -1.0, -0.5, 50.0, 100],
  late: [0.05, 2.0, -1.0, -0.5, 2.0, 100],
};

/** E_ape 固定权重（4 维：兵力差净变化/可靠连兵差净变化/坏型数/威胁程度；§3.2） */
export const APE_WEIGHTS = {
  pre: [1.0, 1.0, 0, 5.0],
  late: [1.0, 1.0, -3.0, 0.3],
};

/** 中盘/残局阈值 T = ⌈log₂(地图长×地图宽/100)⌉ + 5 */
export function phaseThreshold(rows: number, columns: number): number {
  return Math.ceil(Math.log2((rows * columns) / 100)) + 5;
}

/** 残局判定（2026-09-20 新增接触判据）：回合数 ≥ T，或行动阶段结束时双方有子力接触
 * （存在距离 1 的一对友兵-敌兵）。回合结束局面与行动阶段结束局面在"接触"上等价
 * （加点/结束阶段不改动兵力与位置），故各处直接用当前局面判定。 */
export function isLatePhase(state: GameState): boolean {
  return state.turn >= phaseThreshold(state.rows, state.columns) || hasSoldierContact(extractBoard(state));
}

/** E_te(回合结束局面, 该回合开始局面, 视角) — isLatePhase(回合结束局面) 为真用残局权重，否则中盘 */
export function evalTe(end: GameState, start: GameState, seat: number, weights: TeWeights): number {
  const f = teFeatures(end, start, seat);
  const w = isLatePhase(end) ? weights.late : weights.mid;
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += w[i] * f[i];
  return sum;
}

/** E_ape(行动后/链终止局面, 行动阶段开始局面, 视角) — 纯排序工具，不进搜索评价 */
export function evalApe(post: GameState, start: GameState, seat: number): number {
  const f = apeFeatures(post, start, seat);
  const w = isLatePhase(post) ? APE_WEIGHTS.late : APE_WEIGHTS.pre;
  let sum = 0;
  for (let i = 0; i < 4; i++) sum += w[i] * f[i];
  return sum;
}
