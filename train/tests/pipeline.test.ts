// pipeline.test.ts — 阶段5：对局驱动、样本收集、拟合器、对局日志格式
import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { playSelfPlayGame } from '../lib/driver.js';
import type { TrainSample } from '../lib/driver.js';
import { fitWeights } from '../lib/fitter.js';
import { SEED_TE_WEIGHTS } from '../lib/eval.js';
import type { TeWeights } from '../lib/eval.js';
import { MapPool } from '../lib/pool.js';
import { generateTrainMap } from '../lib/mapgen.js';
import { TRAIN_PLAYER_IDS } from '../lib/driver.js';

describe('playSelfPlayGame（低预算冒烟）', () => {
  it('完整跑通一局：上限判平或分出胜负；样本双视角对称；日志三类行齐全', () => {
    const { map } = generateTrainMap('driver-test');
    const result = playSelfPlayGame(map, {
      weights: SEED_TE_WEIGHTS,
      mode: 'sample',
      temperature: 1,
      simulations: 6,
      maxTurns: 4,
      maxSteps: 60,
      seed: 'driver-test',
    });
    // 统计合理性
    expect(result.stats.turns).toBeGreaterThanOrEqual(1);
    expect(result.stats.turns).toBeLessThanOrEqual(5); // 4 回合上限后结束
    expect(result.stats.steps).toBeGreaterThan(0);
    expect(['victory', 'turn_cap', 'step_cap']).toContain(result.stats.reason);
    // 样本：每个势力回合 × 2 视角（偶数），特征有限值，标签合法
    expect(result.samples.length % 2).toBe(0);
    expect(result.samples.length).toBeGreaterThanOrEqual(2);
    for (const s of result.samples) {
      expect(s.features).toHaveLength(6);
      expect(s.features.every((f) => Number.isFinite(f))).toBe(true);
      expect([-1, 0, 1]).toContain(s.label);
      expect(s.dToEnd).toBeGreaterThanOrEqual(1);
      expect(s.area).toBe(map.row * map.column);
      expect(typeof s.late).toBe('boolean'); // 残局标记随样本收集
    }
    // 双视角对称：同一 gameId 每回合两个视角
    const viewers = new Set(result.samples.map((s) => s.seat));
    expect(viewers).toEqual(new Set([1, 2]));
    // 日志：首行 GAME_START、尾行 GAME_OVER、中间 INTENT_BROADCAST（eventId 从 1 递增）
    const first = result.log[0] as { type: string };
    const last = result.log[result.log.length - 1] as { type: string };
    expect(first.type).toBe('GAME_START');
    expect(last.type).toBe('GAME_OVER');
    const intents = result.log.filter((l) => (l as { type: string }).type === 'INTENT_BROADCAST') as Array<{
      eventId: number;
      from: string;
      fromSeat: number;
    }>;
    expect(intents.length).toBe(result.stats.steps);
    intents.forEach((m, i) => expect(m.eventId).toBe(i + 1));
    for (const m of intents) {
      expect(m.from).toBe(String(m.fromSeat === 1 ? TRAIN_PLAYER_IDS[1] : TRAIN_PLAYER_IDS[2]));
    }
    // GAME_OVER 字段（与 manager.ts 对齐）
    const over = last as unknown as { winners: string[]; winningTeam: number; forces: unknown[]; refId: string };
    expect(Array.isArray(over.winners)).toBe(true);
    expect(over.refId).toBe('end');
    expect(over.forces).toHaveLength(2);
  }, 120_000);

  it('上限判平时标签为 0', () => {
    const { map } = generateTrainMap('driver-draw');
    const result = playSelfPlayGame(map, {
      weights: SEED_TE_WEIGHTS,
      mode: 'argmax',
      simulations: 2,
      maxTurns: 1,
      maxSteps: 8,
      seed: 'driver-draw',
    });
    expect(result.stats.reason).not.toBe('victory');
    for (const s of result.samples) expect(s.label).toBe(0);
  }, 120_000);
});

describe('fitWeights（合成样本收敛方向）', () => {
  it('可分数据上排序损失下降，权重向区分方向移动', () => {
    // 构造：胜局样本 f1 高、负局样本 f1 低（其余为 0）；late=false → 更新中盘权重
    const mk = (label: number, f1: number, dToEnd: number): TrainSample => ({
      gameId: 'g',
      mapId: 'm',
      seat: 1,
      turn: 3,
      area: 150,
      features: [f1, 0, 0, 0, 0, 0],
      late: false,
      dToEnd,
      label,
    });
    const samples: TrainSample[] = [];
    for (let i = 0; i < 50; i++) {
      samples.push(mk(1, 5 + Math.random(), 3));
      samples.push(mk(-1, -5 - Math.random(), 3));
    }
    const rng = (() => {
      let x = 42;
      return () => {
        x = (x * 1103515245 + 12345) % 2147483648;
        return x / 2147483648;
      };
    })();
    const seed: TeWeights = { mid: [0.05, 2, -1, -0.5, 0.2, 100], late: [0.05, 2, -1, -0.5, 0.2, 100] };
    const { weights, report } = fitWeights(samples, seed, { steps: 3000, lr: 5e-4, l2: 1e-4, margin: 2, rng });
    // 中盘权重 f1 分量应增大到满足 margin（f1 区分胜负）；残局不应被动
    expect(weights.mid[0]).toBeGreaterThan(seed.mid[0] + 0.05);
    expect(weights.late).toEqual(seed.late);
    expect(report.lossAfter).toBeLessThanOrEqual(report.lossBefore + 1e-9);
    expect(report.pairsUsed).toBeGreaterThan(0);
  });

  it('无胜/负样本（全平）时返回种子权重', () => {
    const samples: TrainSample[] = [
      { gameId: 'g', mapId: 'm', seat: 1, turn: 3, area: 150, features: [0, 0, 0, 0, 0, 0], late: false, dToEnd: 1, label: 0 },
    ];
    const { weights, report } = fitWeights(samples, SEED_TE_WEIGHTS);
    expect(weights).toEqual(SEED_TE_WEIGHTS);
    expect(report.stepsRun).toBe(0);
  });

  it('旧批次样本（无 late 字段）回退纯 T 阈值：turn ≥ T 走残局权重', () => {
    // area=150 → T=6；turn=7 ≥ T → 残局（不带 late 字段，模拟升级前落盘的旧样本）
    const mk = (label: number, f1: number): TrainSample =>
      ({
        gameId: 'g',
        mapId: 'm',
        seat: 1,
        turn: 7,
        area: 150,
        features: [f1, 0, 0, 0, 0, 0],
        dToEnd: 1,
        label,
      }) as TrainSample;
    const samples: TrainSample[] = [];
    for (let i = 0; i < 50; i++) {
      samples.push(mk(1, 5 + Math.random()));
      samples.push(mk(-1, -5 - Math.random()));
    }
    const rng = (() => {
      let x = 7;
      return () => {
        x = (x * 1103515245 + 12345) % 2147483648;
        return x / 2147483648;
      };
    })();
    const seed: TeWeights = { mid: [0.05, 2, -1, -0.5, 0.2, 100], late: [0.05, 2, -1, -0.5, 0.2, 100] };
    const { weights, report } = fitWeights(samples, seed, { steps: 3000, lr: 5e-4, l2: 1e-4, margin: 2, rng });
    expect(weights.late[0]).toBeGreaterThan(seed.late[0] + 0.05); // 残局权重被更新
    expect(weights.mid).toEqual(seed.mid); // 中盘不动
    expect(report.pairsUsed).toBeGreaterThan(0);
  });
});

describe('MapPool（图池轮转）', () => {
  it('rotate 按序循环取图', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dl-pool-'));
    writeFileSync(path.join(dir, 'a.json'), JSON.stringify(generateTrainMap('a').map));
    writeFileSync(path.join(dir, 'b.json'), JSON.stringify(generateTrainMap('b').map));
    const pool = new MapPool(dir);
    expect(pool.size).toBe(2);
    const seq = [0, 1, 2, 3, 4].map((i) => pool.rotate(i).id);
    expect(seq).toEqual(['a', 'b', 'a', 'b', 'a']); // id 由文件名派生
  });

  it('空目录抛错', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dl-pool-empty-'));
    expect(() => new MapPool(dir)).toThrow();
  });
});

describe('权重存储', () => {
  it('版本递增与读取', async () => {
    const { WeightStore } = await import('../lib/weights.js');
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dl-w-'));
    const store = new WeightStore(dir);
    const seed = store.current();
    expect(seed.version).toBe(0);
    const next = store.next({ mid: [1, 2, 3, 4, 5, 6], late: [1, 2, 3, 4, 5, 6] }, 100, 'test');
    expect(next.version).toBe(1);
    expect(store.latest()!.version).toBe(1);
    expect(store.current().weights.mid[0]).toBe(1);
    expect(existsSync(path.join(dir, 'v1.json'))).toBe(true);
  });
});
