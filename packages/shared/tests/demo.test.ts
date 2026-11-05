// 演示模式规则与回放文件契约
import { describe, it, expect } from 'vitest';
import { initState, reducerVersion } from '../src/index.js';
import type { DemoReplayFile, MapFullData } from '../src/index.js';
import { validateDemoReplayFile } from '../src/index.js';
import {
  DEFAULT_TIME,
  CITY,
  PLAIN,
  assignments,
  act,
  force,
  makeMap,
  soldierAt,
} from './helpers.js';

const ASG = assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: 102 });

function demoGame(map: MapFullData) {
  return initState({
    map,
    seatAssignments: ASG,
    timeSettings: DEFAULT_TIME,
    seed: 'demo-seed',
    demo: { infinitePoints: true, noVictory: true },
  });
}

const pointMap = () => makeMap({ tiles: { 6: [CITY, 1, 2], 7: [PLAIN, 1, 3], 12: [CITY, 2, 2] } });

describe('演示规则：无限加点', () => {
  it('0 点数仍可加点，且点数不减少', () => {
    const { state } = demoGame(pointMap());
    const zeroed = structuredClone(state);
    force(zeroed, 1).points = 0;
    const phase = act(zeroed, 1, { intentType: 'SWITCH_PHASE' }); // ACTION -> ADD_POINT
    expect(phase.ok).toBe(true);
    if (!phase.ok) return;
    const before = soldierAt(phase.state, 7)!.strength;
    const r = act(phase.state, 1, { intentType: 'ADD_POINT', coordinate: 7, amount: 5 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(soldierAt(r.state, 7)!.strength).toBe(before + 5);
    expect(force(r.state, 1).points).toBe(0);
    expect(r.state.demo).toEqual({ infinitePoints: true, noVictory: true });
  });

  it('普通模式 0 点数仍拒绝加点', () => {
    const { state } = initState({
      map: pointMap(),
      seatAssignments: ASG,
      timeSettings: DEFAULT_TIME,
      seed: 'normal-seed',
    });
    const zeroed = structuredClone(state);
    force(zeroed, 1).points = 0;
    const phase = act(zeroed, 1, { intentType: 'SWITCH_PHASE' });
    expect(phase.ok).toBe(true);
    if (!phase.ok) return;
    expect(act(phase.state, 1, { intentType: 'ADD_POINT', coordinate: 7, amount: 1 })).toMatchObject({
      ok: false,
      reason: 'NO_POINTS',
    });
  });
});

describe('演示规则：无自动胜负判定', () => {
  const victoryMap = () =>
    makeMap({
      players: [
        { seat: 1, team: 1 },
        { seat: 2, team: 2 },
      ],
      tiles: { 6: [CITY, 1, 4], 12: [CITY, 2, 1] },
    });

  it('清除最后一个敌对势力后仍不结束，且可继续行动', () => {
    const { state } = demoGame(victoryMap());
    const r = act(state, 1, { intentType: 'ATTACK', from: 6, to: 12 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(force(r.state, 2).alive).toBe(false);
    expect(r.state.finished).toBe(false);
    expect(r.state.winners).toBeNull();
    // 没有提前进入 END：当前势力仍可显式切阶段
    expect(r.state.currentSeat).toBe(1);
    expect(r.state.phase).toBe('ACTION');
    expect(act(r.state, 1, { intentType: 'SWITCH_PHASE' }).ok).toBe(true);
  });

  it('普通模式同一局面正常判胜', () => {
    const { state } = initState({
      map: victoryMap(),
      seatAssignments: ASG,
      timeSettings: DEFAULT_TIME,
      seed: 'normal-victory',
    });
    const r = act(state, 1, { intentType: 'ATTACK', from: 6, to: 12 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.finished).toBe(true);
    expect(r.state.winners).toEqual(['101']);
  });
});

describe('演示回放文件契约', () => {
  it('接受合法文件', () => {
    const { state } = demoGame(pointMap());
    const file: DemoReplayFile = {
      version: 1,
      type: 'demo-replay',
      reducerVersion: reducerVersion(),
      createdAt: '2026-11-04T00:00:00.000Z',
      mapTitle: '测试图',
      initialState: state,
      steps: [{ seat: 1, intent: { intentType: 'SWITCH_PHASE' } }],
    };
    expect(validateDemoReplayFile(file)).toBe(true);
  });

  it('拒绝版本、地块数量或意图非法', () => {
    const { state } = demoGame(pointMap());
    const base = {
      version: 1,
      type: 'demo-replay',
      reducerVersion: 'x',
      createdAt: 'now',
      mapTitle: 't',
      initialState: state,
      steps: [],
    };
    expect(validateDemoReplayFile({ ...base, version: 2 })).toBe(false);
    expect(validateDemoReplayFile({ ...base, initialState: { ...state, tiles: [] } })).toBe(false);
    expect(validateDemoReplayFile({ ...base, steps: [{ seat: 1, intent: { intentType: 'NOPE' } }] })).toBe(false);
    expect(validateDemoReplayFile({ ...base, steps: [{ seat: 0, intent: { intentType: 'SWITCH_PHASE' } }] })).toBe(false);
  });
});
