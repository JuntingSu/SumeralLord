// 战役触发器 Phase 2：回合 pass（init / 玩家回合 / AI 回复合 / 世界效果续扫）。
import { describe, expect, it } from 'vitest';
import { applyIntent, initState } from '../src/index.js';
import type { MapFullData, TriggerDef } from '../src/index.js';
import { DEFAULT_TIME, assignments, chainKinds, makeMap } from './helpers.js';

function mapWith(players: Array<{ seat: number; team?: number }>, triggers: TriggerDef[]): MapFullData {
  return {
    ...makeMap({ rows: 2, columns: 2, players }),
    trigger_schema_version: 2,
    triggers,
  };
}

function init(
  players: Array<{ seat: number; team?: number }>,
  triggers: TriggerDef[],
  seatAssignments = assignments(
    { seat: 1, playerId: 1 },
    { seat: 2, playerId: null, isAI: true },
  ),
) {
  return initState({
    map: mapWith(players, triggers),
    seatAssignments,
    timeSettings: DEFAULT_TIME,
    seed: 'world-seed',
    triggerMode: true,
    controlledSeat: 1,
    humanPlayerId: 1,
  });
}

const text = (id: string): TriggerDef['effects'] => [{ op: 'show_text', text_id: id, text: id, placement: { kind: 'screen', position: 'top-right' } }];
const phaseStart = (force: number, phase: 'ACTION' | 'ADD_POINT' | 'PREPARE' | 'END', turn: number | 'any' = 'any') =>
  ({ op: 'phase_start' as const, force, phase, turn });

describe('world triggers', () => {
  it('fires turn_start(1) at init', () => {
    const result = init(
      [{ seat: 1, team: 1 }, { seat: 2, team: 2 }],
      [{ id: 'turn1', when: { op: 'turn_start', turn: 1 }, effects: text('turn1') }],
    );
    expect(chainKinds(result)).toContain('TRIGGER_FIRE');
    expect(result.state.triggerRuntime?.firedCounts.turn1).toBe(1);
  });

  it('fires next force ACTION start in the player transaction', () => {
    const result = init(
      [{ seat: 1, team: 1 }, { seat: 2, team: 2 }],
      [{ id: 'seat2-action', when: phaseStart(2, 'ACTION'), effects: text('seat2') }],
    );
    let cur = result.state;
    const a = applyIntent(cur, { actor: { kind: 'PLAYER', seat: 1 }, intent: { intentType: 'SWITCH_PHASE' } });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = applyIntent(a.state, { actor: { kind: 'PLAYER', seat: 1 }, intent: { intentType: 'SWITCH_PHASE' } });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.state.currentSeat).toBe(2);
    expect(b.state.triggerRuntime?.firedCounts['seat2-action']).toBe(1);
  });

  it('fires player turn start and global round start even when the AI advances the turn', () => {
    const result = init(
      [{ seat: 1, team: 1 }, { seat: 2, team: 2 }],
      [
        { id: 'seat1-turn2', when: phaseStart(1, 'ACTION', 2), effects: text('seat1t2') },
        { id: 'round2', when: { op: 'turn_start', turn: 2 }, effects: text('r2') },
      ],
    );
    let cur = result.state;
    for (let i = 0; i < 2; i++) {
      const r = applyIntent(cur, { actor: { kind: 'PLAYER', seat: 1 }, intent: { intentType: 'SWITCH_PHASE' } });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      cur = r.state;
    }
    expect(cur.currentSeat).toBe(2);
    for (let i = 0; i < 2; i++) {
      const r = applyIntent(cur, { actor: { kind: 'AI', seat: 2 }, intent: { intentType: 'SWITCH_PHASE' } });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      cur = r.state;
    }
    expect(cur.turn).toBe(2);
    expect(cur.currentSeat).toBe(1);
    expect(cur.triggerRuntime?.firedCounts['seat1-turn2']).toBe(1);
    expect(cur.triggerRuntime?.firedCounts.round2).toBe(1);
  });

  it('rescans transitions appended by a world trigger effect', () => {
    const result = init(
      [{ seat: 1, team: 1 }, { seat: 2, team: 2 }, { seat: 3, team: 3 }],
      [
        {
          id: 'clear-seat2',
          when: phaseStart(2, 'ACTION'),
          effects: [{ op: 'clear_force', force: 2 }],
        },
        { id: 'seat3-action', when: phaseStart(3, 'ACTION'), effects: text('seat3') },
      ],
      assignments(
        { seat: 1, playerId: 1 },
        { seat: 2, playerId: null, isAI: true },
        { seat: 3, playerId: null, isAI: true },
      ),
    );
    let cur = result.state;
    for (let i = 0; i < 2; i++) {
      const r = applyIntent(cur, { actor: { kind: 'PLAYER', seat: 1 }, intent: { intentType: 'SWITCH_PHASE' } });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      cur = r.state;
    }
    expect(cur.currentSeat).toBe(3);
    expect(cur.forces.find((f) => f.seat === 2)?.alive).toBe(false);
    expect(cur.triggerRuntime?.firedCounts['clear-seat2']).toBe(1);
    expect(cur.triggerRuntime?.firedCounts['seat3-action']).toBe(1);
  });
});
