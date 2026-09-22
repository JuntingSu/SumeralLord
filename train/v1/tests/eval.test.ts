// eval.test.ts — 阶段1：权重表、T 阈值与打分入口
import { describe, expect, it } from 'vitest';
import { TERRAIN, initState } from '@dl/shared';
import { APE_WEIGHTS, SEED_TE_WEIGHTS, evalApe, evalTe, isLatePhase, phaseThreshold } from '../lib/eval.js';
import { apeFeatures, teFeatures } from '../lib/features.js';
import { extractBoard, hasSoldierContact } from '../lib/board.js';
import { generateTrainMap } from '../lib/mapgen.js';
import { lineState, makeSoldier, makeState } from './helpers.js';

const P = TERRAIN.PLAIN;
const C = TERRAIN.CITY;

describe('phaseThreshold', () => {
  it('T = ⌈log₂(面积/100)⌉ + 5', () => {
    expect(phaseThreshold(10, 10)).toBe(5); // 100 → 0+5
    expect(phaseThreshold(9, 11)).toBe(5); // 99 → ceil(−0.014)=0
    expect(phaseThreshold(15, 17)).toBe(7); // 255 → ceil(1.35)=2
    expect(phaseThreshold(10, 14)).toBe(6); // 140 → ceil(0.485)=1
  });
});

describe('残局判定（2026-09-20 新增接触判据）', () => {
  /** 1x7：t0 我城、t1/t2 我连兵、t3 敌连兵（邻 t2）、t4/t5 敌连兵、t6 敌城 → 双方接触；T(1x7)=2 */
  function contactLine(): ReturnType<typeof makeState> {
    return makeState({
      rows: 1,
      columns: 7,
      tiles: [
        { terrain: C, soldier: makeSoldier(1, 3, true) }, // 0 我城
        { terrain: P, soldier: makeSoldier(1, 2, true) }, // 1 我连兵
        { terrain: P, soldier: makeSoldier(1, 2, true) }, // 2 我连兵（邻敌）
        { terrain: P, soldier: makeSoldier(2, 2, true) }, // 3 敌连兵（邻我）
        { terrain: P, soldier: makeSoldier(2, 2, true) }, // 4 敌连兵
        { terrain: P, soldier: makeSoldier(2, 2, true) }, // 5 敌连兵
        { terrain: C, soldier: makeSoldier(2, 3, true) }, // 6 敌城
      ],
      turn: 1,
    });
  }

  /** 同尺寸无接触变体：敌兵整体后移，t2 邻空 t3（不邻敌） */
  function noContactLine(): ReturnType<typeof makeState> {
    return makeState({
      rows: 1,
      columns: 7,
      tiles: [
        { terrain: C, soldier: makeSoldier(1, 3, true) }, // 0 我城
        { terrain: P, soldier: makeSoldier(1, 2, true) }, // 1 我连兵
        { terrain: P, soldier: makeSoldier(1, 2, true) }, // 2 我连兵（邻空）
        { terrain: P }, // 3 空
        { terrain: P, soldier: makeSoldier(2, 2, true) }, // 4 敌连兵
        { terrain: P, soldier: makeSoldier(2, 2, true) }, // 5 敌连兵
        { terrain: C, soldier: makeSoldier(2, 3, true) }, // 6 敌城
      ],
      turn: 1,
    });
  }

  it('hasSoldierContact：距离 1 的异势力兵 → true；隔开 → false', () => {
    expect(hasSoldierContact(extractBoard(contactLine()))).toBe(true);
    expect(hasSoldierContact(extractBoard(noContactLine()))).toBe(false);
  });

  it('isLatePhase：接触（回合数 < T）判残局；无接触且回合数 < T 判前中期；回合数 ≥ T 判残局', () => {
    expect(phaseThreshold(1, 7)).toBe(2); // turn=1 < T
    expect(isLatePhase(contactLine())).toBe(true); // 接触 → 残局
    expect(isLatePhase(noContactLine())).toBe(false); // 无接触 + turn < T → 前中期
    expect(isLatePhase({ ...noContactLine(), turn: 2 })).toBe(true); // turn ≥ T → 残局
  });

  it('E_te：接触触发残局权重（中盘→残局）', () => {
    const w: typeof SEED_TE_WEIGHTS = { mid: [1, 0, 0, 0, 0, 0], late: [0, 1, 0, 0, 0, 0] };
    const contact = contactLine();
    const fC = teFeatures(contact, contact, 1);
    expect(evalTe(contact, contact, 1, w)).toBeCloseTo(fC[1], 10); // 残局权重 → 取 f2
    const noC = noContactLine();
    const fN = teFeatures(noC, noC, 1);
    expect(evalTe(noC, noC, 1, w)).toBeCloseTo(fN[0], 10); // 中盘权重 → 取 f1
  });

  it('E_ape：接触触发残局权重（前期→残局）', () => {
    const contact = contactLine();
    const fC = apeFeatures(contact, contact, 1);
    expect(evalApe(contact, contact, 1)).toBeCloseTo(
      APE_WEIGHTS.late.reduce((acc, w, i) => acc + w * fC[i], 0),
      10,
    );
    const noC = noContactLine();
    const fN = apeFeatures(noC, noC, 1);
    expect(evalApe(noC, noC, 1)).toBeCloseTo(
      APE_WEIGHTS.pre.reduce((acc, w, i) => acc + w * fN[i], 0),
      10,
    );
  });
});

function bigState(turn: number) {
  const rows = 15;
  const columns = 17;
  const tiles: Array<{ terrain: number; soldier?: ReturnType<typeof makeSoldier> | null }> = Array.from(
    { length: rows * columns },
    () => ({ terrain: P }),
  );
  tiles[0] = { terrain: TERRAIN.CITY, soldier: makeSoldier(1, 5, true) };
  tiles[1] = { terrain: P, soldier: makeSoldier(1, 3, true) };
  tiles[rows * columns - 1] = { terrain: TERRAIN.CITY, soldier: makeSoldier(2, 5, true) };
  tiles[rows * columns - 2] = { terrain: P, soldier: makeSoldier(2, 3, true) };
  return makeState({ rows, columns, tiles, turn });
}

describe('evalTe / evalApe', () => {
  it('E_te = Σ wᵢ·fᵢ，与特征点积一致', () => {
    const end = bigState(3);
    const start = bigState(3);
    const seat = 1;
    const f = teFeatures(end, start, seat);
    const manual = SEED_TE_WEIGHTS.mid.reduce((acc, w, i) => acc + w * f[i], 0);
    expect(evalTe(end, start, seat, SEED_TE_WEIGHTS)).toBeCloseTo(manual, 10);
  });

  it('回合数 < T 用中盘权重，≥ T 用残局权重', () => {
    const w: typeof SEED_TE_WEIGHTS = { mid: [1, 0, 0, 0, 0, 0], late: [0, 1, 0, 0, 0, 0] };
    const endEarly = bigState(6); // T=7
    const endLate = bigState(7);
    const vEarly = evalTe(endEarly, endEarly, 1, w);
    const vLate = evalTe(endLate, endLate, 1, w);
    const f = teFeatures(endEarly, endEarly, 1);
    expect(vEarly).toBeCloseTo(f[0], 10);
    expect(vLate).toBeCloseTo(teFeatures(endLate, endLate, 1)[1], 10);
  });

  it('E_ape = Σ wᵢ·fᵢ，前期/残局沿用 T', () => {
    const post = bigState(3);
    const start = bigState(3);
    const f = apeFeatures(post, start, 1);
    const manual = APE_WEIGHTS.pre.reduce((acc, w, i) => acc + w * f[i], 0);
    expect(evalApe(post, start, 1)).toBeCloseTo(manual, 10);

    const postLate = bigState(7);
    const fLate = apeFeatures(postLate, postLate, 1);
    expect(evalApe(postLate, postLate, 1)).toBeCloseTo(
      APE_WEIGHTS.late.reduce((acc, w, i) => acc + w * fLate[i], 0),
      10,
    );
  });

  it('种子权重自对弈冒烟：真实训练地图上 E_te/E_ape 可计算', () => {
    const { map } = generateTrainMap('eval-smoke');
    const { state } = initState({
      map,
      seatAssignments: [
        { seat: 1, playerId: 900001, isAI: false },
        { seat: 2, playerId: 900002, isAI: false },
      ],
      seed: 'eval-smoke',
      timeSettings: { stepTime: 30, gameTime: 600, additionalTime: 10 },
    });
    const v = evalTe(state, state, 1, SEED_TE_WEIGHTS);
    expect(Number.isFinite(v)).toBe(true);
    const a = evalApe(state, state, 1);
    expect(Number.isFinite(a)).toBe(true);
  });
});
