import { describe, expect, it } from 'vitest';
import type { GameState } from '../src/index.js';
import { applyInverseDiff, diffGameState, stableStringify } from '../src/index.js';
import { act, makeMap, startGame } from './helpers.js';

/** 4x5：seat1 平原兵(0,力5)，seat2 平原兵(1,力3)；用于移动/攻击/阶段测试 */
function battleMap() {
  return makeMap({
    rows: 4,
    columns: 5,
    tiles: {
      0: [0, 1, 5],
      1: [0, 2, 3],
    },
  });
}

/** 4x5：seat1 据点兵(0,力5，自动连兵)，seat2 平原兵(1,力3)；用于加点测试 */
function addPointMap() {
  return makeMap({
    rows: 4,
    columns: 5,
    tiles: {
      0: [1, 1, 5],
      1: [0, 2, 3],
    },
  });
}

function roundTrip(before: GameState, intent: Parameters<typeof act>[2], seat: number): GameState {
  const result = act(before, seat, intent);
  if (!result.ok) throw new Error(`意图被拒：${result.reason}`);
  const diff = diffGameState(before, result.state);
  const restored = applyInverseDiff(result.state, diff);
  expect(stableStringify(restored)).toBe(stableStringify(before));
  return result.state;
}

describe('diffGameState / applyInverseDiff', () => {
  it('MOVE 往返全等，且只记录变化的 tile', () => {
    const before = startGame(battleMap()).state;
    const after = roundTrip(before, { intentType: 'MOVE', from: 0, to: 5 }, 1);
    const diff = diffGameState(before, after);
    expect(diff.tiles.length).toBeGreaterThan(0);
    expect(diff.tiles.length).toBeLessThan(before.tiles.length);
    expect(diff.tiles.some((t) => t.index === 0)).toBe(true);
  });

  it('ATTACK 往返全等（含反击/删兵/进占）', () => {
    const before = startGame(battleMap()).state;
    roundTrip(before, { intentType: 'ATTACK', from: 0, to: 1 }, 1);
  });

  it('SWITCH_PHASE 往返全等（阶段/回合切换）', () => {
    const before = startGame(battleMap()).state;
    roundTrip(before, { intentType: 'SWITCH_PHASE' }, 1);
  });

  it('ADD_POINT 耗尽点数自动结束回合时往返全等', () => {
    const before = startGame(addPointMap()).state;
    expect(before.phase).toBe('ACTION');
    // 据点自动连兵 → 准备阶段发 1 点；先进加点阶段，再加 1 点耗尽点数
    const afterSwitch = act(before, 1, { intentType: 'SWITCH_PHASE' });
    expect(afterSwitch.ok).toBe(true);
    if (!afterSwitch.ok) return;
    roundTrip(afterSwitch.state, { intentType: 'ADD_POINT', coordinate: 0, amount: 1 }, 1);
  });

  it('SURRENDER 触发势力清除/胜利时往返全等', () => {
    const before = startGame(battleMap()).state;
    roundTrip(before, { intentType: 'SURRENDER', seat: 1, reason: 'voluntary' }, 1);
  });

  it('连续多条意图逆序应用后回到初始状态', () => {
    const initial = startGame(battleMap()).state;
    const diffs: ReturnType<typeof diffGameState>[] = [];
    let state = initial;

    const apply = (seat: number, intent: Parameters<typeof act>[2]): void => {
      const before = state;
      const result = act(state, seat, intent);
      if (!result.ok) throw new Error(`意图被拒：${result.reason}`);
      diffs.push(diffGameState(before, result.state));
      state = result.state;
    };

    apply(1, { intentType: 'SWITCH_PHASE' }); // ACTION → ADD_POINT
    apply(1, { intentType: 'SWITCH_PHASE' }); // ADD_POINT → 结束，轮到 seat2
    expect(state.currentSeat).toBe(2);
    apply(2, { intentType: 'SWITCH_PHASE' }); // seat2 ACTION → ADD_POINT

    let restored = state;
    for (const diff of [...diffs].reverse()) restored = applyInverseDiff(restored, diff);
    expect(stableStringify(restored)).toBe(stableStringify(initial));
  });

  it('被拒绝的意图不改变状态（调用方不应压栈）', () => {
    const before = startGame(battleMap()).state;
    const result = act(before, 2, { intentType: 'MOVE', from: 1, to: 2 });
    expect(result.ok).toBe(false);
  });
});
