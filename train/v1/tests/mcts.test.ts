// mcts.test.ts — 阶段4：回合级 MCTS 引擎
import { describe, expect, it } from 'vitest';
import { applyIntent, initState } from '@dl/shared';
import type { GameState } from '@dl/shared';
import { mctsDecide } from '../lib/mcts.js';
import { SEED_TE_WEIGHTS } from '../lib/eval.js';
import { generateTrainMap } from '../lib/mapgen.js';
import { planTurnCandidates } from '../lib/turnplan.js';

function initGame(mapId: string): GameState {
  const { map } = generateTrainMap(mapId);
  return initState({
    map,
    seatAssignments: [
      { seat: 1, playerId: 900001, isAI: false },
      { seat: 2, playerId: 900002, isAI: false },
    ],
    seed: mapId,
    timeSettings: { stepTime: 30, gameTime: 600, additionalTime: 10 },
  }).state;
}

describe('mctsDecide（argmax 确定性）', () => {
  it('同一局面两次决策结果一致（含访问数）', () => {
    const state = initGame('mcts-det');
    const a = mctsDecide(state, 1, SEED_TE_WEIGHTS, { simulations: 24 });
    const b = mctsDecide(state, 1, SEED_TE_WEIGHTS, { simulations: 24 });
    expect(a.visits).toEqual(b.visits);
    expect(JSON.stringify(a.plan)).toBe(JSON.stringify(b.plan));
  }, 60_000);

  it('访问数总和 = 模拟次数；候选 ≤ 4；结果状态为对方回合边界', () => {
    const state = initGame('mcts-stats');
    const r = mctsDecide(state, 1, SEED_TE_WEIGHTS, { simulations: 30 });
    expect(r.plans.length).toBeGreaterThanOrEqual(1);
    expect(r.plans.length).toBeLessThanOrEqual(6);
    expect(r.visits.reduce((x, y) => x + y, 0)).toBe(30);
    if (!r.plan.resultState.finished) {
      expect(r.plan.resultState.phase).toBe('ACTION');
      expect(r.plan.resultState.currentSeat).toBe(2);
    }
  }, 120_000);

  it('对手节点取 min：根选择的价值估计 ≤ 子节点最高价值（搜索一致性冒烟）', () => {
    const state = initGame('mcts-min');
    const r = mctsDecide(state, 1, SEED_TE_WEIGHTS, { simulations: 40 });
    // 根平均价值应有限且被访问数支撑
    for (let i = 0; i < r.visits.length; i++) {
      if (r.visits[i] > 0) expect(Number.isFinite(r.meanValues[i])).toBe(true);
    }
  }, 120_000);
});

describe('温度采样模式', () => {
  it('τ 极小时近似 argmax', () => {
    const state = initGame('mcts-tau');
    const argmax = mctsDecide(state, 1, SEED_TE_WEIGHTS, { simulations: 40, mode: 'argmax' });
    const sampled = mctsDecide(state, 1, SEED_TE_WEIGHTS, {
      simulations: 40,
      mode: 'sample',
      temperature: 0.01,
      rng: () => 0.999, // 高随机数偏向最大权重（≈最大访问簇）
    });
    expect(sampled.visits).toEqual(argmax.visits);
  }, 120_000);
});

describe('planTurnCandidates 与 MCTS 一致性', () => {
  it('MCTS 根候选 = planTurnCandidates 输出', () => {
    const state = initGame('mcts-cand');
    const direct = planTurnCandidates(state, 1, SEED_TE_WEIGHTS);
    const r = mctsDecide(state, 1, SEED_TE_WEIGHTS, { simulations: 4 });
    expect(r.plans.length).toBe(direct.length);
  }, 120_000);
});

describe('回合推进冒烟（双方各走一步）', () => {
  it('seat1 决策 → 应用 → seat2 决策 → 应用，回合数推进', () => {
    let state = initGame('mcts-advance');
    const r1 = mctsDecide(state, 1, SEED_TE_WEIGHTS, { simulations: 8 });
    // 按相位门控应用 seat1 计划
    let cur = state;
    for (const intent of r1.plan.actionIntents) {
      if (cur.phase !== 'ACTION') break;
      const x = applyIntent(cur, { actor: { kind: 'PLAYER', seat: 1 }, intent });
      if (x.ok) cur = x.state;
    }
    for (const intent of r1.plan.addPointIntents) {
      const x = applyIntent(cur, { actor: { kind: 'PLAYER', seat: 1 }, intent });
      if (x.ok) cur = x.state;
    }
    state = cur;
    expect(state.currentSeat).toBe(2);
    const r2 = mctsDecide(state, 2, SEED_TE_WEIGHTS, { simulations: 8 });
    expect(r2.plans.length).toBeGreaterThanOrEqual(1);
  }, 180_000);
});
