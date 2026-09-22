// annotations.test.ts — 标注转换：intent→action 逆映射 / demo / 偏好（局面题/走法题）
import { describe, expect, it } from 'vitest';
import { applyIntent } from '@dl/shared';
import { actionToIntent, intentToAction, legalActionList } from '../lib/actions.js';
import type { DemoFile, PrefFile } from '../lib/annotation-types.js';
import { actionPrefToSample, demoToSamples, positionPrefToSample } from '../lib/annotations.js';
import { playGame, randomPolicy } from '../lib/driver.js';
import { replayTo, type ParsedLog } from '../lib/logs.js';
import { makeTestMap } from './helpers.js';

/** 用随机对局在内存构造 ParsedLog */
async function makeLog(): Promise<ParsedLog> {
  const map = makeTestMap(5, 5);
  const result = await playGame(map, { policy: randomPolicy(), seed: 'ann-' + Math.random() });
  const start = result.log[0] as ParsedLog['start'];
  const intents = result.log
    .slice(1, -1)
    .map((m) => {
      const x = m as { intent?: unknown; fromSeat?: number };
      return { intent: x.intent as never, fromSeat: x.fromSeat ?? 0 };
    });
  return { gameId: result.stats.gameId, mapId: result.stats.mapId, start, intents };
}

/** 找一个事件号：该位置行动方为 seat 且处于决策相位 */
function findDecisionEvent(log: ParsedLog, seat: number, from = 0): number {
  for (let i = from; i < log.intents.length; i++) {
    const s = replayTo(log, i);
    if (s.currentSeat === seat && (s.phase === 'ACTION' || s.phase === 'ADD_POINT')) return i;
  }
  return -1;
}

describe('intentToAction 逆映射', () => {
  it('MOVE/ATTACK 映射到同一索引；与 actionToIntent 往返一致', async () => {
    const log = await makeLog();
    const ev = findDecisionEvent(log, 1);
    const state = replayTo(log, ev);
    const legal = legalActionList(state);
    const idx = legal[0];
    const intent = actionToIntent(state, idx);
    expect(intentToAction(state, intent)).toBe(idx);
  });

  it('ADD_POINT / SWITCH_PHASE 映射正确', async () => {
    const log = await makeLog();
    for (let i = 0; i < log.intents.length; i++) {
      const s = replayTo(log, i);
      if (s.phase !== 'ADD_POINT') continue;
      const legal = legalActionList(s);
      for (const idx of legal.slice(0, 5)) {
        expect(intentToAction(s, actionToIntent(s, idx))).toBe(idx);
      }
      expect(intentToAction(s, { intentType: 'SWITCH_PHASE' })).toBe(legalActionList(s).at(-1));
      break;
    }
  });

  it('非法映射返回 null（非邻格、金额越界）', async () => {
    const log = await makeLog();
    const state = replayTo(log, 0);
    expect(intentToAction(state, { intentType: 'MOVE', from: 0, to: 24 })).toBeNull();
    expect(intentToAction(state, { intentType: 'ADD_POINT', coordinate: 0, amount: 33 })).toBeNull();
  });
});

describe('demoToSamples', () => {
  it('演示意图序列 → 每步一条 one-hot 样本', async () => {
    const log = await makeLog();
    const ev = findDecisionEvent(log, 1);
    expect(ev).toBeGreaterThanOrEqual(0);
    const start = replayTo(log, ev);
    // 取两个合法动作作为演示（第二个从应用第一个后的局面取，保证合法）
    const legal = legalActionList(start);
    const intents = [actionToIntent(start, legal[0])];
    const r = applyIntent(start, { actor: { kind: 'PLAYER', seat: 1 }, intent: intents[0] });
    expect(r.ok).toBe(true);
    const legal2 = legalActionList(r.state);
    if (legal2.length > 0) intents.push(actionToIntent(r.state, legal2[0]));
    const demo: DemoFile = {
      id: 'demo-test',
      kind: 'demo',
      sourceGameId: log.gameId,
      seat: 1,
      turnStartEventId: 0,
      startEventId: ev,
      intents,
    };
    const samples = demoToSamples(demo, log);
    expect(samples).not.toBeNull();
    expect(samples!.length).toBe(intents.length);
    for (const s of samples!) {
      expect(s.seat).toBe(1);
      expect(s.z).toBe(0);
      const sum = s.pi.reduce((a, [, p]) => a + p, 0);
      expect(sum).toBeCloseTo(1, 9);
      const ones = s.pi.filter(([, p]) => p > 0);
      expect(ones.length).toBe(1); // one-hot
    }
  });

  it('日志缺失/空演示/越出己方回合 → null', async () => {
    const log = await makeLog();
    const demo: DemoFile = {
      id: 'demo-bad',
      kind: 'demo',
      sourceGameId: 'no-such-game',
      seat: 1,
      turnStartEventId: 0,
      startEventId: 0,
      intents: [],
    };
    // 空演示 → null（out.length === 0）
    const empty = demoToSamples({ ...demo, sourceGameId: log.gameId }, log);
    expect(empty).toBeNull();
    // 超范围 startEventId：裁剪到结尾（终局），演示意图因回合不符 → null
    const bad = demoToSamples(
      {
        ...demo,
        sourceGameId: log.gameId,
        startEventId: 99999,
        intents: [{ intentType: 'SWITCH_PHASE' }],
      },
      log,
    );
    expect(bad).toBeNull();
  });
});

describe('偏好转换', () => {
  it('局面题：两侧重放 + 编码 + 视角座次', async () => {
    const logA = await makeLog();
    const logB = await makeLog();
    const evA = findDecisionEvent(logA, 1, 1);
    const evB = findDecisionEvent(logB, 1, 1);
    const pref: PrefFile = {
      id: 'pref-test',
      kind: 'position',
      a: { sourceGameId: logA.gameId, eventId: evA, seat: 1 },
      b: { sourceGameId: logB.gameId, eventId: evB, seat: 1 },
      label: 'a',
    };
    const sample = positionPrefToSample(pref, logA, logB);
    expect(sample).not.toBeNull();
    expect(sample!.label).toBe('a');
    expect(sample!.a.seat).toBe(1);
    expect(sample!.a.tiles.length).toBe(25);
    expect(sample!.b.tiles.length).toBe(25);
    // unknown 作废
    const unknown = positionPrefToSample({ ...pref, label: 'unknown' }, logA, logB);
    expect(unknown).toBeNull();
  });

  it('走法题：apply A/B 得后继局面', async () => {
    const log = await makeLog();
    const ev = findDecisionEvent(log, 1);
    const base = replayTo(log, ev);
    const legal = legalActionList(base);
    const [a, b] = [legal[0], legal[Math.min(1, legal.length - 1)]];
    const pref: PrefFile = {
      id: 'pref-action-test',
      kind: 'action',
      sourceGameId: log.gameId,
      eventId: ev,
      seat: 1,
      actionA: actionToIntent(base, a),
      actionB: actionToIntent(base, b),
      label: 'both_bad',
    };
    const sample = actionPrefToSample(pref, log);
    expect(sample).not.toBeNull();
    expect(sample!.label).toBe('both_bad');
    expect(sample!.a.tiles.length).toBe(25);
    expect(sample!.b.tiles.length).toBe(25);
  });
});
