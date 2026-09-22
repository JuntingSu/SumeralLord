// sampler.test.ts — 偏好题抽样器：同图/同视角配对、近回合优先、去重
import { describe, expect, it } from 'vitest';
import { samplePositionQuestions } from '../lib/sampler.js';
import { playGame, randomPolicy } from '../lib/driver.js';
import { type ParsedLog } from '../lib/logs.js';
import { makeTestMap } from './helpers.js';

async function makeLogs(n: number, seedBase: number): Promise<ParsedLog[]> {
  const map = makeTestMap(5, 5);
  const logs: ParsedLog[] = [];
  for (let i = 0; i < n; i++) {
    const result = await playGame(map, { policy: randomPolicy(), seed: `samp-${seedBase}-${i}` });
    logs.push({
      gameId: result.stats.gameId,
      mapId: result.stats.mapId,
      start: result.log[0] as ParsedLog['start'],
      intents: result.log
        .slice(1, -1)
        .map((m) => {
          const x = m as { intent?: unknown; fromSeat?: number };
          return { intent: x.intent as never, fromSeat: x.fromSeat ?? 0 };
        }),
    });
  }
  return logs;
}

describe('samplePositionQuestions', () => {
  it('同图两局同视角配对：a/b 同 mapId 同 seat', async () => {
    const logs = await makeLogs(3, 1);
    const questions = samplePositionQuestions(logs, { numPositionQuestions: 10, numActionQuestions: 0 });
    expect(questions.length).toBeGreaterThan(0);
    for (const q of questions) {
      expect(q.kind).toBe('position');
      if (q.kind === 'position') {
        // 同图：a/b 的源局 mapId 相同（通过源日志查证）
        const la = logs.find((l) => l.gameId === q.a.sourceGameId)!;
        const lb = logs.find((l) => l.gameId === q.b.sourceGameId)!;
        expect(la.mapId).toBe(lb.mapId);
        expect(q.a.seat).toBe(q.b.seat); // 同视角
        // 不同局
        expect(q.a.sourceGameId).not.toBe(q.b.sourceGameId);
      }
    }
  });

  it('确定性：同输入同参数 → 同题目集合', () => {
    void makeLogs(2, 2).then((logs) => {
      const a = samplePositionQuestions(logs, { numPositionQuestions: 5, numActionQuestions: 0 });
      const b = samplePositionQuestions(logs, { numPositionQuestions: 5, numActionQuestions: 0 });
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });
  });

  it('去重：同一局面最多被抽 maxDrawsPerPosition 次', async () => {
    const logs = await makeLogs(2, 3);
    const questions = samplePositionQuestions(logs, {
      numPositionQuestions: 100, // 请求大量，触发去重
      numActionQuestions: 0,
      maxDrawsPerPosition: 2,
    });
    const draws = new Map<string, number>();
    for (const q of questions) {
      if (q.kind !== 'position') continue;
      for (const side of [q.a, q.b]) {
        const key = `${side.sourceGameId}@${side.eventId}`;
        draws.set(key, (draws.get(key) ?? 0) + 1);
      }
    }
    for (const n of draws.values()) {
      expect(n).toBeLessThanOrEqual(2);
    }
  });
});
