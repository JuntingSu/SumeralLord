// online.ts — 线上接入 API（难度2 = 训练 MCTS AI；《数字领主-MCTS自训练环境设计方案》§11 线上接入立项）
// 供 backend ai-bot 子进程调用：启动时注入训练权重（缺省种子权重），回合内以 argmax MCTS 生成完整意图序列。
// 本模块只依赖 @dl/shared 与 train/lib 纯决策模块（无 node 内置依赖），可在 Node/浏览器环境运行。
import type { GameState, PlayerIntent } from '@dl/shared';
import { mctsDecide } from './mcts.js';
import { SEED_TE_WEIGHTS } from './eval.js';
import type { TeWeights } from './eval.js';

let currentWeights: TeWeights = { mid: [...SEED_TE_WEIGHTS.mid], late: [...SEED_TE_WEIGHTS.late] };

/** 注入训练权重（bot 启动时从权重文件加载；缺省 = 种子权重） */
export function initMctsWeights(weights: TeWeights): void {
  currentWeights = { mid: [...weights.mid], late: [...weights.late] };
}

/** 当前生效权重（诊断） */
export function getMctsWeights(): TeWeights {
  return { mid: [...currentWeights.mid], late: [...currentWeights.late] };
}

export interface OnlineTurnOptions {
  /** 每决策模拟数上限（默认 300） */
  simulations?: number;
  /** 在线决策时间预算（毫秒；默认 2000——到点即用已建树返回） */
  timeBudgetMs?: number;
}

/**
 * 难度2 回合计划：完整意图序列（行动阶段 MOVE/ATTACK + SWITCH_PHASE + 加点阶段 ADD_POINT/SWITCH_PHASE）。
 * 调用方（bot）按序逐条提交，被拒绝的意图丢弃（与对局流语义一致）。
 * 确定性：argmax 决策 + 局面哈希种子抽签，同局面同权重 → 同计划。
 */
export function planMctsTurn(state: GameState, seat: number, opts?: OnlineTurnOptions): PlayerIntent[] {
  const decision = mctsDecide(state, seat, currentWeights, {
    simulations: opts?.simulations ?? 300,
    timeBudgetMs: opts?.timeBudgetMs ?? 2000,
    mode: 'argmax',
  });
  return [...decision.plan.actionIntents, ...decision.plan.addPointIntents];
}
