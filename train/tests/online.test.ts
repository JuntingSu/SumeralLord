// online.test.ts — 线上接入 API（难度2 训练 MCTS AI）单测
import { describe, expect, it } from 'vitest';
import { applyIntent, initState } from '@dl/shared';
import type { GameState } from '@dl/shared';
import { getMctsWeights, initMctsWeights, planMctsTurn } from '../lib/online.js';
import { SEED_TE_WEIGHTS } from '../lib/eval.js';
import { generateTrainMap } from '../lib/mapgen.js';

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

describe('planMctsTurn（难度2 线上回合计划）', () => {
  it('返回完整意图序列且全部可应用；回合推进到对方', () => {
    const state = initGame('online-1');
    const intents = planMctsTurn(state, 1, { simulations: 24 });
    expect(intents.length).toBeGreaterThan(0);
    let cur = state;
    let rejects = 0;
    for (const intent of intents) {
      const r = applyIntent(cur, { actor: { kind: 'PLAYER', seat: 1 }, intent });
      if (r.ok) cur = r.state;
      else rejects++;
    }
    expect(rejects).toBe(0);
    if (!cur.finished) {
      expect(cur.currentSeat).toBe(2); // 回合结束轮到对方
      expect(cur.phase).toBe('ACTION');
    }
  }, 60_000);

  it('确定性：同局面同权重 → 同计划', () => {
    const state = initGame('online-det');
    const a = planMctsTurn(state, 1, { simulations: 24 });
    const b = planMctsTurn(state, 1, { simulations: 24 });
    expect(a).toEqual(b);
  }, 60_000);

  it('initMctsWeights 注入与读取；缺省为种子权重', () => {
    initMctsWeights(SEED_TE_WEIGHTS);
    expect(getMctsWeights()).toEqual(SEED_TE_WEIGHTS);
    const custom = { mid: [0.5, 2, -1, -0.5, 50, 100], late: [0.5, 2, -1, -0.5, 2, 100] };
    initMctsWeights(custom);
    expect(getMctsWeights()).toEqual(custom);
    const state = initGame('online-w');
    const intents = planMctsTurn(state, 1, { simulations: 24 });
    expect(intents.length).toBeGreaterThan(0); // 自定义权重下决策可用
    initMctsWeights(SEED_TE_WEIGHTS); // 还原，避免影响其他用例
  }, 60_000);
});
