// @dl/train 的浏览器侧类型声明：前端只使用 MCTS 线上入口，避免 tsc 跟随 train 源码
// （train/v1/lib 是训练工作区代码，其 noUnused 规则与前端不同）。
declare module '@dl/train' {
  import type { GameState, PlayerIntent } from '@dl/shared';

  export interface TeWeights {
    mid: number[];
    late: number[];
  }

  export function initMctsWeights(weights: TeWeights): void;
  export function getMctsWeights(): TeWeights;
  export function planMctsTurn(
    state: GameState,
    seat: number,
    opts?: { simulations?: number; timeBudgetMs?: number },
  ): PlayerIntent[];
}
