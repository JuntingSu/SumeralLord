import { describe, expect, it } from 'vitest';
import { applyIntent, initState } from '@dl/shared';
import type { BattlefieldTile, MapFullData, SeatAssignment } from '@dl/shared';
import { computeDimTiles, shouldAutoSkipPhase } from '../src/game/dim';

const TIME = { stepTime: 90, gameTime: 1200, additionalTime: 0 };
const ASG: SeatAssignment[] = [
  { seat: 1, playerId: 1, isAI: false },
  { seat: 2, playerId: 2, isAI: false },
];

/** 3×3：tile0 seat2 平原兵，tile4 seat1 兵，其余地形由参数决定 */
function makeMap(center: [number, number, number], others: number): MapFullData {
  const battlefield: BattlefieldTile[] = Array.from({ length: 9 }, (_, i) => {
    if (i === 0) return [0, 2, 2];
    if (i === 4) return center;
    return [others, 128, 0];
  });
  return {
    id: 'dim-test',
    version: 1,
    title: 'dim',
    description: '',
    author: 'test',
    timestamp: '2026-01-01 00:00:00.0',
    row: 3,
    column: 3,
    random_spawn: false,
    cylindrical_map: false,
    fog_mode: false,
    online_time_settings: { total_time: 600, round_time: 60, time_bonus: 0 },
    tags: [],
    player_num: 2,
    player_list: [
      { name: '红方', team: 1, computer: 255, seat: 1, flag: 1 },
      { name: '蓝方', team: 2, computer: 255, seat: 2, flag: 2 },
    ],
    battlefield,
  };
}

function start(map: MapFullData) {
  return initState({ map, seatAssignments: ASG, timeSettings: TIME, seed: 'dim-seed' }).state;
}

describe('shouldAutoSkipPhase：前端自动跳过判定', () => {
  it('行动阶段：存在未变灰的可动兵 → 不跳过', () => {
    // 中间平原兵四周平原（可移动）→ 白色，不跳过
    const state = start(makeMap([0, 1, 2], 0));
    expect(state.phase).toBe('ACTION');
    const dim = computeDimTiles(state, 1);
    expect(dim.has(4)).toBe(false);
    expect(shouldAutoSkipPhase(state, 1)).toBe(false);
  });

  it('行动阶段：1 兵力连兵无行动力 → 全部变灰 → 跳过', () => {
    // 据点兵力 1 连兵：准备阶段不发移动力，渲染为灰色
    const state = start(makeMap([1, 1, 1], 0));
    expect(computeDimTiles(state, 1).has(4)).toBe(true);
    expect(shouldAutoSkipPhase(state, 1)).toBe(true);
  });

  it('行动阶段：仍有行动力但四周全为全断地形（被围死）→ 渲染为灰 → 跳过', () => {
    // 中间据点兵有移动力，但六邻全是山地（FULL_BREAK）→ 条件4 变灰
    const state = start(makeMap([1, 1, 2], 4));
    const soldier = state.tiles[4].soldier!;
    expect(soldier.hasMovement).toBe(true);
    expect(computeDimTiles(state, 1).has(4)).toBe(true);
    expect(shouldAutoSkipPhase(state, 1)).toBe(true);
  });

  it('加点阶段：点数未耗尽不跳过；耗尽最后加点后跳过', () => {
    const state = start(makeMap([1, 1, 2], 0));
    const s1 = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: { intentType: 'SWITCH_PHASE' } });
    expect(s1.ok).toBe(true);
    if (!s1.ok) return;
    expect(s1.state.phase).toBe('ADD_POINT');
    const points = s1.state.forces.find((f) => f.seat === 1)!.points;
    expect(points).toBeGreaterThan(0);
    expect(shouldAutoSkipPhase(s1.state, 1)).toBe(false);
    // 一次加完所有点数 → reducer 只扣点、不自动结束阶段
    const s2 = applyIntent(s1.state, {
      actor: { kind: 'PLAYER', seat: 1 },
      intent: { intentType: 'ADD_POINT', coordinate: 4, amount: points },
    });
    expect(s2.ok).toBe(true);
    if (!s2.ok) return;
    expect(s2.chain.some((e) => e.kind === 'END_TURN')).toBe(false);
    expect(shouldAutoSkipPhase(s2.state, 1)).toBe(true);
  });

  it('非当前席位 / 已结束对局不跳过', () => {
    const state = start(makeMap([1, 1, 1], 0));
    expect(shouldAutoSkipPhase(state, 2)).toBe(false);
    expect(shouldAutoSkipPhase({ ...state, finished: true }, 1)).toBe(false);
  });
});
