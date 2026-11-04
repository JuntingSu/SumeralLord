// 战役触发器 Phase 0：地图 JSON 校验、初始化字段、空触发器回归、悔棋 diff 覆盖新字段。
import { describe, expect, it } from 'vitest';
import {
  applyIntent,
  applyInverseDiff,
  diffGameState,
  hashGameState,
  initState,
  validateMapData,
  validateTriggers,
} from '../src/index.js';
import type { MapFullData, TriggerDef } from '../src/index.js';
import { DEFAULT_TIME, assignments, makeMap } from './helpers.js';

function withTriggers(map: MapFullData, triggers: TriggerDef[]): MapFullData {
  return { ...map, trigger_schema_version: 2, triggers };
}

const actionTrigger: TriggerDef = {
  id: 'occupy',
  when: { op: 'tile_owner_changed', tile: 0, from: 'any', to: 1 },
  effects: [{ op: 'show_text', text_id: 'hello', text: 'hello', placement: { kind: 'screen', position: 'top-right' } }],
};

const worldTrigger: TriggerDef = {
  id: 'turn-one',
  when: { op: 'turn_start', turn: 1 },
  effects: [{ op: 'show_text', text_id: 'turn', text: 'turn 1', placement: { kind: 'screen', position: 'top-right' } }],
};

describe('trigger map validation', () => {
  it('accepts action/world/chain triggers', () => {
    const map = withTriggers(makeMap(), [
      actionTrigger,
      worldTrigger,
      {
        id: 'chain',
        when: { op: 'trigger_fired', trigger_id: 'occupy' },
        effects: [{ op: 'set_fog', enabled: 'unchanged', reveal: [0], hide: [] }],
      },
      {
        id: 'params',
        once: true,
        priority: 5,
        when: {
          op: 'and',
          items: [
            { op: 'tile_owner_changed', tile: 1, from: 'any', to: 'null' },
            { op: 'not', item: { op: 'force_gone', force: 2 } },
          ],
        },
        delay: { amount: 2, unit: 'intent' },
        effects: [
          { op: 'spawn_soldier', tile: 1, force: 1, strength: 2, movement: false },
          { op: 'set_turn_order', order: [2, 1] },
        ],
      },
    ]);
    expect(validateMapData(map)).toBe(true);
  });

  it('rejects duplicate ids and unknown ops', () => {
    const duplicate = withTriggers(makeMap(), [actionTrigger, actionTrigger]);
    expect(validateMapData(duplicate)).toBe(false);

    const unknown = withTriggers(makeMap(), [
      { ...actionTrigger, id: 'x', when: { op: 'mystery' } as never },
    ]);
    expect(validateMapData(unknown)).toBe(false);
  });

  it('rejects out-of-bounds tiles and unknown forces', () => {
    const badTile = withTriggers(makeMap({ rows: 2, columns: 2 }), [
      { ...actionTrigger, when: { op: 'tile_owner_changed', tile: 99, from: 'any', to: 'null' } },
    ]);
    expect(validateMapData(badTile)).toBe(false);

    const badForce = withTriggers(makeMap(), [
      { ...actionTrigger, when: { op: 'force_gone', force: 99 } },
    ]);
    expect(validateMapData(badForce)).toBe(false);
  });

  it('accepts classless triggers and mixed action/world conditions', () => {
    const classless = withTriggers(makeMap(), [
      {
        id: 'no-class',
        when: { op: 'tile_owner_changed', tile: 0, from: 'any', to: 'null' },
        effects: [{ op: 'set_fog', enabled: 'unchanged', reveal: [0], hide: [] }],
      },
    ]);
    expect(validateMapData(classless)).toBe(true);

    // class 与条件类别不再绑定：旧地图里 world 触发器的动作条件同样合法
    const legacyMismatch = withTriggers(makeMap(), [
      { ...actionTrigger, when: { op: 'tile_owner_changed', tile: 0, from: 'any', to: 'null' } },
    ]);
    expect(validateMapData(legacyMismatch)).toBe(true);

    // 同一条件树里混排动作类与回合类条件
    const mixed = withTriggers(makeMap(), [
      {
        id: 'mixed',
        when: {
          op: 'and',
          items: [
            { op: 'tile_owner_changed', tile: 0, from: 'any', to: 1 },
            { op: 'turn_start', turn: 2 },
          ],
        },
        effects: [{ op: 'set_fog', enabled: 'unchanged', reveal: [0], hide: [] }],
      },
    ]);
    expect(validateMapData(mixed)).toBe(true);
  });

  it('accepts seat/any/null owner refs for tile_owner_changed', () => {
    const ok = withTriggers(makeMap(), [
      {
        id: 'any-to-null',
        when: { op: 'tile_owner_changed', tile: 0, from: 'any', to: 'null' },
        effects: [{ op: 'set_fog', enabled: 'unchanged', reveal: [0], hide: [] }],
      },
      {
        id: 'null-to-seat',
        when: { op: 'tile_owner_changed', tile: 0, from: 'null', to: 2 },
        effects: [{ op: 'set_fog', enabled: 'unchanged', reveal: [0], hide: [] }],
      },
      {
        id: 'player-owner',
        when: { op: 'tile_owner_changed', tile: 0, from: 'player', to: 'any' },
        effects: [{ op: 'set_fog', enabled: 'unchanged', reveal: [0], hide: [] }],
      },
    ]);
    expect(validateMapData(ok)).toBe(true);

    const badRef = withTriggers(makeMap(), [
      {
        id: 'bad-from',
        when: { op: 'tile_owner_changed', tile: 0, from: 'nobody' as never, to: 1 },
        effects: [{ op: 'set_fog', enabled: 'unchanged', reveal: [0], hide: [] }],
      },
    ]);
    expect(validateMapData(badRef)).toBe(false);

    const badSeat = withTriggers(makeMap(), [
      {
        id: 'bad-to',
        when: { op: 'tile_owner_changed', tile: 0, from: 1, to: 99 },
        effects: [{ op: 'set_fog', enabled: 'unchanged', reveal: [0], hide: [] }],
      },
    ]);
    expect(validateMapData(badSeat)).toBe(false);
  });

  it('rejects missing chain references and invalid turn order', () => {
    const missingRef = withTriggers(makeMap(), [
      { ...actionTrigger, when: { op: 'trigger_fired', trigger_id: 'nope' } },
    ]);
    expect(validateMapData(missingRef)).toBe(false);

    const badOrder = withTriggers(makeMap(), [
      {
        ...actionTrigger,
        effects: [{ op: 'set_turn_order', order: [1] }],
      },
    ]);
    expect(validateMapData(badOrder)).toBe(false);

    expect(
      validateTriggers([{ ...actionTrigger, delay: { amount: 0, unit: 'turn' } }], 4, 5, new Set([1, 2]), new Set([1, 2])),
    ).toBe(false);
  });
});

describe('trigger init and regression', () => {
  it('empty triggers keep normal mode byte-identical', () => {
    const map = makeMap();
    const normal = initState({ map, seatAssignments: assignments({ seat: 1, playerId: 1 }, { seat: 2, playerId: 2 }), timeSettings: DEFAULT_TIME, seed: 's' });
    const withEmpty = initState({
      map: withTriggers(map, []),
      seatAssignments: assignments({ seat: 1, playerId: 1 }, { seat: 2, playerId: 2 }),
      timeSettings: DEFAULT_TIME,
      seed: 's',
      triggerMode: true,
    });
    expect(normal.state.triggerMode).toBe(false);
    expect(withEmpty.state.triggerMode).toBe(false);
    expect(hashGameState(withEmpty.state)).toBe(hashGameState(normal.state));
  });

  it('campaign map initializes runtime, controlled seat and turn order', () => {
    const map = withTriggers(makeMap(), [actionTrigger]);
    const init = initState({
      map,
      seatAssignments: assignments({ seat: 1, playerId: 7 }, { seat: 2, playerId: 8 }),
      timeSettings: DEFAULT_TIME,
      seed: 's',
      triggerMode: true,
      controlledSeat: 1,
      humanPlayerId: 7,
    });
    expect(init.state.triggerMode).toBe(true);
    expect(init.state.triggerRuntime).toEqual({
      schemaVersion: 2,
      firedCounts: {},
      stateWatch: {},
      pending: [],
      intentSeq: 0,
      turnSeq: 0,
      nextSerial: 1,
      transactionSeq: 1,
    });
    expect(init.state.controlledSeat).toBe(1);
    expect(init.state.humanPlayerId).toBe(7);
    expect(init.state.turnOrder).toEqual([1, 2]);
  });

  it('AI actor can act without being treated as the human player', () => {
    const init = initState({
      map: makeMap(),
      seatAssignments: assignments({ seat: 1, playerId: 1 }, { seat: 2, playerId: 2 }),
      timeSettings: DEFAULT_TIME,
      seed: 's',
    });
    const r = applyIntent(init.state, {
      actor: { kind: 'AI', seat: init.state.currentSeat },
      intent: { intentType: 'SWITCH_PHASE' },
    });
    expect(r.ok).toBe(true);
  });

  it('undo diff covers trigger runtime and campaign fields', () => {
    const map = withTriggers(makeMap(), [worldTrigger]);
    const init = initState({
      map,
      seatAssignments: assignments({ seat: 1, playerId: 7 }, { seat: 2, playerId: 8 }),
      timeSettings: DEFAULT_TIME,
      seed: 's',
      triggerMode: true,
      controlledSeat: 1,
      humanPlayerId: 7,
    });
    const r = applyIntent(init.state, {
      actor: { kind: 'PLAYER', seat: init.state.currentSeat },
      intent: { intentType: 'SWITCH_PHASE' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const diff = diffGameState(init.state, r.state);
    const restored = applyInverseDiff(r.state, diff);
    expect(restored.triggerMode).toBe(init.state.triggerMode);
    expect(restored.controlledSeat).toBe(init.state.controlledSeat);
    expect(restored.humanPlayerId).toBe(init.state.humanPlayerId);
    expect(restored.turnOrder).toEqual(init.state.turnOrder);
    expect(restored.triggerRuntime).toEqual(init.state.triggerRuntime);
  });
});
