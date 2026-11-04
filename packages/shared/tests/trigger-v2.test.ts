// v2 参数约定：any（无约束）/ unchanged（不修改）/ flipped（相对当前）/ auto（按上下文），
// 以及无空缺的严格地图校验。
import { describe, expect, it } from 'vitest';
import { applyIntent, initState, matchCondition, validateMapData } from '../src/index.js';
import type { GameState, MapFullData, TriggerDef } from '../src/index.js';
import { DEFAULT_TIME, PLAIN, assignments, force, makeMap, soldierAt } from './helpers.js';

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
    seed: 'v2-seed',
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
const soldier = (owner: number, strength = 1) => ({
  owner,
  strength,
  isLinked: true,
  hasMovement: true,
  counter: 1,
});

function baseState(): GameState {
  return start([
    { id: 'turn1', when: { op: 'turn_start', turn: 1 }, effects: [{ op: 'set_fog', enabled: 'unchanged', reveal: [], hide: [] }] },
  ]);
}

describe('any 语义', () => {
  it('tile=any 表示存在某地块', () => {
    const state = baseState();
    const delta = {
      before: state,
      after: state,
      tiles: [
        {
          index: 2,
          before: { terrain: PLAIN, soldier: null },
          after: { terrain: PLAIN, soldier: soldier(1) },
        },
      ],
      forces: [],
    };
    const fired = new Set<string>();
    expect(
      matchCondition({ op: 'tile_owner_changed', tile: 'any', from: 'any', to: 1 }, { delta }, fired, state),
    ).toBe(true);
    expect(
      matchCondition({ op: 'tile_owner_changed', tile: 'any', from: 'any', to: 2 }, { delta }, fired, state),
    ).toBe(false);
    expect(
      matchCondition({ op: 'tile_owner_changed', tile: 3, from: 'any', to: 1 }, { delta }, fired, state),
    ).toBe(false);
  });

  it('force=any 表示任意势力消失', () => {
    const state = baseState();
    const delta = {
      before: state,
      after: state,
      tiles: [],
      forces: [
        {
          seat: 2,
          before: force(state, 2),
          after: { ...force(state, 2), alive: false },
        },
      ],
    };
    const fired = new Set<string>();
    expect(matchCondition({ op: 'force_gone', force: 'any' }, { delta }, fired, state)).toBe(true);
    expect(matchCondition({ op: 'force_gone', force: 3 }, { delta }, fired, state)).toBe(false);
  });

  it('phase/turn=any 忽略对应维度', () => {
    const state = baseState();
    const tx = { kind: 'PHASE_START' as const, seat: 2, phase: 'ACTION' as const, turn: 3, eventIndex: 0 };
    const fired = new Set<string>();
    expect(
      matchCondition({ op: 'phase_start', force: 'any', phase: 'any', turn: 'any' }, { transition: tx }, fired, state),
    ).toBe(true);
    expect(
      matchCondition({ op: 'phase_start', force: 2, phase: 'ACTION', turn: 3 }, { transition: tx }, fired, state),
    ).toBe(true);
    expect(
      matchCondition({ op: 'phase_start', force: 1, phase: 'any', turn: 'any' }, { transition: tx }, fired, state),
    ).toBe(false);
    expect(matchCondition({ op: 'turn_start', turn: 'any' }, { transition: tx }, fired, state)).toBe(false);
    const turnTx = { ...tx, kind: 'TURN_START' as const };
    expect(matchCondition({ op: 'turn_start', turn: 'any' }, { transition: turnTx }, fired, state)).toBe(true);
  });

  it('trigger_fired=any 表示本事务内有任意触发器触发', () => {
    const state = baseState();
    expect(matchCondition({ op: 'trigger_fired', trigger_id: 'any' }, {}, new Set<string>(), state)).toBe(false);
    expect(matchCondition({ op: 'trigger_fired', trigger_id: 'any' }, {}, new Set(['x']), state)).toBe(true);
  });
});

describe('unchanged / flipped / auto', () => {
  it('update_soldier 的 unchanged 保持原值', () => {
    const state = start([
      onOccupy([
        {
          op: 'update_soldier',
          tile: 1,
          patch: {
            strength: 'unchanged',
            owner: 'unchanged',
            movement: false,
          },
        },
      ]),
    ]);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = soldierAt(r.state, 1);
    expect(s?.strength).toBe(1);
    expect(s?.hasMovement).toBe(false);
  });

  it('set_fog 的 flipped 相对当前取反', () => {
    const state = start([
      onOccupy([{ op: 'set_fog', enabled: 'flipped', reveal: [], hide: [] }]),
    ]);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.fogOverrides?.enabled).toBe(true);
  });

  it('spawn_soldier 的 counter=auto 使用地形默认反击次数', () => {
    const state = start(
      [
        onOccupy([
          {
            op: 'spawn_soldier',
            tile: 2,
            force: 1,
            strength: 1,
            movement: false,
          },
        ]),
      ],
      { 0: [PLAIN, 1, 1], 2: [1, 128, 0] }, // tile 2 是据点（地形 1）
    );
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(soldierAt(r.state, 2)?.counter).toBe(1_000_000_000);
  });

  it('update_force 的 unchanged 保持队伍', () => {
    const state = start([
      onOccupy([
        {
          op: 'update_force',
          force: 2,
          patch: { name: '改', flag: 'unchanged', team: 'unchanged', points: 7, computer: 'unchanged' },
        },
      ]),
    ]);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(force(r.state, 2)).toMatchObject({ name: '改', team: 2, points: 7 });
  });
});

describe('v2 严格校验', () => {
  const valid: TriggerDef = {
    id: 'v2',
    when: { op: 'tile_owner_changed', tile: 'any', from: 'any', to: 'player' },
    effects: [
      { op: 'set_fog', enabled: 'flipped', reveal: [0], hide: [] },
      { op: 'spawn_soldier', tile: 0, force: 1, strength: 1, movement: false },
      { op: 'update_force', force: 2, patch: { name: 'x', flag: 'unchanged', team: 'unchanged', points: 'unchanged', computer: 'unchanged' } },
      { op: 'show_text', text_id: 't', text: 'hi', placement: { kind: 'screen', position: 'top-right' } },
    ],
  };
  const withV2 = (triggers: TriggerDef[], version: unknown = 2) =>
    ({ ...makeMap(), trigger_schema_version: version, triggers } as MapFullData);

  it('接受 v2 的 any/unchanged/flipped/auto 与显式 placement', () => {
    expect(validateMapData(withV2([valid]))).toBe(true);
  });

  it('拒绝缺项、旧 op 与旧版本号', () => {
    const missingLinked = withV2([
      {
        id: 'bad',
        when: { op: 'turn_start', turn: 1 },
        effects: [{ op: 'spawn_soldier', tile: 0, force: 1, strength: 1 } as never],
      },
    ]);
    expect(validateMapData(missingLinked)).toBe(false);

    const oldOp = withV2([
      { id: 'old', when: { op: 'tile_emptied' } as never, effects: [{ op: 'set_fog', enabled: 'unchanged', reveal: [], hide: [] }] },
    ]);
    expect(validateMapData(oldOp)).toBe(false);

    expect(validateMapData(withV2([valid], 1))).toBe(false);
  });
});
