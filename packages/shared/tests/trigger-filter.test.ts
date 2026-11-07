// 组件编号 / 筛选变量 / 列表引用 / 前态引用。
import { describe, expect, it } from 'vitest';
import {
  applyIntent,
  evaluateTriggerCondition,
  initState,
  validateMapData,
} from '../src/index.js';
import type { GameState, MapFullData, TriggerDef } from '../src/index.js';
import { DEFAULT_TIME, EMPTY, PLAIN, assignments, makeMap } from './helpers.js';

const THREE_PLAYERS = [
  { seat: 1, team: 1, name: '红方' },
  { seat: 2, team: 2, name: '蓝方' },
  { seat: 3, team: 3, name: '绿方' },
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
      { seat: 2, playerId: 2 },
      { seat: 3, playerId: 3 },
    ),
    timeSettings: DEFAULT_TIME,
    seed: 'filter-seed',
    triggerMode: true,
    controlledSeat: 1,
    humanPlayerId: 1,
  }).state;
}

const move = (from: number, to: number) => ({ intentType: 'MOVE' as const, from, to });

const tileOwnerFilter = (cid: string, owner: number): TriggerDef['when'] => ({
  op: 'state_assert',
  cid,
  path: 'gamestate.tiles.{tile}.soldier.owner',
  cmp: '=',
  value: owner,
  args: { tile: { any: true } },
});

const tileStrengthFilter = (
  cid: string,
  cmp: '=' | '>=' | '>',
  value: number,
): TriggerDef['when'] => ({
  op: 'state_assert',
  cid,
  path: 'gamestate.tiles.{tile}.soldier.strength',
  cmp,
  value,
  args: { tile: { any: true } },
});

const seatAliveFilter = (cid: string): TriggerDef['when'] => ({
  op: 'state_assert',
  cid,
  path: 'gamestate.forces.{seat}.alive',
  cmp: '=',
  value: true,
  args: { seat: { any: true } },
});

describe('筛选变量与列表', () => {
  it('任意地块筛选产出列表，效果逐项执行', () => {
    const state = start(
      [
        {
          id: 'purge',
          when: tileOwnerFilter('f', 1),
          effects: [{ op: 'remove_soldier', tile: 0, refs: { tile: { ref: 'f' } } }],
        },
      ],
      { 0: [PLAIN, 1, 2], 1: [PLAIN, 1, 1], 2: [PLAIN, 2, 1] },
    );
    expect(state.tiles[0].soldier).toBeNull();
    expect(state.tiles[1].soldier).toBeNull();
    expect(state.tiles[2].soldier?.owner).toBe(2);
  });

  it('列表按地块序号升序去重', () => {
    const state = start([]);
    const result = evaluateTriggerCondition(
      {
        op: 'and',
        cid: 'root',
        items: [
          {
            op: 'state_assert',
            cid: 'f',
            path: 'gamestate.tiles.{tile}.soldier.owner',
            cmp: '=',
            value: 1,
            args: { tile: { any: true } },
          },
        ],
      },
      {},
      new Set(),
      { ...state, tiles: state.tiles.map((t, i) => (i === 2 || i === 0 ? { terrain: t.terrain, soldier: { owner: 1, strength: 1, isLinked: false, hasMovement: false, counter: 0 } } : t)) },
    );
    expect(result.pass).toBe(true);
    expect(result.bindings.root).toEqual({ type: 'tile', values: [0, 2] });
  });

  it('条件筛选结果可以被另一个条件继续筛选', () => {
    const state = start([], {
      0: [PLAIN, 1, 2],
      1: [PLAIN, 1, 1],
      2: [PLAIN, 2, 1],
    });
    const en = evaluateTriggerCondition(
      {
        op: 'and',
        cid: 'root',
        items: [
          tileOwnerFilter('first', 1),
          {
            op: 'state_assert',
            cid: 'second',
            path: 'gamestate.tiles.{tile}.soldier.strength',
            cmp: '>=',
            value: 2,
            args: { tile: { ref: 'first' } },
          },
        ],
      },
      {},
      new Set(),
      state,
    );
    expect(en.bindings.first).toEqual({ type: 'tile', values: [0, 1] });
    expect(en.bindings.second).toEqual({ type: 'tile', values: [0] });
    expect(en.bindings.root).toEqual({ type: 'tile', values: [0] });
  });

  it('and 取交集、or 取并集', () => {
    const state = start([], {
      0: [PLAIN, 1, 2],
      1: [PLAIN, 1, 1],
      2: [PLAIN, 2, 1],
    });
    const and = evaluateTriggerCondition(
      {
        op: 'and',
        cid: 'both',
        items: [tileOwnerFilter('owner', 1), tileStrengthFilter('str', '>=', 2)],
      },
      {},
      new Set(),
      state,
    );
    expect(and.bindings.both).toEqual({ type: 'tile', values: [0] });

    const or = evaluateTriggerCondition(
      {
        op: 'or',
        cid: 'either',
        items: [tileOwnerFilter('a', 1), tileOwnerFilter('b', 2)],
      },
      {},
      new Set(),
      state,
    );
    expect(or.bindings.either).toEqual({ type: 'tile', values: [0, 1, 2] });
  });

  it('混合类型不产生列表，布尔结果独立', () => {
    const state = start([], { 0: [PLAIN, 1, 1] });
    const result = evaluateTriggerCondition(
      {
        op: 'and',
        cid: 'mixed',
        items: [tileOwnerFilter('tiles', 1), seatAliveFilter('seats')],
      },
      {},
      new Set(),
      state,
    );
    expect(result.pass).toBe(true);
    expect(result.bindings.mixed).toBeUndefined();
    expect(result.bindings.tiles).toEqual({ type: 'tile', values: [0] });
  });

  it('not 不产生筛选列表', () => {
    const state = start([], { 0: [PLAIN, 1, 1] });
    const result = evaluateTriggerCondition(
      {
        op: 'not',
        cid: 'n',
        item: tileOwnerFilter('inner', 2),
      },
      {},
      new Set(),
      state,
    );
    expect(result.pass).toBe(true);
    expect(result.bindings.n).toBeUndefined();
  });

  it('列表型参数整表接收', () => {
    const state = start(
      [
        {
          id: 'reveal',
          when: tileOwnerFilter('f', 1),
          effects: [
            {
              op: 'set_fog',
              enabled: 'unchanged',
              reveal: [],
              hide: [],
              refs: { reveal: { ref: 'f' } },
            },
          ],
        },
      ],
      { 0: [PLAIN, 1, 1], 2: [PLAIN, 1, 1] },
    );
    expect(state.fogOverrides?.revealed).toEqual([0, 2]);
  });
});

describe('前态引用', () => {
  it('效果读取最近意图执行前的值', () => {
    const state = start(
      [
        {
          id: 'snap',
          when: { op: 'tile_owner_changed', tile: 'any', from: 'any', to: 'any' },
          effects: [
            {
              op: 'declare',
              var_id: 'v',
              refs: {
                init: { gamestate: 'gamestate.tiles.0.soldier.strength', at: 'before' },
              },
            },
          ],
        },
      ],
      { 0: [PLAIN, 1, 2], 1: [PLAIN, EMPTY, 0] },
    );
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 移动后 tile 0 已无兵；前态读取到的仍是 2
    expect(r.state.triggerRuntime?.numberVars?.v).toBe(2);
  });

  it('延时触发器保存排期时解析的前态值', () => {
    const state = start(
      [
        {
          id: 'later',
          when: { op: 'tile_owner_changed', tile: 'any', from: 'any', to: 'any' },
          delay: { unit: 'intent', amount: 1 },
          effects: [
            {
              op: 'declare',
              var_id: 'v',
              refs: {
                init: { gamestate: 'gamestate.tiles.0.soldier.strength', at: 'before' },
              },
            },
          ],
        },
      ],
      { 0: [PLAIN, 1, 2], 1: [PLAIN, EMPTY, 0] },
    );
    const r1 = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.state.triggerRuntime?.pending).toHaveLength(1);
    expect(r1.state.triggerRuntime?.pending[0].preStateValues).toEqual({
      'gamestate.tiles.0.soldier.strength': 2,
    });
    const r2 = applyIntent(r1.state, {
      actor: { kind: 'PLAYER', seat: 1 },
      intent: { intentType: 'SWITCH_PHASE' },
    });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.state.triggerRuntime?.numberVars?.v).toBe(2);
  });
});

describe('组件编号与引用校验', () => {
  const mapWith = (triggers: TriggerDef[]): MapFullData => ({
    ...makeMap({
      rows: 3,
      columns: 3,
      players: THREE_PLAYERS,
      tiles: { 0: [PLAIN, 1, 1], 2: [PLAIN, 2, 1] },
    }),
    trigger_schema_version: 2,
    triggers,
  });

  const validTrigger = (over: Partial<TriggerDef> = {}): TriggerDef => ({
    id: 't',
    when: tileOwnerFilter('c1', 1),
    effects: [{ op: 'remove_soldier', cid: 'e1', tile: 0, refs: { tile: { ref: 'c1' } } }],
    ...over,
  });

  it('合法的编号与筛选引用通过校验', () => {
    expect(validateMapData(mapWith([validTrigger()]))).toBe(true);
  });

  it('同一触发器内编号重复', () => {
    expect(
      validateMapData(
        mapWith([
          validTrigger({
            effects: [{ op: 'remove_soldier', cid: 'c1', tile: 0 }],
          }),
        ]),
      ),
    ).toBe(false);
  });

  it('引用不存在的组件', () => {
    expect(
      validateMapData(
        mapWith([
          validTrigger({
            effects: [{ op: 'remove_soldier', tile: 0, refs: { tile: { ref: 'missing' } } }],
          }),
        ]),
      ),
    ).toBe(false);
  });

  it('引用效果组件而不是条件', () => {
    expect(
      validateMapData(
        mapWith([
          validTrigger({
            effects: [{ op: 'remove_soldier', cid: 'e1', tile: 0, refs: { tile: { ref: 'e1' } } }],
          }),
        ]),
      ),
    ).toBe(false);
  });

  it('筛选列表类型不匹配', () => {
    expect(
      validateMapData(
        mapWith([
          validTrigger({
            when: seatAliveFilter('c1'),
            effects: [{ op: 'remove_soldier', tile: 0, refs: { tile: { ref: 'c1' } } }],
          }),
        ]),
      ),
    ).toBe(false);
  });

  it('引用 not 或混合类型节点没有列表', () => {
    expect(
      validateMapData(
        mapWith([
          validTrigger({
            when: { op: 'not', cid: 'n', item: tileOwnerFilter('inner', 2) },
            effects: [{ op: 'remove_soldier', tile: 0, refs: { tile: { ref: 'n' } } }],
          }),
        ]),
      ),
    ).toBe(false);
    expect(
      validateMapData(
        mapWith([
          validTrigger({
            when: {
              op: 'and',
              cid: 'mixed',
              items: [tileOwnerFilter('tiles', 1), seatAliveFilter('seats')],
            },
            effects: [{ op: 'remove_soldier', tile: 0, refs: { tile: { ref: 'mixed' } } }],
          }),
        ]),
      ),
    ).toBe(false);
  });

  it('条件引用成环', () => {
    expect(
      validateMapData(
        mapWith([
          validTrigger({
            when: {
              op: 'and',
              items: [
                {
                  op: 'state_assert',
                  cid: 'a',
                  path: 'gamestate.tiles.{tile}.soldier.owner',
                  cmp: '=',
                  value: 1,
                  args: { tile: { ref: 'b' } },
                },
                {
                  op: 'state_assert',
                  cid: 'b',
                  path: 'gamestate.tiles.{tile}.soldier.strength',
                  cmp: '>=',
                  value: 1,
                  args: { tile: { ref: 'a' } },
                },
              ],
            },
            effects: [{ op: 'remove_soldier', tile: 0 }],
          }),
        ]),
      ),
    ).toBe(false);
  });

  it('一个组件最多一个列表引用', () => {
    expect(
      validateMapData(
        mapWith([
          validTrigger({
            when: {
              op: 'and',
              cid: 'tiles',
              items: [
                tileOwnerFilter('a', 1),
                seatAliveFilter('s'),
              ],
            },
            effects: [
              {
                op: 'update_soldier',
                cid: 'e1',
                tile: 0,
                patch: { owner: 'unchanged', strength: 'unchanged', movement: 'unchanged' },
                refs: { tile: { ref: 'a' }, owner: { ref: 's' } },
              },
            ],
          }),
        ]),
      ),
    ).toBe(false);
  });

  it('列表型参数不接受标量状态引用', () => {
    expect(
      validateMapData(
        mapWith([
          validTrigger({
            effects: [
              {
                op: 'set_fog',
                enabled: 'unchanged',
                reveal: [],
                hide: [],
                refs: { reveal: { gamestate: 'gamestate.turn' } },
              },
            ],
          }),
        ]),
      ),
    ).toBe(false);
  });

  it('前态引用合法，非法 at 被拒绝', () => {
    const ok = validateMapData(
      mapWith([
        validTrigger({
          effects: [
            {
              op: 'declare',
              var_id: 'v',
              refs: { init: { gamestate: 'gamestate.tiles.0.soldier.strength', at: 'before' } },
            },
          ],
        }),
      ]),
    );
    expect(ok).toBe(true);
    const bad = validateMapData(
      mapWith([
        validTrigger({
          effects: [
            {
              op: 'declare',
              var_id: 'v',
              refs: {
                init: { gamestate: 'gamestate.tiles.0.soldier.strength', at: 'past' as never },
              },
            },
          ],
        }),
      ]),
    );
    expect(bad).toBe(false);
  });
});
