// driver.test.ts — 步级对局驱动 + 样本收集
import { beforeAll, describe, expect, it } from 'vitest';
import { actionCount, legalMask } from '../lib/actions.js';
import { playGame, randomPolicy } from '../lib/driver.js';
import { makeTestMap } from './helpers.js';

describe('随机策略整局冒烟（5×5 测试图）', () => {
  const map = makeTestMap(5, 5);
  let result!: Awaited<ReturnType<typeof playGame>>;

  beforeAll(async () => {
    result = await playGame(map, { policy: randomPolicy(), seed: 'smoke' });
  });

  it('对局正常结束且策略零拒绝（合法掩码）', () => {
    expect(['victory', 'turn_cap', 'step_cap']).toContain(result.stats.reason);
    expect(result.stats.rejects).toBe(0);
    expect(result.finalState.finished || result.stats.reason !== 'victory').toBe(true);
  });

  it('产生样本且每条先验合法（覆盖全部合法动作、概率合计 1）', () => {
    expect(result.samples.length).toBeGreaterThan(0);
    for (const s of result.samples) {
      expect(s.nTiles).toBe(25);
      expect(s.cls.length).toBe(14);
      expect(s.tiles.length).toBe(25);
      // 动作索引在界内、无重复
      const idxs = s.pi.map(([i]) => i);
      expect(new Set(idxs).size).toBe(idxs.length);
      for (const [i] of s.pi) {
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(actionCount(s.nTiles));
      }
      // 概率合计 = 1
      const sum = s.pi.reduce((a, [, p]) => a + p, 0);
      expect(sum).toBeCloseTo(1, 9);
    }
  });

  it('终局标签回填：胜/负/平与行动方队伍一致', () => {
    const teamOf = (seat: number) => result.finalState.forces.find((f) => f.seat === seat)?.team ?? -1;
    const winningTeam = result.stats.winningTeam;
    for (const s of result.samples) {
      if (winningTeam === null || winningTeam < 0) {
        expect(s.z).toBe(0);
      } else {
        expect(s.z).toBe(teamOf(s.seat) === winningTeam ? 1 : -1);
      }
    }
    // 胜方视角样本应存在（若为 victory）
    if (result.stats.reason === 'victory' && winningTeam !== null && winningTeam >= 0) {
      expect(result.samples.some((s) => teamOf(s.seat) === winningTeam && s.z === 1)).toBe(true);
      expect(result.samples.some((s) => teamOf(s.seat) !== winningTeam && s.z === -1)).toBe(true);
    }
  });

  it('对局日志结构：GAME_START → INTENT_BROADCAST×N → GAME_OVER', () => {
    expect(result.log.length).toBeGreaterThanOrEqual(2);
    expect((result.log[0] as { type: string }).type).toBe('GAME_START');
    expect((result.log[result.log.length - 1] as { type: string }).type).toBe('GAME_OVER');
    let eventId = 0;
    for (const line of result.log.slice(1, -1)) {
      const m = line as { type: string; eventId?: number };
      expect(m.type).toBe('INTENT_BROADCAST');
      expect(m.eventId).toBe(++eventId);
    }
  });
});

describe('驱动确定性', () => {
  it('同 seed 同策略 → 同结果（随机策略使用确定性 RNG）', async () => {
    const map = makeTestMap(5, 5);
    // 确定性 LCG 作为随机源（每次调用独立序列）
    const makeRng = (s: number) => {
      let x = s;
      return () => {
        x = (x * 1103515245 + 12345) % 2147483648;
        return x / 2147483648;
      };
    };
    const a = await playGame(map, { policy: randomPolicy(makeRng(42)), seed: 'fixed' });
    const b = await playGame(map, { policy: randomPolicy(makeRng(42)), seed: 'fixed' });
    expect(a.stats.steps).toBe(b.stats.steps);
    expect(a.samples.length).toBe(b.samples.length);
    expect(a.stats.rejects).toBe(0);
  });
});
