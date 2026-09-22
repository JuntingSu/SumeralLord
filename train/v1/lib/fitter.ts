// fitter.ts — E_te 权重拟合（设计方案 §5 / §9 默认项 1）
// 跨局 pairwise 排序学习（胜局样本 > 败局样本对，允许不单调）；
// 平方反比加权 w = 1/d²（d = 距终局回合数）；次梯度 SGD；指向种子权重的轻量 L2 正则。
// 中盘/残局两套权重独立更新（残局标记随样本记录：回合数 ≥ T 或 行动阶段结束双方接触，同 E_te 打分口径）。
import { SEED_TE_WEIGHTS, phaseThreshold } from './eval.js';
import type { TeWeights } from './eval.js';
import type { TrainSample } from './driver.js';

export interface FitOptions {
  /** SGD 步数（随机抽 pairwise 的更新次数） */
  steps?: number;
  /** 学习率 */
  lr?: number;
  /** 指向种子权重的 L2 系数 */
  l2?: number;
  /** pairwise 间隔（hinge margin） */
  margin?: number;
  rng?: () => number;
}

export interface FitReport {
  stepsRun: number;
  pairsUsed: number;
  /** 拟合前后在采样对上的排序损失（诊断） */
  lossBefore: number;
  lossAfter: number;
  midUpdated: boolean;
  lateUpdated: boolean;
}

export interface FitResult {
  weights: TeWeights;
  report: FitReport;
}

function weightSetFor(sample: TrainSample, weights: TeWeights): number[] {
  // 残局判定随样本记录（回合数 ≥ T 或 行动阶段结束双方子力接触，同 E_te 打分口径）；
  // 升级前的旧批次文件无 late 字段 → 回退纯 T 阈值（面积还原近似，仅过渡批次使用）
  if (sample.late !== undefined) return sample.late ? weights.late : weights.mid;
  const rows = Math.floor(Math.sqrt(sample.area)) || 9;
  const columns = Math.max(1, Math.floor(sample.area / rows));
  const T = phaseThreshold(rows, columns);
  return sample.turn >= T ? weights.late : weights.mid;
}

function evalSample(sample: TrainSample, weights: TeWeights): number {
  const w = weightSetFor(sample, weights);
  let sum = 0;
  for (let i = 0; i < 6; i++) sum += w[i] * sample.features[i];
  return sum;
}

/** 样本学习权重（缺省 1；示范样本 weight=200 以 200 倍参与 pairwise，重要性采样语义） */
function sampleWeight(sample: TrainSample): number {
  return sample.weight ?? 1;
}

/** 从样本窗口拟合新权重（返回新对象，不改入参）。
 * 2026-09-20：配合慢 τ 高探索方案，默认步数/学习率上调（更激进；L2 锚定保持 1e-4）。 */
export function fitWeights(samples: TrainSample[], seed: TeWeights, opts?: FitOptions): FitResult {
  const steps = opts?.steps ?? 3000;
  const lr = opts?.lr ?? 4e-4;
  const l2 = opts?.l2 ?? 1e-4;
  const margin = opts?.margin ?? 0.0;
  const rng = opts?.rng ?? Math.random;

  // 胜/负样本（平局样本不参与 pairwise）
  const wins = samples.filter((s) => s.label === 1);
  const losses = samples.filter((s) => s.label === -1);
  if (wins.length === 0 || losses.length === 0) {
    return {
      weights: { mid: [...seed.mid], late: [...seed.late] },
      report: { stepsRun: 0, pairsUsed: 0, lossBefore: 0, lossAfter: 0, midUpdated: false, lateUpdated: false },
    };
  }

  const mid = [...seed.mid];
  const late = [...seed.late];
  const working: TeWeights = { mid, late };
  let midUpdated = false;
  let lateUpdated = false;

  const pairLoss = (): number => {
    // 采样 200 对估计当前排序损失（诊断）
    let loss = 0;
    const n = 200;
    for (let k = 0; k < n; k++) {
      const wS = wins[Math.floor(rng() * wins.length)];
      const lS = losses[Math.floor(rng() * losses.length)];
      const d = evalSample(wS, working) - evalSample(lS, working);
      const weight = sampleWeight(wS) / (wS.dToEnd * wS.dToEnd) + sampleWeight(lS) / (lS.dToEnd * lS.dToEnd);
      loss += Math.max(0, margin - d) * weight;
    }
    return loss / n;
  };
  const lossBefore = pairLoss();

  let pairsUsed = 0;
  for (let step = 0; step < steps; step++) {
    const wS = wins[Math.floor(rng() * wins.length)];
    const lS = losses[Math.floor(rng() * losses.length)];
    const diff = evalSample(wS, working) - evalSample(lS, working);
    if (diff >= margin) continue;
    const setW = weightSetFor(wS, working);
    const setL = weightSetFor(lS, working);
    const pairWeight = sampleWeight(wS) / (wS.dToEnd * wS.dToEnd) + sampleWeight(lS) / (lS.dToEnd * lS.dToEnd);
    const gScale = lr * pairWeight;
    const applyUpdate = (vec: number[], dataGrad: number[]): void => {
      const seedVec = vec === mid ? seed.mid : seed.late;
      for (let i = 0; i < 6; i++) {
        vec[i] -= gScale * dataGrad[i] + lr * l2 * (vec[i] - seedVec[i]);
      }
    };
    if (setW === setL) {
      // 同相位：L 对该集合的次梯度 = −(f_w − f_l)
      applyUpdate(setW, wS.features.map((v, i) => -(v - lS.features[i])));
    } else {
      // 跨相位：胜侧集合 ∂L/∂A = −f_w；负侧集合 ∂L/∂B = +f_l
      applyUpdate(setW, wS.features.map((v) => -v));
      applyUpdate(setL, lS.features.map((v) => v));
    }
    if (setW === late || setL === late) lateUpdated = true;
    if (setW === mid || setL === mid) midUpdated = true;
    pairsUsed++;
  }
  const lossAfter = pairLoss();

  return {
    weights: { mid, late },
    report: { stepsRun: steps, pairsUsed, lossBefore, lossAfter, midUpdated, lateUpdated },
  };
}

/** 种子权重快捷引用 */
export function seedWeights(): TeWeights {
  return { mid: [...SEED_TE_WEIGHTS.mid], late: [...SEED_TE_WEIGHTS.late] };
}
