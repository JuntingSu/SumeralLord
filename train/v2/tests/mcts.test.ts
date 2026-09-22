// mcts.test.ts — 原子 MCTS：确定性 / 终局处理 / 端到端对局
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { applyIntent, initState } from '@dl/shared';
import type { GameState } from '@dl/shared';
import { actionToIntent, legalActionList } from '../lib/actions.js';
import { NeuralNet } from '../lib/nn.js';
import { mctsDecide, mctsPolicy } from '../lib/mcts.js';
import { playGame } from '../lib/driver.js';
import { V2_ROOT } from '../lib/paths.js';
import { makeTestMap } from './helpers.js';

const MODEL = path.join(V2_ROOT, 'runs', 'weights', 'model.onnx');

let net: NeuralNet | null = null;
async function getNet(): Promise<NeuralNet> {
  if (!net) net = await NeuralNet.load(MODEL);
  return net;
}

function freshState(): GameState {
  const map = makeTestMap(5, 5);
  return initState({
    map,
    seatAssignments: [
      { seat: 1, playerId: 900001, isAI: false },
      { seat: 2, playerId: 900002, isAI: false },
    ],
    seed: 'test',
    timeSettings: { stepTime: 30, gameTime: 600, additionalTime: 10 },
  }).state;
}

describe('原子 MCTS', () => {
  it('确定性：同局面同网络同模拟数 → 同动作（argmax）', async () => {
    const n = await getNet();
    const state = freshState();
    const a = await mctsDecide(state, n, { simulations: 60 });
    const b = await mctsDecide(state, n, { simulations: 60 });
    expect(a.action).toBe(b.action);
    expect(a.action).toBeGreaterThanOrEqual(0);
  });

  it('动作合法：根选择来自合法动作集', async () => {
    const n = await getNet();
    const state = freshState();
    const legal = legalActionList(state);
    const r = await mctsDecide(state, n, { simulations: 40 });
    expect(legal).toContain(r.action);
    // π 覆盖全部合法动作、概率合计 1
    expect(r.pi.idx).toEqual(legal);
    expect(r.pi.prob.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    for (const p of r.pi.prob) {
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });

  it('根全动作展开：每个合法动作都有子节点访问记录', async () => {
    const n = await getNet();
    const state = freshState();
    const legal = legalActionList(state);
    const r = await mctsDecide(state, n, { simulations: 100 });
    expect(r.visits.size).toBe(legal.length);
    for (const a of legal) {
      expect(r.visits.has(a)).toBe(true);
    }
    // 模拟数足够时每个动作至少被访问一次（根全展开 + 100 模拟 vs ~10 合法动作）
    for (const a of legal) {
      expect(r.visits.get(a) ?? 0).toBeGreaterThan(0);
    }
  });

  it('温度采样与 argmax 均产出合法动作', async () => {
    const n = await getNet();
    const state = freshState();
    let x = 7;
    const rng = () => {
      x = (x * 1103515245 + 12345) % 2147483648;
      return x / 2147483648;
    };
    const r = await mctsDecide(state, n, { simulations: 60, temperature: 2, rng });
    expect(legalActionList(state)).toContain(r.action);
  });

  it('端到端：MCTS 策略跑完整局（小模拟数），零拒绝', async () => {
    const n = await getNet();
    const map = makeTestMap(5, 5);
    const result = await playGame(map, {
      policy: mctsPolicy(n, { simulations: 40, temperature: 1 }),
      seed: 'mcts-e2e',
      maxSteps: 80, // 小图小局，加速测试
    });
    expect(result.stats.rejects).toBe(0);
    expect(result.samples.length).toBeGreaterThan(0);
    // 样本 π 合法
    for (const s of result.samples.slice(0, 20)) {
      expect(s.pi.reduce((a, [, p]) => a + p, 0)).toBeCloseTo(1, 6);
    }
  }, 120000);

  it('终局防御：已结束局面返回空结果', async () => {
    const n = await getNet();
    const state = freshState();
    const r = applyIntent(state, {
      actor: { kind: 'PLAYER', seat: 1 },
      intent: { intentType: 'SURRENDER', seat: 1 },
    });
    expect(r.ok).toBe(true);
    const res = await mctsDecide(r.state, n, { simulations: 10 });
    expect(res.action).toBe(-1);
    expect(res.pi.idx).toEqual([]);
  });
});
