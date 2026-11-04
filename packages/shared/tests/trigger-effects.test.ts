// 战役触发器 Phase 3：效果执行器（turnOrder / fog / terrain / endGame / spawn 链 / 势力信息）。
import { describe, expect, it } from 'vitest';
import { applyIntent, initState } from '../src/index.js';
import type { GameState, MapFullData, TriggerDef } from '../src/index.js';
import { DEFAULT_TIME, MOUNTAIN, PLAIN, assignments, chainKinds, force, makeMap, soldierAt } from './helpers.js';

const THREE_PLAYERS = [
  { seat: 1, team: 1 },
  { seat: 2, team: 2 },
  { seat: 3, team: 3 },
];

function start(
  triggers: TriggerDef[],
  tiles: Record<number, [number, number, number]> = { 0: [PLAIN, 1, 1] },
): GameState {
  const map: MapFullData = {
    ...makeMap({ rows: 3, columns: 3, players: THREE_PLAYERS, tiles }),
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
    seed: 'effects-seed',
    triggerMode: true,
    controlledSeat: 1,
    humanPlayerId: 1,
  }).state;
}

const move = (from: number, to: number) => ({ intentType: 'MOVE' as const, from, to });
const onOccupy = (effects: TriggerDef['effects']): TriggerDef => ({
  id: 'on-occupy',
  when: { op: 'tile_owner_changed', tile: 1, from: 'any', to: 1 },
  effects,
});

describe('trigger effects', () => {
  it('set_turn_order changes the next force', () => {
    const state = start([onOccupy([{ op: 'set_turn_order', order: [1, 3, 2] }])]);
    let r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.turnOrder).toEqual([1, 3, 2]);
    for (let i = 0; i < 2; i++) {
      const next = applyIntent(r.state, { actor: { kind: 'PLAYER', seat: 1 }, intent: { intentType: 'SWITCH_PHASE' } });
      expect(next.ok).toBe(true);
      if (!next.ok) return;
      r = next;
    }
    expect(r.state.currentSeat).toBe(3);
  });

  it('set_fog merges overrides and emits FOG_CHANGE', () => {
    const state = start([onOccupy([{ op: 'set_fog', enabled: true, reveal: [4], hide: [0] }])]);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.fogOverrides).toEqual({ enabled: true, revealed: [4], hidden: [0] });
    expect(chainKinds(r)).toContain('FOG_CHANGE');
  });

  it('set_terrain changes terrain and removes a soldier on full-break terrain', () => {
    const state = start(
      [onOccupy([{ op: 'set_terrain', tile: 2, terrain: MOUNTAIN }])],
      { 0: [PLAIN, 1, 1], 2: [PLAIN, 1, 1] },
    );
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.tiles[2].terrain).toBe(MOUNTAIN);
    expect(soldierAt(r.state, 2)).toBeNull();
    expect(chainKinds(r)).toContain('TERRAIN_CHANGE');
  });

  it('spawn_soldier can satisfy an occupation trigger in the same transaction', () => {
    const state = start([
      onOccupy([{ op: 'spawn_soldier', tile: 2, force: 2, strength: 3, movement: false }]),
      {
        id: 'ambush',
        when: { op: 'tile_owner_changed', tile: 2, from: 'any', to: 2 },
        effects: [{ op: 'show_text', text_id: 'ambush', text: 'ambush', placement: { kind: 'screen', position: 'top-right' } }],
      },
    ]);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(soldierAt(r.state, 2)?.owner).toBe(2);
    expect(soldierAt(r.state, 2)?.strength).toBe(3);
    expect(r.state.triggerRuntime?.firedCounts).toMatchObject({ 'on-occupy': 1, ambush: 1 });
  });

  it('update_force changes force info and emits FORCE_UPDATE', () => {
    const state = start([
      onOccupy([{ op: 'update_force', force: 2, patch: { name: '新名字', flag: 'unchanged', team: 9, points: 7, computer: 'unchanged' } }]),
    ]);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(force(r.state, 2)).toMatchObject({ name: '新名字', points: 7, team: 9 });
    expect(chainKinds(r)).toContain('FORCE_UPDATE');
  });

  it('end_game finishes the battle with the requested team', () => {
    const state = start([onOccupy([{ op: 'end_game', winning_team: 1 }])]);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.finished).toBe(true);
    expect(r.state.winningTeam).toBe(1);
    expect(r.state.winners).toContain('1');
    expect(chainKinds(r)).toContain('VICTORY');
  });
});
