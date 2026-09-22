// demos.test.ts — 人工示范管线：demoToSample（重放/边界/容错）+ loadDemos + fitter 200 倍加权
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyIntent, initState } from '@dl/shared';
import type { GameStartMsg, GameState, PlayerIntent } from '@dl/shared';
import { playSelfPlayGame } from '../lib/driver.js';
import type { TrainSample } from '../lib/driver.js';
import { loadDemos, demoToSample } from '../lib/demos.js';
import type { DemoFile } from '../lib/demos.js';
import { generateTrainMap } from '../lib/mapgen.js';
import { SEED_TE_WEIGHTS } from '../lib/eval.js';
import type { TeWeights } from '../lib/eval.js';
import { fitWeights } from '../lib/fitter.js';

interface ParsedIntent {
  intent: PlayerIntent;
  fromSeat: number;
}

/** 解析对局日志（同 demos.ts 规则） */
function parseLog(log: object[]): { start: GameStartMsg; intents: ParsedIntent[] } {
  const start = log[0] as GameStartMsg;
  expect(start.type).toBe('GAME_START');
  const intents: ParsedIntent[] = [];
  for (const l of log.slice(1)) {
    const m = l as { type?: string; intent?: PlayerIntent; fromSeat?: number };
    if (m.type === 'INTENT_BROADCAST' && m.intent && typeof m.fromSeat === 'number') {
      intents.push({ intent: m.intent, fromSeat: m.fromSeat });
    }
  }
  return { start, intents };
}

/** 重放到第 n 条意图后的局面（独立复刻，用于校验边界语义） */
function replayState(log: object[], n: number): GameState {
  const { start, intents } = parseLog(log);
  const init = initState({
    map: start.map,
    seatAssignments: start.seatAssignments,
    timeSettings: start.timeSettings,
    seed: start.seed,
  }).state;
  let cur = init;
  const k = Math.max(0, Math.min(n, intents.length));
  for (let i = 0; i < k; i++) {
    const r = applyIntent(cur, { actor: { kind: 'PLAYER', seat: intents[i].fromSeat }, intent: intents[i].intent });
    if (r.ok) cur = r.state;
  }
  return cur;
}

/** 跑一局低预算自对弈，日志写入临时 logs 目录，返回定位信息 */
function writeTempLog(): { logsDir: string; log: object[]; gameId: string; mapId: string } {
  const { map } = generateTrainMap('demo-test');
  const result = playSelfPlayGame(map, {
    weights: SEED_TE_WEIGHTS,
    mode: 'sample',
    temperature: 1,
    simulations: 6,
    maxTurns: 4,
    maxSteps: 60,
    seed: 'demo-test',
  });
  const start = result.log[0] as { gameId: string; map: { id: string } };
  const logsDir = mkdtempSync(path.join(os.tmpdir(), 'dl-demos-logs-'));
  writeFileSync(path.join(logsDir, 'game-000000.jsonl'), result.log.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { logsDir, log: result.log, gameId: start.gameId, mapId: start.map.id };
}

function mkDemo(partial: Partial<DemoFile>): DemoFile {
  return {
    id: 'demo-test',
    createdAt: '2026-09-21T00:00:00.000Z',
    sourceGameId: '',
    seat: 1,
    turnStartEventId: 0,
    startEventId: 0,
    intents: [],
    note: 'test',
    ...partial,
  };
}

/** 1 号势力开局起的连续 MOVE/ATTACK 意图（演示仅支持行动阶段操作） */
function seat1OpeningIntents(intents: ParsedIntent[]): PlayerIntent[] {
  const out: PlayerIntent[] = [];
  for (const it of intents) {
    if (it.fromSeat !== 1) break;
    if (it.intent.intentType !== 'MOVE' && it.intent.intentType !== 'ATTACK') break;
    out.push(it.intent);
  }
  return out;
}

describe('demoToSample（示范 → 200 倍权重胜样本）', () => {
  it('主流程：源日志重放 + 应用示范意图 → 6 维特征、label=+1、weight=200、dToEnd=1', () => {
    const { logsDir, log, gameId, mapId } = writeTempLog();
    const { intents } = parseLog(log);
    const demoIntents = seat1OpeningIntents(intents);
    expect(demoIntents.length).toBeGreaterThan(0);

    const demo = mkDemo({ sourceGameId: gameId, seat: 1, turnStartEventId: 0, startEventId: 0, intents: demoIntents });
    const s = demoToSample(demo, logsDir);
    expect(s).not.toBeNull();
    expect(s!.features).toHaveLength(6);
    expect(s!.features.every((f) => Number.isFinite(f))).toBe(true);
    expect(s!.label).toBe(1);
    expect(s!.weight).toBe(200);
    expect(s!.dToEnd).toBe(1);
    expect(s!.seat).toBe(1);
    expect(s!.mapId).toBe(mapId);
    expect(typeof s!.late).toBe('boolean');
    // 操作后局面的回合号应与真实对局同步
    const after = replayState(log, 0 + demoIntents.length);
    expect(s!.turn).toBe(after.turn);
  });

  it('回合边界：turnStartEventId 指向 2 号势力首回合起点（其第一条意图的事件 id）', () => {
    const { logsDir, log, gameId } = writeTempLog();
    const { intents } = parseLog(log);
    const i2 = intents.findIndex((it) => it.fromSeat === 2);
    expect(i2).toBeGreaterThan(0);
    // 独立校验：重放到 i2 条意图后应处于 2 号势力 ACTION 相位
    const st = replayState(log, i2);
    expect(st.currentSeat).toBe(2);
    expect(st.phase).toBe('ACTION');

    const demo = mkDemo({ sourceGameId: gameId, seat: 2, turnStartEventId: i2, startEventId: i2, intents: [intents[i2].intent] });
    const s = demoToSample(demo, logsDir);
    expect(s).not.toBeNull();
    expect(s!.seat).toBe(2);
    expect(s!.weight).toBe(200);
  });

  it('意图被拒（空格发起 ATTACK）→ 整个示范跳过返回 null', () => {
    const { logsDir, log, gameId } = writeTempLog();
    const init = replayState(log, 0);
    const emptyTile = init.tiles.findIndex((t) => !t.soldier);
    expect(emptyTile).toBeGreaterThanOrEqual(0);
    const demo = mkDemo({
      sourceGameId: gameId,
      seat: 1,
      turnStartEventId: 0,
      startEventId: 0,
      intents: [{ intentType: 'ATTACK', from: emptyTile, to: 0 }],
    });
    expect(demoToSample(demo, logsDir)).toBeNull();
  });

  it('源日志缺失 → null', () => {
    const { logsDir } = writeTempLog();
    const demo = mkDemo({ sourceGameId: 'missing-game', seat: 1, turnStartEventId: 0, startEventId: 0, intents: [] });
    expect(demoToSample(demo, logsDir)).toBeNull();
  });

  it('回合初局面不一致（turnStartEventId 指向他人回合）→ null', () => {
    const { logsDir, log, gameId } = writeTempLog();
    const { intents } = parseLog(log);
    const i2 = intents.findIndex((it) => it.fromSeat === 2);
    const first = seat1OpeningIntents(intents);
    const demo = mkDemo({
      sourceGameId: gameId,
      seat: 1,
      turnStartEventId: i2, // 指向 2 号势力回合 → 校验失败
      startEventId: 0,
      intents: [first[0]],
    });
    expect(demoToSample(demo, logsDir)).toBeNull();
  });

  it('演示起点在他人回合（startEventId 指向 2 号势力）→ null', () => {
    const { logsDir, log, gameId } = writeTempLog();
    const { intents } = parseLog(log);
    const i2 = intents.findIndex((it) => it.fromSeat === 2);
    const demo = mkDemo({
      sourceGameId: gameId,
      seat: 1,
      turnStartEventId: 0,
      startEventId: i2, // 起点在 2 号势力回合 → 校验失败
      intents: [],
    });
    expect(demoToSample(demo, logsDir)).toBeNull();
  });

  it('加点阶段起步：startEventId 停在 ADD_POINT 相位 → 样本有效', () => {
    const { logsDir, log, gameId } = writeTempLog();
    const { intents } = parseLog(log);
    // 1 号势力首条 ADD_POINT 意图应用前的局面即其加点阶段（可能经显式 SWITCH_PHASE 或 autoSkip 进入）
    const firstAdd = intents.findIndex((it) => it.fromSeat === 1 && it.intent.intentType === 'ADD_POINT');
    expect(firstAdd).toBeGreaterThan(0);
    const st = replayState(log, firstAdd);
    expect(st.currentSeat).toBe(1);
    expect(st.phase).toBe('ADD_POINT');

    const demo = mkDemo({
      sourceGameId: gameId,
      seat: 1,
      turnStartEventId: 0,
      startEventId: firstAdd,
      intents: [intents[firstAdd].intent],
    });
    const s = demoToSample(demo, logsDir);
    expect(s).not.toBeNull();
    expect(s!.seat).toBe(1);
    expect(s!.label).toBe(1);
    expect(s!.weight).toBe(200);
  });

  it('跨相位意图序列：从开局连续应用到首次加点（含 ADD_POINT）→ 样本有效', () => {
    const { logsDir, log, gameId } = writeTempLog();
    const { intents } = parseLog(log);
    // 1 号势力从开局到首次加点的完整意图序列（行动→加点；是否含显式 SWITCH_PHASE 取决于 autoSkip）
    const seq: PlayerIntent[] = [];
    for (const it of intents) {
      if (it.fromSeat !== 1) break;
      seq.push(it.intent);
      if (it.intent.intentType === 'ADD_POINT') break;
    }
    expect(seq.length).toBeGreaterThan(1);
    expect(seq.some((i) => i.intentType === 'ADD_POINT')).toBe(true);

    const demo = mkDemo({ sourceGameId: gameId, seat: 1, turnStartEventId: 0, startEventId: 0, intents: seq });
    const s = demoToSample(demo, logsDir);
    expect(s).not.toBeNull();
    expect(s!.seat).toBe(1);
    expect(s!.features).toHaveLength(6);
    expect(s!.features.every((f) => Number.isFinite(f))).toBe(true);
  });

  it('示范含显式 SWITCH_PHASE 意图：行动中切换 → 加点 → 样本有效', () => {
    const { logsDir, log, gameId } = writeTempLog();
    const { intents } = parseLog(log);
    // 优先取真实轨迹中的显式 SWITCH→ADD_POINT 连续段（1 号势力）
    let swIdx = -1;
    for (let i = 0; i + 1 < intents.length; i++) {
      if (
        intents[i].fromSeat === 1 &&
        intents[i].intent.intentType === 'SWITCH_PHASE' &&
        intents[i + 1].fromSeat === 1 &&
        intents[i + 1].intent.intentType === 'ADD_POINT'
      ) {
        swIdx = i;
        break;
      }
    }
    let startEventId: number;
    let demoIntents: PlayerIntent[];
    if (swIdx >= 0) {
      // 轨迹自带显式切换：示范 = [SWITCH_PHASE, ADD_POINT]（沿真实轨迹必然合法）
      startEventId = swIdx;
      demoIntents = [intents[swIdx].intent, intents[swIdx + 1].intent];
    } else {
      // 轨迹全为 reducer 自动跳阶段：沿真实轨迹推进到首个 ADD_POINT，需要时补 SWITCH_PHASE
      let cur = replayState(log, 0);
      startEventId = 0;
      const firstAdd = intents.findIndex((it) => it.fromSeat === 1 && it.intent.intentType === 'ADD_POINT');
      expect(firstAdd).toBeGreaterThan(0);
      demoIntents = [];
      for (let i = 0; i <= firstAdd; i++) {
        const it = intents[i];
        if (it.fromSeat !== 1) break;
        if (cur.phase === 'ACTION' && it.intent.intentType === 'ADD_POINT') {
          demoIntents.push({ intentType: 'SWITCH_PHASE' });
          const r = applyIntent(cur, { actor: { kind: 'PLAYER', seat: 1 }, intent: { intentType: 'SWITCH_PHASE' } });
          if (!r.ok) break;
          cur = r.state;
        }
        const r = applyIntent(cur, { actor: { kind: 'PLAYER', seat: it.fromSeat }, intent: it.intent });
        if (!r.ok) break;
        cur = r.state;
        demoIntents.push(it.intent);
      }
    }
    expect(demoIntents.length).toBeGreaterThan(1);
    if (swIdx >= 0) expect(demoIntents.some((i) => i.intentType === 'SWITCH_PHASE')).toBe(true);

    const demo = mkDemo({
      sourceGameId: gameId,
      seat: 1,
      turnStartEventId: 0,
      startEventId,
      intents: demoIntents,
    });
    const s = demoToSample(demo, logsDir);
    expect(s).not.toBeNull();
    expect(s!.seat).toBe(1);
  });
});

describe('loadDemos（目录扫描与字段校验）', () => {
  it('合法文件载入、缺字段文件跳过、非 json 后缀忽略', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'dl-demos-'));
    writeFileSync(
      path.join(dir, 'demo-1.json'),
      JSON.stringify(mkDemo({ id: 'demo-1', sourceGameId: 'g1', intents: [{ intentType: 'MOVE', from: 1, to: 2 }] })),
    );
    writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ id: 'bad' })); // 缺字段
    writeFileSync(path.join(dir, 'junk.txt'), 'not json'); // 后缀不匹配
    const demos = loadDemos(dir);
    expect(demos).toHaveLength(1);
    expect(demos[0].id).toBe('demo-1');
    expect(demos[0].intents).toHaveLength(1);
  });

  it('目录不存在返回空数组', () => {
    expect(loadDemos(path.join(os.tmpdir(), 'no-such-demos-dir'))).toEqual([]);
  });
});

describe('fitWeights（示范样本 200 倍加权）', () => {
  it('同样本集仅 weight 不同（1 vs 200）、同 rng：weight=200 时 mid[0] 移动量显著更大', () => {
    const mk = (label: number, f1: number, dToEnd: number, weight?: number): TrainSample => ({
      gameId: 'g',
      mapId: 'm',
      seat: 1,
      turn: 3,
      area: 150,
      features: [f1, 0, 0, 0, 0, 0],
      late: false,
      dToEnd,
      label,
      ...(weight !== undefined ? { weight } : {}),
    });
    const base: TrainSample[] = [];
    for (let i = 0; i < 50; i++) {
      base.push(mk(1, 5 + Math.random(), 3));
      base.push(mk(-1, -5 - Math.random(), 3));
    }
    // 示范样本：低 f1 的胜样本（dToEnd=1），仅靠 weight 放大其梯度贡献。
    // margin 取 100：mid[0] 移动全程不越过间隔 → 更新不饱和，权重差可稳定对比。
    const demoBase = mk(1, 0.1, 1);
    const mkRng = () => {
      let x = 42;
      return () => {
        x = (x * 1103515245 + 12345) % 2147483648;
        return x / 2147483648;
      };
    };
    const seed: TeWeights = { mid: [0.05, 2, -1, -0.5, 0.2, 100], late: [0.05, 2, -1, -0.5, 0.2, 100] };
    const opts = { steps: 1000, lr: 5e-4, l2: 1e-4, margin: 100 };
    const r1 = fitWeights([...base, { ...demoBase }], seed, { ...opts, rng: mkRng() });
    const r200 = fitWeights([...base, { ...demoBase, weight: 200 }], seed, { ...opts, rng: mkRng() });
    expect(r1.report.pairsUsed).toBeGreaterThan(0);
    expect(r200.report.pairsUsed).toBeGreaterThan(0);
    const d1 = Math.abs(r1.weights.mid[0] - seed.mid[0]);
    const d200 = Math.abs(r200.weights.mid[0] - seed.mid[0]);
    expect(d200).toBeGreaterThan(d1 * 5); // 200 倍权重显著放大梯度（理论比约 10 倍）
    // 排序损失诊断同样按 weight 缩放（示范对：200/d² ≈ 200 vs 普通对 ≈ 0.22）
    expect(r200.report.lossBefore).toBeGreaterThan(r1.report.lossBefore * 5);
  });
});
