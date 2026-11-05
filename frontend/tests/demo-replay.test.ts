// 演示回放播放辅助：初态规则补齐、单步应用、检查点定位
import { describe, it, expect } from 'vitest';
import type { DemoReplayFile, DemoReplayStep, GameState, SoldierState } from '@dl/shared';
import { DemoReplayTimeline } from '../src/game/demoReplay';

const SOLDIER: SoldierState = {
  owner: 1,
  strength: 2,
  isLinked: true,
  hasMovement: false,
  counter: 0,
};

function baseState(): GameState {
  return {
    rows: 1,
    columns: 1,
    cylindrical: false,
    seed: 'test',
    turn: 1,
    currentSeat: 1,
    phase: 'ACTION',
    forces: [
      {
        seat: 1,
        team: 1,
        name: '甲',
        flag: 1,
        playerId: 1,
        isAI: false,
        computer: 1,
        exists: true,
        alive: true,
        points: 0,
      },
    ],
    tiles: [{ terrain: 0, soldier: { ...SOLDIER } }],
    timeSettings: { stepTime: 90, gameTime: 1200, additionalTime: 0 },
    finished: false,
    winners: null,
    winningTeam: null,
    triggerMode: false,
    triggerRuntime: null,
    controlledSeat: null,
    humanPlayerId: null,
    turnOrder: [1],
    fogOverrides: null,
    triggers: [],
  };
}

function replay(steps: DemoReplayStep[]): DemoReplayFile {
  return {
    version: 1,
    type: 'demo-replay',
    reducerVersion: 'test',
    createdAt: '2026-11-04T00:00:00.000Z',
    mapTitle: '测试',
    initialState: baseState(),
    steps,
  };
}

describe('DemoReplayTimeline', () => {
  it('初态补齐无限加点 / 无胜负规则', () => {
    const tl = new DemoReplayTimeline(replay([]));
    expect(tl.total).toBe(0);
    expect(tl.stateAt(0).state.demo).toEqual({ infinitePoints: true, noVictory: true });
  });

  it('按意图逐步推进，并从检查点重算出一致局面', () => {
    const tl = new DemoReplayTimeline(
      replay([
        { seat: 1, intent: { intentType: 'SWITCH_PHASE' } },
        { seat: 1, intent: { intentType: 'ADD_POINT', coordinate: 0, amount: 3 } },
      ]),
    );
    const mid = tl.stateAt(1);
    expect(mid.failedSteps).toEqual([]);
    expect(mid.state.phase).toBe('ADD_POINT');

    const end = tl.stateAt(2);
    expect(end.state.tiles[0].soldier!.strength).toBe(5);
    // 无限加点：0 点数也不扣
    expect(end.state.forces[0].points).toBe(0);
    expect(end.state.demo).toEqual({ infinitePoints: true, noVictory: true });

    // 再取一次中间态，确认检查点/重算结果稳定
    const again = tl.stateAt(1);
    expect(again.state.phase).toBe('ADD_POINT');
    expect(again.state.tiles[0].soldier!.strength).toBe(2);
  });

  it('非法步骤被跳过并报告序号', () => {
    const tl = new DemoReplayTimeline(
      replay([{ seat: 2, intent: { intentType: 'SWITCH_PHASE' } }]),
    );
    const r = tl.stateAt(1);
    expect(r.failedSteps).toEqual([0]);
    expect(r.state.currentSeat).toBe(1);
    expect(r.state.phase).toBe('ACTION');
  });
});
