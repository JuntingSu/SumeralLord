// actions.test.ts — 动作空间索引、合法掩码、掩码↔reducer 对拍
import { describe, expect, it } from 'vitest';
import { applyIntent, initState, neighborsOf } from '@dl/shared';
import type { GameState } from '@dl/shared';
import {
  ACTIONS_PER_TILE,
  ADD_AMOUNT_MAX,
  actionCount,
  actionToIntent,
  addActionIndex,
  dirActionIndex,
  legalActionList,
  legalMask,
  switchActionIndex,
} from '../lib/actions.js';
import { makeTestMap } from './helpers.js';

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

describe('动作索引', () => {
  it('布局：每格 38 = 6 方向 + 32 加点，末尾全局切换', () => {
    expect(ACTIONS_PER_TILE).toBe(38);
    expect(ADD_AMOUNT_MAX).toBe(32);
    expect(actionCount(25)).toBe(25 * 38 + 1);
    expect(switchActionIndex(25)).toBe(25 * 38);
    expect(dirActionIndex(0, 0)).toBe(0);
    expect(dirActionIndex(0, 5)).toBe(5);
    expect(dirActionIndex(1, 0)).toBe(38);
    expect(addActionIndex(0, 1)).toBe(6);
    expect(addActionIndex(0, 32)).toBe(37);
    expect(addActionIndex(1, 1)).toBe(38 + 6);
  });

  it('actionToIntent 往返：方向/加点/切换', () => {
    const s = freshState();
    const geo = { rows: s.rows, columns: s.columns, cylindrical: s.cylindrical };
    // 方向 0 的格子 (0,0) → 目标 = 邻居表第 0 个
    const tile00 = 0;
    const nb = neighborsOf(tile00, geo)[0];
    expect(actionToIntent(s, dirActionIndex(tile00, 0))).toEqual({
      intentType: 'MOVE',
      from: tile00,
      to: nb,
    });
    expect(actionToIntent(s, addActionIndex(3, 17))).toEqual({
      intentType: 'ADD_POINT',
      coordinate: 3,
      amount: 17,
    });
    expect(actionToIntent(s, switchActionIndex(25))).toEqual({ intentType: 'SWITCH_PHASE' });
  });
});

describe('行动阶段掩码（开局 seat1）', () => {
  const s = freshState();
  const mask = legalMask(s);

  it('开局处于 ACTION 阶段且行动方为 seat1', () => {
    expect(s.phase).toBe('ACTION');
    expect(s.currentSeat).toBe(1);
  });

  it('据点兵（连兵，有移动力）的方向动作合法，其余格不合法', () => {
    const tile00 = 0;
    // (0,0) 为偶数行角落：邻居表下只有 2 个在界内方向（dir 0 与 dir 4）
    const legalDirs: number[] = [];
    for (let d = 0; d < 6; d++) {
      if (mask[dirActionIndex(tile00, d)] === 1) legalDirs.push(d);
    }
    expect(legalDirs.length).toBe(2);
    for (let d = 0; d < 6; d++) {
      expect(mask[dirActionIndex(tile00, d)]).toBe(legalDirs.includes(d) ? 1 : 0);
    }
  });

  it('敌方兵没有可行动作（不在行动方视角）', () => {
    const tileEnemy = 24; // (4,4) seat2 据点
    for (let d = 0; d < 6; d++) expect(mask[dirActionIndex(tileEnemy, d)]).toBe(0);
  });

  it('空地与加点动作在行动阶段全部非法', () => {
    for (let t = 0; t < 25; t++) {
      for (let amt = 1; amt <= ADD_AMOUNT_MAX; amt++) {
        expect(mask[addActionIndex(t, amt)]).toBe(0);
      }
    }
    // 无兵格的方向动作非法
    expect(mask[dirActionIndex(1, 0)]).toBe(0);
  });

  it('切换阶段恒合法', () => {
    expect(mask[switchActionIndex(25)]).toBe(1);
  });

  it('掩码↔reducer 对拍：全部合法动作被 applyIntent 接受', () => {
    for (const idx of legalActionList(s)) {
      const r = applyIntent(s, { actor: { kind: 'PLAYER', seat: 1 }, intent: actionToIntent(s, idx) });
      expect(r.ok, `action ${idx} 应合法: ${JSON.stringify(actionToIntent(s, idx))}`).toBe(true);
    }
  });
});

describe('加点阶段掩码', () => {
  const s = freshState();
  // seat1 开局 1 个连兵 → 点数 = 1；切换进加点阶段
  const r = applyIntent(s, { actor: { kind: 'PLAYER', seat: 1 }, intent: { intentType: 'SWITCH_PHASE' } });
  if (!r.ok) throw new Error('switch failed');
  const addState = r.state;
  const mask = legalMask(addState);

  it('进入 ADD_POINT 阶段', () => {
    expect(addState.phase).toBe('ADD_POINT');
    expect(addState.currentSeat).toBe(1);
  });

  it('连兵 + 点数充足 → 加点合法（点数 1 → 仅 +1 档）', () => {
    expect(addState.forces.find((f) => f.seat === 1)?.points).toBe(1);
    expect(mask[addActionIndex(0, 1)]).toBe(1);
    expect(mask[addActionIndex(0, 2)]).toBe(0); // 超出剩余点数
  });

  it('加点阶段方向动作全部非法，切换合法', () => {
    for (let t = 0; t < 25; t++) {
      for (let d = 0; d < 6; d++) expect(mask[dirActionIndex(t, d)]).toBe(0);
    }
    expect(mask[switchActionIndex(25)]).toBe(1);
  });

  it('掩码↔reducer 对拍：全部合法加点被接受', () => {
    for (const idx of legalActionList(addState)) {
      const rr = applyIntent(addState, { actor: { kind: 'PLAYER', seat: 1 }, intent: actionToIntent(addState, idx) });
      expect(rr.ok, `action ${idx} 应合法`).toBe(true);
    }
  });
});
