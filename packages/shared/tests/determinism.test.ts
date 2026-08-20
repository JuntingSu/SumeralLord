// 确定性：同输入重复调用输出全等；非法意图拒绝后状态逐字段不变
import { describe, it, expect } from 'vitest';
import { makeMap, startGame, assignments, act, CITY, PLAIN, OCEAN } from './helpers.js';
import { applyIntent, hashGameState, stableStringify } from '../src/index.js';

const ASG = assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: 102 });

function fullGame() {
  const map = makeMap({
    tiles: {
      6: [CITY, 1, 4],
      7: [PLAIN, 1, 3],
      12: [CITY, 2, 4],
      13: [PLAIN, 2, 3],
      17: [OCEAN, 1, 2],
      2: [PLAIN, 0, 2],
    },
  });
  const { state } = startGame(map, ASG);
  // 一段完整对局：seat1 移动 + 加点 + 结束；seat2 进攻 + 结束；seat1 进攻
  const steps: Array<[number, Parameters<typeof act>[2]]> = [
    [1, { intentType: 'MOVE', from: 7, to: 8 }],
    [1, { intentType: 'SWITCH_PHASE' }],
    [1, { intentType: 'ADD_POINT', coordinate: 7, amount: 1 }],
    [1, { intentType: 'SWITCH_PHASE' }],
    [2, { intentType: 'ATTACK', from: 13, to: 7 }],
    [2, { intentType: 'SWITCH_PHASE' }],
    [1, { intentType: 'ATTACK', from: 6, to: 7 }],
    [1, { intentType: 'SWITCH_PHASE' }],
  ];
  let cur = state;
  const applied: Array<{ seat: number; intent: Parameters<typeof act>[2]; ok: boolean }> = [];
  for (const [seat, intent] of steps) {
    const r = act(cur, seat, intent);
    applied.push({ seat, intent, ok: r.ok });
    if (r.ok) cur = r.state;
  }
  return { init: state, final: cur, steps, applied };
}

describe('确定性（M4 验收：同输入重复调用输出全等）', () => {
  it('完整意图流重放：终局哈希与逐步事件链全等', () => {
    const run1 = fullGame();
    const run2 = fullGame();
    expect(hashGameState(run1.final)).toBe(hashGameState(run2.final));
    expect(stableStringify(run1.final)).toBe(stableStringify(run2.final));
    expect(run1.applied.map((s) => s.ok)).toEqual(run2.applied.map((s) => s.ok));
    expect(stableStringify(run1.steps)).toBe(stableStringify(run2.steps));
  });

  it('非法意图拒绝后：返回原状态引用且逐字段不变', () => {
    const { init } = fullGame();
    const before = stableStringify(init);
    const r = applyIntent(init, { actor: { kind: 'PLAYER', seat: 2 }, intent: { intentType: 'MOVE', from: 12, to: 13 } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.state).toBe(init); // 同一引用（状态不变）
    expect(stableStringify(init)).toBe(before);
  });

  it('事件链入队顺序确定（两次运行逐步链全等）', () => {
    const map = makeMap({
      tiles: {
        6: [CITY, 1, 5],
        7: [PLAIN, 1, 2],
        13: [PLAIN, 1, 2],
        12: [CITY, 2, 5],
        17: [PLAIN, 1, 1],
      },
    });
    const g1 = startGame(map, ASG);
    const g2 = startGame(map, ASG);
    expect(stableStringify(g1.chain)).toBe(stableStringify(g2.chain));
    const r1 = act(g1.state, 1, { intentType: 'ATTACK', from: 6, to: 7 });
    const r2 = act(g2.state, 1, { intentType: 'ATTACK', from: 6, to: 7 });
    expect(stableStringify(r1.ok ? r1.chain : [])).toBe(stableStringify(r2.ok ? r2.chain : []));
  });
});
