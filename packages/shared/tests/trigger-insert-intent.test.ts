// 触发器效果：以指定势力插入 MOVE / ATTACK / ADD_POINT 意图。
// 规则：任意势力、任意时刻；MOVE/ATTACK 忽略移动力与连断兵移动限制（地形、距离、1 兵力连兵仍受限）；
// ADD_POINT 忽略回合/阶段（归属/连兵/点数照常）；插入意图的改动可继续触发触发器。
import { describe, expect, it } from 'vitest';
import { applyIntent, initState, validateMapData } from '../src/index.js';
import type { GameState, MapFullData, TriggerDef } from '../src/index.js';
import { CITY, DEFAULT_TIME, MOUNTAIN, PLAIN, assignments, force, makeMap, soldierAt } from './helpers.js';

function start(
  triggers: TriggerDef[],
  tiles: Record<number, [number, number, number]> = {},
): GameState {
  const map: MapFullData = {
    ...makeMap({
      rows: 3,
      columns: 3,
      players: [
        { seat: 1, team: 1 },
        { seat: 2, team: 2 },
      ],
      tiles,
    }),
    trigger_schema_version: 2,
    triggers,
  };
  return initState({
    map,
    seatAssignments: assignments({ seat: 1, playerId: 1 }, { seat: 2, playerId: null, isAI: true }),
    timeSettings: DEFAULT_TIME,
    seed: 'insert-intent-seed',
    triggerMode: true,
    controlledSeat: 1,
    humanPlayerId: 1,
  }).state;
}

const move = (from: number, to: number) => ({ intentType: 'MOVE' as const, from, to });

/** 动作触发器：1 号势力从 0 占领 1 号地块后执行 effects */
const onEnter = (effects: TriggerDef['effects']): TriggerDef => ({
  id: 'on-enter',
  when: { op: 'tile_owner_changed', tile: 1, from: 'any', to: 1 },
  effects,
});

const BASE: Record<number, [number, number, number]> = {
  0: [PLAIN, 1, 2], // 1 号势力，用于触发
  6: [PLAIN, 2, 2], // 2 号势力（断兵，初始无移动力）
};

describe('触发器插入意图', () => {
  it('insert_move_intent：非当前势力、无移动力也能移动（断兵按正常断兵规则移动）', () => {
    const state = start([onEnter([{ op: 'insert_move_intent', force: 2, from: 6, to: 7 }])], BASE);
    expect(soldierAt(state, 6)?.hasMovement).toBe(false);

    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(soldierAt(r.state, 6)).toBeNull(); // 断兵移动：原格消失
    expect(soldierAt(r.state, 7)?.owner).toBe(2);
    expect(soldierAt(r.state, 7)?.strength).toBe(1); // 复制 -1
  });

  it('insert_move_intent：目标地形全断时仍然不能进入', () => {
    const state = start(
      [onEnter([{ op: 'insert_move_intent', force: 2, from: 6, to: 7 }])],
      { ...BASE, 7: [MOUNTAIN, 128, 0] },
    );
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(soldierAt(r.state, 6)?.owner).toBe(2); // 原地未动
    expect(soldierAt(r.state, 6)?.strength).toBe(2);
    expect(soldierAt(r.state, 7)).toBeNull();
  });

  it('insert_move_intent：1 兵力连兵仍然不能移动', () => {
    const state = start(
      [onEnter([{ op: 'insert_move_intent', force: 2, from: 6, to: 7 }])],
      { 0: [PLAIN, 1, 2], 6: [CITY, 2, 1] },
    );
    expect(soldierAt(state, 6)?.isLinked).toBe(true);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(soldierAt(r.state, 6)?.owner).toBe(2);
    expect(soldierAt(r.state, 6)?.strength).toBe(1);
    expect(soldierAt(r.state, 7)).toBeNull();
  });

  it('insert_attack_intent：非当前势力可发起进攻（忽略移动力，战斗规则照常）', () => {
    const state = start(
      [onEnter([{ op: 'insert_attack_intent', force: 2, from: 6, to: 7 }])],
      {
        0: [PLAIN, 1, 2],
        6: [PLAIN, 2, 3],
        7: [PLAIN, 1, 1],
      },
    );
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chain.some((e) => e.kind === 'ATTACK')).toBe(true);
    expect(soldierAt(r.state, 7)?.owner).toBe(2);
    expect(soldierAt(r.state, 7)?.strength).toBe(2); // 3 - 反击 1
    expect(soldierAt(r.state, 6)).toBeNull();
  });

  it('insert_add_point_intent：非当前势力可加点，正常扣点数', () => {
    const state = start(
      [onEnter([{ op: 'insert_add_point_intent', force: 2, coordinate: 6, amount: 2 }])],
      { 0: [PLAIN, 1, 2], 6: [CITY, 2, 2] },
    );
    force(state, 2).points = 5;
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(soldierAt(r.state, 6)?.strength).toBe(4);
    expect(force(r.state, 2).points).toBe(3);
    const addEvents = r.chain.filter((e) => e.kind === 'ADD_POINT');
    expect(addEvents).toHaveLength(1);
    expect(addEvents[0]).toMatchObject({ seat: 2, coordinate: 6, amount: 2 });
  });

  it('insert_add_point_intent：点数不足时不生效', () => {
    const state = start(
      [onEnter([{ op: 'insert_add_point_intent', force: 2, coordinate: 6, amount: 2 }])],
      { 0: [PLAIN, 1, 2], 6: [CITY, 2, 2] },
    );
    force(state, 2).points = 1;
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(soldierAt(r.state, 6)?.strength).toBe(2);
    expect(force(r.state, 2).points).toBe(1);
    expect(r.chain.some((e) => e.kind === 'ADD_POINT')).toBe(false);
  });

  it('插入意图产生的增量可以继续触发其他动作触发器', () => {
    const state = start(
      [
        {
          id: 'a',
          when: { op: 'tile_owner_changed', tile: 1, from: 'any', to: 1 },
          effects: [{ op: 'insert_move_intent', force: 2, from: 6, to: 7 }],
        },
        {
          id: 'b',
          when: { op: 'tile_owner_changed', tile: 7, from: 'any', to: 2 },
          effects: [{ op: 'show_text', text_id: 'inserted', text: '插入意图生效', placement: { kind: 'screen', position: 'top-right' } }],
        },
      ],
      BASE,
    );
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.triggerRuntime?.firedCounts.b).toBe(1);
    expect(r.chain.some((e) => e.kind === 'TRIGGER_TEXT_SHOW' && e.textId === 'inserted')).toBe(true);
  });

  it('回合类触发器插入的意图也会触发动作类触发器（初始回合 pass）', () => {
    const state = start(
      [
        {
          id: 'w',
          when: { op: 'phase_start', force: 1, phase: 'ACTION', turn: 'any' },
          effects: [{ op: 'insert_move_intent', force: 2, from: 6, to: 7 }],
        },
        {
          id: 'b',
          when: { op: 'tile_owner_changed', tile: 7, from: 'any', to: 2 },
          effects: [{ op: 'show_text', text_id: 'world-inserted', text: '回合触发插入意图', placement: { kind: 'screen', position: 'top-right' } }],
        },
      ],
      BASE,
    );
    expect(soldierAt(state, 7)?.owner).toBe(2);
    expect(state.triggerRuntime?.firedCounts.w).toBe(1);
    expect(state.triggerRuntime?.firedCounts.b).toBe(1);
  });

  it('三种插入意图均通过地图校验', () => {
    const map: MapFullData = {
      ...makeMap({
        rows: 3,
        columns: 3,
        players: [
          { seat: 1, team: 1 },
          { seat: 2, team: 2 },
        ],
      }),
      trigger_schema_version: 2,
      triggers: [
        onEnter([
          { op: 'insert_move_intent', force: 2, from: 6, to: 7 },
          { op: 'insert_attack_intent', force: 2, from: 6, to: 7 },
          { op: 'insert_add_point_intent', force: 1, coordinate: 0, amount: 1 },
        ]),
      ],
    };
    expect(validateMapData(map)).toBe(true);
  });
});
