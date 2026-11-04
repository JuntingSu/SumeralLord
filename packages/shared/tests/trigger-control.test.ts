// 战役触发器 Phase 5：胜负延迟 + 玩家势力控制转移。
import { describe, expect, it } from 'vitest';
import { applyIntent, initState } from '../src/index.js';
import type { GameState, MapFullData, TriggerDef } from '../src/index.js';
import { DEFAULT_TIME, PLAIN, assignments, force, makeMap } from './helpers.js';

function init(triggers: TriggerDef[]): GameState {
  const map: MapFullData = {
    ...makeMap({
      rows: 3,
      columns: 3,
      players: [
        { seat: 1, team: 1 },
        { seat: 2, team: 2 },
        { seat: 3, team: 3 },
      ],
      tiles: { 0: [PLAIN, 1, 1] },
    }),
    trigger_schema_version: 2,
    triggers,
  };
  return initState({
    map,
    seatAssignments: assignments(
      { seat: 1, playerId: 1 },
      { seat: 2, playerId: null, isAI: true },
      { seat: 3, playerId: null, isAI: true },
    ),
    timeSettings: DEFAULT_TIME,
    seed: 'control-seed',
    triggerMode: true,
    controlledSeat: 1,
    humanPlayerId: 1,
  }).state;
}

const move = (from: number, to: number) => ({ intentType: 'MOVE' as const, from, to });
const clearPlayer: TriggerDef = {
  id: 'clear-player',
  when: { op: 'tile_owner_changed', tile: 1, from: 'any', to: 1 },
  effects: [{ op: 'clear_force', force: 1 }],
};
const transfer: TriggerDef = {
  id: 'transfer',
  when: { op: 'tile_owner_changed', tile: 1, from: 'any', to: 1 },
  effects: [{ op: 'transfer_control', ai_level: 2 }],
};

describe('control transfer and deferred victory', () => {
  it('hands the player force to a new AI player', () => {
    const state = init([transfer]);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 人类势力被交给 AI 后没有人类势力存活，按既有终局规则结束对局
    expect(r.state.finished).toBe(true);
    expect(r.state.winningTeam).toBe(-1);
    expect(r.state.controlledSeat).toBeNull();
    expect(force(r.state, 1)).toMatchObject({
      alive: true,
      isAI: true,
      playerId: null,
      computer: 2,
    });
    expect(r.chain.some((e) => e.kind === 'CONTROL_CHANGE' && e.toSeat === null)).toBe(true);
  });

  it('ends the game when the cleared human force is not transferred', () => {
    const state = init([clearPlayer]);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.finished).toBe(true);
    expect(r.state.winningTeam).toBe(-1);
  });
});
