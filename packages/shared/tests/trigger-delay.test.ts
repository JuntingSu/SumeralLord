// 战役触发器 Phase 4：延时排期与到期执行（意图/回合/轮次，跨 AI 回合，链路，悔棋）。
import { describe, expect, it } from 'vitest';
import { applyIntent, applyInverseDiff, diffGameState, initState } from '../src/index.js';
import type { GameState, MapFullData, TriggerDef } from '../src/index.js';
import { DEFAULT_TIME, PLAIN, assignments, chainKinds, makeMap } from './helpers.js';

function init(triggers: TriggerDef[]): GameState {
  const map: MapFullData = {
    ...makeMap({
      rows: 2,
      columns: 3,
      players: [
        { seat: 1, team: 1 },
        { seat: 2, team: 2 },
      ],
      tiles: { 0: [PLAIN, 1, 1] },
    }),
    trigger_schema_version: 2,
    triggers,
  };
  return initState({
    map,
    seatAssignments: assignments({ seat: 1, playerId: 1 }, { seat: 2, playerId: null, isAI: true }),
    timeSettings: DEFAULT_TIME,
    seed: 'delay-seed',
    triggerMode: true,
    controlledSeat: 1,
    humanPlayerId: 1,
  }).state;
}

const move = (from: number, to: number) => ({ intentType: 'MOVE' as const, from, to });
const delayed = (unit: 'intent' | 'turn' | 'round', effects: TriggerDef['effects']): TriggerDef => ({
  id: 'delayed',
  when: { op: 'tile_owner_changed', tile: 1, from: 'any', to: 1 },
  delay: { amount: 1, unit },
  effects,
});

describe('delayed triggers', () => {
  it('executes after the configured number of player intents', () => {
    const state = init([delayed('intent', [{ op: 'show_text', text_id: 'd', text: 'delayed', placement: { kind: 'screen', position: 'top-right' } }])]);
    const first = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.state.triggerRuntime?.pending).toHaveLength(1);
    expect(first.state.triggerRuntime?.pending[0].dueIntentSeq).toBe(2);

    const second = applyIntent(first.state, { actor: { kind: 'PLAYER', seat: 1 }, intent: { intentType: 'SWITCH_PHASE' } });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(chainKinds(second)).toContain('TRIGGER_FIRE');
    expect(second.state.triggerRuntime?.pending).toHaveLength(0);
    expect(second.state.triggerRuntime?.firedCounts.delayed).toBe(1);
  });

  it('executes at the end of the configured number of turns', () => {
    const state = init([delayed('turn', [{ op: 'show_text', text_id: 'd', text: 'delayed', placement: { kind: 'screen', position: 'top-right' } }])]);
    const first = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyIntent(first.state, { actor: { kind: 'PLAYER', seat: 1 }, intent: { intentType: 'SWITCH_PHASE' } });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.state.triggerRuntime?.pending).toHaveLength(1); // 尚未 END_TURN
    const third = applyIntent(second.state, { actor: { kind: 'PLAYER', seat: 1 }, intent: { intentType: 'SWITCH_PHASE' } });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.state.triggerRuntime?.pending).toHaveLength(0);
    expect(third.state.triggerRuntime?.firedCounts.delayed).toBe(1);
  });

  it('executes during an AI transaction when the round advances', () => {
    const state = init([delayed('round', [{ op: 'show_text', text_id: 'd', text: 'delayed', placement: { kind: 'screen', position: 'top-right' } }])]);
    let cur = state;
    const first = applyIntent(cur, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    cur = first.state;
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
      if (i === 1) expect(chainKinds(r)).toContain('TRIGGER_FIRE');
    }
    expect(cur.turn).toBe(2);
    expect(cur.currentSeat).toBe(1);
    expect(cur.triggerRuntime?.pending).toHaveLength(0);
    expect(cur.triggerRuntime?.firedCounts.delayed).toBe(1);
  });

  it('delayed effects can chain action triggers inside a player transaction', () => {
    const state = init([
      delayed('intent', [{ op: 'spawn_soldier', tile: 2, force: 2, strength: 3, movement: false }]),
      {
        id: 'ambush',
        when: { op: 'tile_owner_changed', tile: 2, from: 'any', to: 2 },
        effects: [{ op: 'show_text', text_id: 'a', text: 'ambush', placement: { kind: 'screen', position: 'top-right' } }],
      },
    ]);
    const first = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = applyIntent(first.state, { actor: { kind: 'PLAYER', seat: 1 }, intent: { intentType: 'SWITCH_PHASE' } });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.state.triggerRuntime?.firedCounts).toMatchObject({ delayed: 1, ambush: 1 });
  });

  it('undo restores pending schedule and fired counts', () => {
    const state = init([delayed('intent', [{ op: 'show_text', text_id: 'd', text: 'delayed', placement: { kind: 'screen', position: 'top-right' } }])]);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const diff = diffGameState(state, r.state);
    const restored = applyInverseDiff(r.state, diff);
    expect(restored.triggerRuntime?.pending).toEqual(state.triggerRuntime?.pending);
    expect(restored.triggerRuntime?.firedCounts).toEqual(state.triggerRuntime?.firedCounts);
  });
});
