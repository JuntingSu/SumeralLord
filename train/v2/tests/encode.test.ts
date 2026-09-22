// encode.test.ts — 状态编码：每格 token 与 CLS 全局特征
import { describe, expect, it } from 'vitest';
import { initState } from '@dl/shared';
import { CLS_FEATURES, TILE_FEATURES, encodeState, otherSeat } from '../lib/encode.js';
import { makeTestMap } from './helpers.js';

function freshState() {
  const map = makeTestMap(5, 5);
  const { state } = initState({
    map,
    seatAssignments: [
      { seat: 1, playerId: 900001, isAI: false },
      { seat: 2, playerId: 900002, isAI: false },
    ],
    seed: 'test',
    timeSettings: { stepTime: 30, gameTime: 600, additionalTime: 10 },
  });
  return state;
}

describe('状态编码（开局 seat1 行动）', () => {
  const s = freshState();
  const enc = encodeState(s);

  it('token 数量 = 格子数，维度正确', () => {
    expect(enc.tiles.length).toBe(25);
    expect(enc.tiles[0].length).toBe(TILE_FEATURES);
    expect(enc.cls.length).toBe(CLS_FEATURES);
  });

  it('据点格（seat1）：地形/兵力/归属/连断/移动力/反击', () => {
    const t = enc.tiles[0]; // (0,0) 据点 seat1 兵力 3
    expect(t[1]).toBe(1); // 地形 = 据点 one-hot
    expect(t[5]).toBe(3); // 兵力
    expect(t[7]).toBe(1); // 归属 = 我方
    expect(t[11]).toBe(1); // 连兵
    expect(t[12]).toBe(1); // 开局准备后有移动力
    expect(t[13]).toBe(2); // 据点反击 ∞ → 2
  });

  it('敌方据点格：归属 = 敌方', () => {
    const t = enc.tiles[24]; // (4,4) seat2
    expect(t[5]).toBe(4); // 兵力 4
    expect(t[8]).toBe(1); // 归属 = 敌方
  });

  it('空地格：地形 one-hot + 归属 = 空 + 其余归零', () => {
    const t = enc.tiles[1]; // (0,1) 空平原
    expect(t[0]).toBe(1); // 平原
    expect(t[6]).toBe(1); // 归属 = 空
    expect(t[5]).toBe(0);
    expect(t[11]).toBe(0);
    expect(t[12]).toBe(0);
    expect(t[13]).toBe(0);
  });

  it('CLS：回合/阶段/座次/双方兵力/连兵/据点/点数', () => {
    const v = enc.cls;
    expect(v[0]).toBe(1); // 回合 1
    expect(v[2]).toBe(1); // 阶段 = ACTION one-hot
    expect(v[5]).toBe(1); // 行动方座次
    expect(v[6]).toBe(3); // 我方总兵力
    expect(v[7]).toBe(4); // 敌方总兵力
    expect(v[8]).toBe(1); // 我方连兵数
    expect(v[9]).toBe(1); // 敌方连兵数
    expect(v[10]).toBe(1); // 我方据点数
    expect(v[11]).toBe(1); // 敌方据点数
    expect(v[12]).toBe(1); // 我方点数（准备阶段已发放 = 连兵数）
    expect(v[13]).toBe(0); // 敌方点数（敌方尚未轮到准备阶段，未发放）
  });

  it('otherSeat：1v1 视角对称', () => {
    expect(otherSeat(s, 1)).toBe(2);
    expect(otherSeat(s, 2)).toBe(1);
  });
});
