// eval.ts — E_te / E_ape 权重与打分入口（设计方案 §3）
// E_te：训练对象，双套权重（中盘/残局）由阈值 T 切换，初值 = 种子权重 = 基准固定权重。
// E_ape：排序工具，权重固定不训练；前期/残局切换沿用 T。
import type { GameState } from '@dl/shared';
import { apeFeatures, teFeatures } from './features.js';

/** E_te 权重（6 维：子力差值/连兵差值/网络脆弱性/网络可靠性/我方威胁性/叫杀得分） */
export interface TeWeights {
  mid: number[];
  late: number[];
}

/** 种子权重表（§3.1）：冷启动初值 = 基准的固定权重 */
export const SEED_TE_WEIGHTS: TeWeights = {
  mid: [0.05, 2.0, -1.0, -0.5, 0.2, 100],
  late: [0.05, 2.0, -1.0, -0.5, 0.2, 100],
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

/** E_te(回合结束局面, 该回合开始局面, 视角) — 回合数 < T 用中盘权重，≥ T 用残局权重 */
export function evalTe(end: GameState, start: GameState, seat: number, weights: TeWeights): number {
  const f = teFeatures(end, start, seat);
  const t = phaseThreshold(end.rows, end.columns);
  const w = end.turn >= t ? weights.late : weights.mid;
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += w[i] * f[i];
  return sum;
}

/** E_ape(行动后/链终止局面, 行动阶段开始局面, 视角) — 纯排序工具，不进搜索评价 */
export function evalApe(post: GameState, start: GameState, seat: number): number {
  const f = apeFeatures(post, start, seat);
  const t = phaseThreshold(post.rows, post.columns);
  const w = post.turn >= t ? APE_WEIGHTS.late : APE_WEIGHTS.pre;
  let sum = 0;
  for (let i = 0; i < 4; i++) sum += w[i] * f[i];
  return sum;
}
