// eval.test.ts — 阶段1：权重表、T 阈值与打分入口
import { describe, expect, it } from 'vitest';
import { TERRAIN, initState } from '@dl/shared';
import { APE_WEIGHTS, SEED_TE_WEIGHTS, evalApe, evalTe, phaseThreshold } from '../lib/eval.js';
import { apeFeatures, teFeatures } from '../lib/features.js';
import { generateTrainMap } from '../lib/mapgen.js';
import { lineState, makeSoldier, makeState } from './helpers.js';

const P = TERRAIN.PLAIN;

describe('phaseThreshold', () => {
  it('T = ⌈log₂(面积/100)⌉ + 5', () => {
    expect(phaseThreshold(10, 10)).toBe(5); // 100 → 0+5
    expect(phaseThreshold(9, 11)).toBe(5); // 99 → ceil(−0.014)=0
    expect(phaseThreshold(15, 17)).toBe(7); // 255 → ceil(1.35)=2
    expect(phaseThreshold(10, 14)).toBe(6); // 140 → ceil(0.485)=1
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
