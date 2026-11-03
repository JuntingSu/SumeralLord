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
    trigger_schema_version: 1,
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
  class: 'action',
  when: { op: 'tile_owner_appeared', tile: 1, force: 1 },
  effects: [{ op: 'clear_force', force: 1 }],
};
const transfer: TriggerDef = {
  id: 'transfer',
  class: 'action',
  when: { op: 'force_gone', force: 1 },
  effects: [{ op: 'transfer_control', to_force: 2, ai_level: 1 }],
};

describe('control transfer and deferred victory', () => {
  it('transfers control before victory judgment and keeps the game alive', () => {
    const state = init([clearPlayer, transfer]);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.finished).toBe(false);
    expect(r.state.controlledSeat).toBe(2);
    expect(force(r.state, 1)).toMatchObject({ alive: false, isAI: true, playerId: null });
    expect(force(r.state, 2)).toMatchObject({ alive: true, isAI: false, playerId: 1 });
    expect(r.state.currentSeat).toBe(2);

    const next = applyIntent(r.state, {
      actor: { kind: 'PLAYER', seat: 2 },
      intent: { intentType: 'SWITCH_PHASE' },
    });
    expect(next.ok).toBe(true);
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
