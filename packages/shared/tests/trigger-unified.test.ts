// 取消 action/world 区分：触发器不再按 class 分流，动作类与回合类条件可混排。
import { describe, expect, it } from 'vitest';
import { applyIntent, initState, matchCondition } from '../src/index.js';
import type {
  MapFullData,
  TriggerCondition,
  TriggerDef,
  TriggerDelta,
} from '../src/index.js';
import { DEFAULT_TIME, PLAIN, assignments, chainKinds, makeMap } from './helpers.js';

const THREE_PLAYERS = [
  { seat: 1, team: 1 },
  { seat: 2, team: 2 },
  { seat: 3, team: 3 },
];

function campaignMap(
  triggers: TriggerDef[],
  tiles: Record<number, [number, number, number]>,
): MapFullData {
  return {
    ...makeMap({ rows: 3, columns: 3, players: THREE_PLAYERS, tiles }),
    trigger_schema_version: 2,
    triggers,
  };
}

function start(
  triggers: TriggerDef[],
  tiles: Record<number, [number, number, number]> = { 0: [PLAIN, 1, 1] },
) {
  return initState({
    map: campaignMap(triggers, tiles),
    seatAssignments: assignments(
      { seat: 1, playerId: 1 },
      { seat: 2, playerId: 2 },
      { seat: 3, playerId: 3 },
    ),
    timeSettings: DEFAULT_TIME,
    seed: 'unified-seed',
    triggerMode: true,
    controlledSeat: 1,
    humanPlayerId: 1,
  }).state;
}

const move = (from: number, to: number) => ({ intentType: 'MOVE' as const, from, to });

describe('unified triggers without class', () => {
  it('fires a classless action trigger on tile occupation', () => {
    const state = start([
      {
        id: 'occupy',
        when: { op: 'tile_owner_changed', tile: 1, from: 'any', to: 1 },
        effects: [{ op: 'show_text', text_id: 't', text: 'occupied', placement: { kind: 'screen', position: 'top-right' } }],
      },
    ]);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(chainKinds(r)).toContain('TRIGGER_FIRE');
    expect(r.state.triggerRuntime?.firedCounts.occupy).toBe(1);
  });

  it('fires a classless world trigger on turn start', () => {
    const state = start([
      {
        id: 'turn1',
        when: { op: 'turn_start', turn: 1 },
        effects: [{ op: 'show_text', text_id: 't1', text: 'turn 1', placement: { kind: 'screen', position: 'top-right' } }],
      },
    ]);
    expect(state.triggerRuntime?.firedCounts.turn1).toBe(1);
  });

  it('mixed or condition fires from its action branch', () => {
    const state = start([
      {
        id: 'mixed-or',
        when: {
          op: 'or',
          items: [
            { op: 'tile_owner_changed', tile: 1, from: 'any', to: 1 },
            { op: 'turn_start', turn: 2 },
          ],
        },
        effects: [{ op: 'show_text', text_id: 'mo', text: 'mixed or', placement: { kind: 'screen', position: 'top-right' } }],
      },
    ]);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.triggerRuntime?.firedCounts['mixed-or']).toBe(1);
  });

  it('legacy class field does not gate conditions', () => {
    const state = start([
      {
        id: 'legacy-world',
        when: { op: 'tile_owner_changed', tile: 1, from: 'any', to: 1 },
        effects: [{ op: 'show_text', text_id: 'lw', text: 'legacy', placement: { kind: 'screen', position: 'top-right' } }],
      },
    ]);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.triggerRuntime?.firedCounts['legacy-world']).toBe(1);
  });

  it('and of action + world conditions needs both contexts', () => {
    const state = start([]);
    const before = { terrain: PLAIN, soldier: null };
    const after = {
      terrain: PLAIN,
      soldier: { owner: 1, strength: 2, isLinked: true, hasMovement: true, counter: 1 },
    };
    const delta: TriggerDelta = {
      before: state,
      after: state,
      tiles: [{ index: 0, before, after }],
      forces: [],
    };
    const tx = { kind: 'TURN_START' as const, seat: 1, phase: 'PREPARE' as const, turn: 2, eventIndex: 0 };
    const cond: TriggerCondition = {
      op: 'and',
      items: [
        { op: 'tile_owner_changed', tile: 0, from: 'any', to: 1 },
        { op: 'turn_start', turn: 2 },
      ],
    };
    const fired = new Set<string>();
    expect(matchCondition(cond, { delta, transition: tx }, fired, state)).toBe(true);
    expect(matchCondition(cond, { delta }, fired, state)).toBe(false);
    expect(matchCondition(cond, { transition: tx }, fired, state)).toBe(false);
  });

  it('not does not treat a missing context as satisfied', () => {
    const state = start([]);
    const fired = new Set<string>();
    // 动作上下文里没有回合转换：not(回合开始) 不能算成立
    expect(
      matchCondition({ op: 'not', item: { op: 'turn_start', turn: 2 } }, {}, fired, state),
    ).toBe(false);
    // 回合上下文里没有动作增量：not(地块被占领) 同样不能算成立
    const tx = { kind: 'TURN_START' as const, seat: 1, phase: 'PREPARE' as const, turn: 2, eventIndex: 0 };
    expect(
      matchCondition(
        { op: 'not', item: { op: 'tile_owner_changed', tile: 0, from: 'any', to: 1 } },
        { transition: tx },
        fired,
        state,
      ),
    ).toBe(false);
  });

  it('fires unified tile_owner_changed on occupation', () => {
    const state = start([
      {
        id: 'changed',
        when: { op: 'tile_owner_changed', tile: 1, from: 'any', to: 1 },
        effects: [{ op: 'show_text', text_id: 'c', text: 'changed', placement: { kind: 'screen', position: 'top-right' } }],
      },
    ]);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.triggerRuntime?.firedCounts.changed).toBe(1);
  });

  it('fires unified tile_owner_changed to null when a tile is vacated', () => {
    const state = start([
      {
        id: 'vacated',
        when: { op: 'tile_owner_changed', tile: 0, from: 1, to: 'null' },
        effects: [{ op: 'show_text', text_id: 'v', text: 'vacated', placement: { kind: 'screen', position: 'top-right' } }],
      },
    ]);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.triggerRuntime?.firedCounts.vacated).toBe(1);
  });
});

describe('tile_owner_changed references', () => {
  const state = start([]);
  const soldier = (owner: number, strength = 2) => ({
    owner,
    strength,
    isLinked: true,
    hasMovement: true,
    counter: 1,
  });
  const deltaOf = (before: ReturnType<typeof soldier> | null, after: ReturnType<typeof soldier> | null) => ({
    before: state,
    after: state,
    tiles: [
      {
        index: 0,
        before: { terrain: PLAIN, soldier: before },
        after: { terrain: PLAIN, soldier: after },
      },
    ],
    forces: [],
  });
  const matches = (
    cond: Extract<TriggerCondition, { op: 'tile_owner_changed' }>,
    delta: TriggerDelta,
  ) => matchCondition(cond, { delta }, new Set<string>(), state);
  const cond = (
    from: Extract<TriggerCondition, { op: 'tile_owner_changed' }>['from'],
    to: Extract<TriggerCondition, { op: 'tile_owner_changed' }>['to'],
  ): Extract<TriggerCondition, { op: 'tile_owner_changed' }> => ({
    op: 'tile_owner_changed',
    tile: 0,
    from,
    to,
  });

  it('matches seat -> seat and respects direction', () => {
    const delta = deltaOf(soldier(2), soldier(1));
    expect(matches(cond(2, 1), delta)).toBe(true);
    expect(matches(cond('any', 1), delta)).toBe(true);
    expect(matches(cond(1, 2), delta)).toBe(false);
    expect(matches(cond(2, 3), delta)).toBe(false);
  });

  it('null covers no owner and neutral forces', () => {
    const empty = deltaOf(soldier(1), null);
    expect(matches(cond(1, 'null'), empty)).toBe(true);
    expect(matches(cond('null', 1), empty)).toBe(false);

    const fromEmpty = deltaOf(null, soldier(1));
    expect(matches(cond('null', 1), fromEmpty)).toBe(true);

    const fromNeutral = deltaOf(soldier(0), soldier(1)); // 野生兵
    expect(matches(cond('null', 1), fromNeutral)).toBe(true);

    const neutralSwap = deltaOf(soldier(0), soldier(255)); // 野生 → 阻挡：null 类别不变
    expect(matches(cond('any', 'any'), neutralSwap)).toBe(false);
  });

  it('any accepts either side', () => {
    const delta = deltaOf(soldier(1), null);
    expect(matches(cond('any', 'any'), delta)).toBe(true);
    expect(matches(cond('any', 'null'), delta)).toBe(true);
    // 仅兵力变化、归属未变
    const strengthOnly = deltaOf(soldier(1, 2), soldier(1, 5));
    expect(matches(cond('any', 'any'), strengthOnly)).toBe(false);
  });
});
