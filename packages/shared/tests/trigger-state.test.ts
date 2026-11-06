// gamestate 路径、断言与纯状态监听（边沿触发、无级联）。
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  STATE_PATH_DEFS,
  applyIntent,
  formatStateText,
  initState,
  matchCondition,
  resolveStatePath,
  validateMapData,
} from '../src/index.js';
import type { GameState, MapFullData, TriggerDef } from '../src/index.js';
import { DEFAULT_TIME, PLAIN, assignments, makeMap } from './helpers.js';

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
    seed: 'state-seed',
    triggerMode: true,
    controlledSeat: 1,
    humanPlayerId: 1,
  }).state;
}

const move = (from: number, to: number) => ({ intentType: 'MOVE' as const, from, to });
const text = (id: string): TriggerDef['effects'] => [
  { op: 'show_text', text_id: id, text: id, placement: { kind: 'screen', position: 'top-right' } },
];

describe('gamestate 文本格式化', () => {
  const fake = {
    rows: 3,
    columns: 3,
    turn: 2,
    phase: 'ACTION',
    controlledSeat: 1,
    forces: [
      { seat: 1, name: '红方' },
      { seat: 2, name: '蓝方' },
      { seat: 3, name: '绿方' },
    ],
    tiles: [
      { terrain: 0, soldier: null },
      { terrain: 0, soldier: { owner: 0 } },
      { terrain: 1, soldier: { owner: 2 } },
    ],
    triggerRuntime: { firedCounts: { x: 3 } },
  } as unknown as GameState;

  it('替换为便于理解的文字', () => {
    expect(
      formatStateText(
        fake,
        '第{gamestate.turn}回合 {gamestate.phase} {gamestate.forces.1.name} ' +
          '{gamestate.tiles.0.soldier.owner} {gamestate.tiles.1.soldier.owner} ' +
          '{gamestate.tiles.2.soldier.owner} {gamestate.tiles.0.soldier.exists}',
      ),
    ).toBe('第2回合 行动阶段 红方 无 野生 蓝方 否');
  });

  it('未知占位符保留原文', () => {
    expect(formatStateText(fake, '回合 {gamestate.mystery}')).toBe('回合 {gamestate.mystery}');
  });

  it('player 别名解析为玩家控制势力', () => {
    expect(formatStateText(fake, '{gamestate.forces.player.name}')).toBe('红方');
  });
});

describe('state_assert', () => {
  it('按路径取值做相等比较', () => {
    const state = start([]);
    const fired = new Set<string>();
    expect(
      matchCondition({ op: 'state_assert', path: 'gamestate.turn', cmp: '=', value: 1 }, {}, fired, state),
    ).toBe(true);
    expect(
      matchCondition({ op: 'state_assert', path: 'gamestate.turn', cmp: '=', value: 2 }, {}, fired, state),
    ).toBe(false);
    expect(
      matchCondition(
        { op: 'state_assert', path: 'gamestate.tiles.0.soldier.exists', cmp: '=', value: false },
        {},
        fired,
        state,
      ),
    ).toBe(false);
    expect(
      matchCondition({ op: 'state_assert', path: 'gamestate.nope', cmp: '=', value: 1 }, {}, fired, state),
    ).toBe(false);
  });

  it('cmp=changed 比较本步骤前后的值', () => {
    const before = start([]);
    const after = start([]);
    after.turn = 2;
    const delta = { before, after, tiles: [], forces: [] };
    const fired = new Set<string>();
    expect(
      matchCondition(
        { op: 'state_assert', path: 'gamestate.turn', cmp: 'changed' },
        { delta },
        fired,
        after,
      ),
    ).toBe(true);
    expect(
      matchCondition(
        { op: 'state_assert', path: 'gamestate.phase', cmp: 'changed' },
        { delta },
        fired,
        after,
      ),
    ).toBe(false);
    // 缺少本步骤增量时不能判定为“改变”
    expect(
      matchCondition(
        { op: 'state_assert', path: 'gamestate.turn', cmp: 'changed' },
        {},
        fired,
        after,
      ),
    ).toBe(false);
  });

  it('value_ref 引用另一个 gamestate 变量作为预期值', () => {
    const state = start([]);
    state.turn = 5;
    const force = state.forces.find((f) => f.seat === 1)!;
    force.points = 5;
    const fired = new Set<string>();
    expect(
      matchCondition(
        { op: 'state_assert', path: 'gamestate.turn', cmp: '=', value_ref: 'gamestate.forces.1.points' },
        {},
        fired,
        state,
      ),
    ).toBe(true);
    expect(
      matchCondition(
        { op: 'state_assert', path: 'gamestate.turn', cmp: '>', value_ref: 'gamestate.forces.1.points' },
        {},
        fired,
        state,
      ),
    ).toBe(false);
    force.points = 4;
    expect(
      matchCondition(
        { op: 'state_assert', path: 'gamestate.turn', cmp: '>', value_ref: 'gamestate.forces.1.points' },
        {},
        fired,
        state,
      ),
    ).toBe(true);
    // 引用路径非法 → 不成立
    expect(
      matchCondition(
        { op: 'state_assert', path: 'gamestate.turn', cmp: '=', value_ref: 'gamestate.nope' },
        {},
        fired,
        state,
      ),
    ).toBe(false);
  });

  it('“改变”断言在意图造成的值变化后触发', () => {
    const state = start([
      {
        id: 'moved',
        when: { op: 'state_assert', path: 'gamestate.tiles.1.soldier.exists', cmp: 'changed' },
        effects: text('moved'),
      },
    ]);
    // 纯状态监听不参与，初始不触发
    expect(state.triggerRuntime?.firedCounts.moved).toBeUndefined();
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.triggerRuntime?.firedCounts.moved).toBe(1);
  });

  it('“改变”断言同样响应触发器效果造成的值变化', () => {
    const state = start([
      {
        id: 'spawn',
        when: { op: 'tile_owner_changed', tile: 1, from: 'any', to: 1 },
        effects: [{ op: 'spawn_soldier', tile: 2, force: 1, strength: 1, movement: false }],
      },
      {
        id: 'spawned',
        when: { op: 'state_assert', path: 'gamestate.tiles.2.soldier.exists', cmp: 'changed' },
        effects: text('spawned'),
      },
    ]);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.triggerRuntime?.firedCounts.spawn).toBe(1);
    expect(r.state.triggerRuntime?.firedCounts.spawned).toBe(1);
  });

  it('“上一个意图”记录最近一次成功意图类型', () => {
    const state = start([
      { id: 'nop', when: { op: 'state_assert', path: 'gamestate.finished', cmp: '=', value: false }, effects: text('n') },
    ]);
    expect(resolveStatePath(state, 'gamestate.lastIntentType')).toBeNull();
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(resolveStatePath(r.state, 'gamestate.lastIntentType')).toBe('MOVE');
    expect(
      matchCondition(
        { op: 'state_assert', path: 'gamestate.lastIntentType', cmp: '=', value: 'MOVE' },
        {},
        new Set<string>(),
        r.state,
      ),
    ).toBe(true);
  });
});

describe('文本状态断言', () => {
  const showTrigger: TriggerDef = {
    id: 'show',
    when: { op: 'tile_owner_changed', tile: 1, from: 'any', to: 1 },
    effects: [
      { op: 'show_text', text_id: 't1', text: 'hello', placement: { kind: 'screen', position: 'top-right' } },
    ],
  };

  it('show_text 后文本状态为 true', () => {
    const state = start([showTrigger]);
    expect(resolveStatePath(state, 'gamestate.texts.t1.visible')).toBe(false);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.triggerRuntime?.visibleTexts?.t1).toBe(true);
    expect(resolveStatePath(r.state, 'gamestate.texts.t1.visible')).toBe(true);
    expect(
      matchCondition(
        { op: 'state_assert', path: 'gamestate.texts.t1.visible', cmp: '=', value: true },
        {},
        new Set<string>(),
        r.state,
      ),
    ).toBe(true);
  });

  it('hide_text 后文本状态为 false', () => {
    const state = start([
      showTrigger,
      {
        id: 'hide',
        when: { op: 'trigger_fired', trigger_id: 'show' },
        effects: [{ op: 'hide_text', text_id: 't1' }],
      },
    ]);
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.triggerRuntime?.visibleTexts?.t1).toBeUndefined();
    expect(resolveStatePath(r.state, 'gamestate.texts.t1.visible')).toBe(false);
  });
});

describe('纯状态触发器：状态监听', () => {
  it('init 时条件成立会触发', () => {
    const state = start([
      { id: 'turn1', when: { op: 'state_assert', path: 'gamestate.turn', cmp: '=', value: 1 }, effects: text('t1') },
    ]);
    expect(state.triggerRuntime?.firedCounts.turn1).toBe(1);
    expect(state.triggerRuntime?.stateWatch?.turn1).toBe(true);
  });

  it('边沿触发：持续为 true 不重复触发', () => {
    const state = start([
      {
        id: 'occ',
        when: { op: 'state_assert', path: 'gamestate.tiles.1.soldier.owner', cmp: '=', value: 1 },
        effects: text('occ'),
      },
    ]);
    expect(state.triggerRuntime?.firedCounts.occ).toBeUndefined();
    const r1 = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.state.triggerRuntime?.firedCounts.occ).toBe(1);
    const r2 = applyIntent(r1.state, { actor: { kind: 'PLAYER', seat: 1 }, intent: { intentType: 'SWITCH_PHASE' } });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.state.triggerRuntime?.firedCounts.occ).toBe(1);
  });

  it('同一事务内不级联：后置触发器到下一事务才评估', () => {
    const state = start([
      { id: 'a', when: { op: 'state_assert', path: 'gamestate.turn', cmp: '=', value: 1 }, effects: text('a') },
      { id: 'b', when: { op: 'state_assert', path: 'gamestate.triggerRuntime.firedCounts.a', cmp: '>', value: 0 }, effects: text('b') },
    ]);
    expect(state.triggerRuntime?.firedCounts.a).toBe(1);
    expect(state.triggerRuntime?.firedCounts.b).toBeUndefined();
    expect(state.triggerRuntime?.stateWatch?.b).toBe(false);

    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: { intentType: 'SWITCH_PHASE' } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.triggerRuntime?.firedCounts.b).toBe(1);
  });

  it('AI 事务同样评估状态监听', () => {
    const state = start([
      {
        id: 'ai-turn',
        when: {
          op: 'and',
          items: [
            { op: 'state_assert', path: 'gamestate.currentSeat', cmp: '=', value: 2 },
            { op: 'state_assert', path: 'gamestate.turn', cmp: '=', value: 1 },
          ],
        },
        effects: text('ai'),
      },
    ]);
    // 切到 seat 2：先玩家 SWITCH_PHASE 到阶段变化，再 AI 行动
    let cur = state;
    for (let i = 0; i < 6 && cur.currentSeat !== 2; i++) {
      const r = applyIntent(cur, { actor: { kind: 'PLAYER', seat: cur.currentSeat }, intent: { intentType: 'SWITCH_PHASE' } });
      if (!r.ok) return;
      cur = r.state;
      if (cur.currentSeat === 2) break;
      // seat 2 的行动由 AI 发起
      const ai = applyIntent(cur, { actor: { kind: 'AI', seat: 2 }, intent: { intentType: 'SWITCH_PHASE' } });
      if (!ai.ok) return;
      cur = ai.state;
    }
    expect(cur.triggerRuntime?.firedCounts['ai-turn']).toBe(1);
  });
});

describe('状态路径与文本校验', () => {
  const map = (triggers: TriggerDef[]): MapFullData => ({
    ...makeMap({ players: THREE_PLAYERS }),
    trigger_schema_version: 2,
    triggers,
  });

  it('接受合法断言与占位符', () => {
    expect(
      validateMapData(
        map([
          {
            id: 'ok',
            when: { op: 'state_assert', path: 'gamestate.tiles.0.soldier.owner', cmp: '=', value: null },
            effects: [
              {
                op: 'show_text',
                text_id: 'x',
                text: '第 {gamestate.turn} 回合，{gamestate.forces.player.name} 点数 {gamestate.forces.1.points}',
                placement: { kind: 'screen', position: 'top-right' },
              },
            ],
          },
        ]),
      ),
    ).toBe(true);
  });

  it('文本状态断言只接受已有文本 id 与布尔值', () => {
    const ok = map([
      {
        id: 'show',
        when: { op: 'turn_start', turn: 1 },
        effects: [
          {
            op: 'show_text',
            text_id: 't1',
            text: 'hi',
            placement: { kind: 'screen', position: 'top-right' },
          },
        ],
      },
      {
        id: 'see',
        when: { op: 'state_assert', path: 'gamestate.texts.t1.visible', cmp: '=', value: true },
        effects: text('s'),
      },
    ]);
    expect(validateMapData(ok)).toBe(true);

    const unknown = map([
      {
        id: 'bad',
        when: { op: 'state_assert', path: 'gamestate.texts.nope.visible', cmp: '=', value: false },
        effects: text('x'),
      },
    ]);
    expect(validateMapData(unknown)).toBe(false);

    const badValue = map([
      {
        id: 'show',
        when: { op: 'turn_start', turn: 1 },
        effects: [
          {
            op: 'show_text',
            text_id: 't1',
            text: 'hi',
            placement: { kind: 'screen', position: 'top-right' },
          },
        ],
      },
      {
        id: 'bad',
        when: { op: 'state_assert', path: 'gamestate.texts.t1.visible', cmp: '=', value: 1 },
        effects: text('x'),
      },
    ]);
    expect(validateMapData(badValue)).toBe(false);
  });

  it('预期值支持引用 gamestate 变量', () => {
    const okRef = map([
      {
        id: 'ok',
        when: { op: 'state_assert', path: 'gamestate.turn', cmp: '=', value_ref: 'gamestate.forces.1.points' },
        effects: text('x'),
      },
    ]);
    expect(validateMapData(okRef)).toBe(true);

    const badRef = map([
      {
        id: 'bad',
        when: { op: 'state_assert', path: 'gamestate.turn', cmp: '=', value_ref: 'gamestate.nope' },
        effects: text('x'),
      },
    ]);
    expect(validateMapData(badRef)).toBe(false);

    const bothValues = map([
      {
        id: 'bad',
        when: {
          op: 'state_assert',
          path: 'gamestate.turn',
          cmp: '=',
          value: 1,
          value_ref: 'gamestate.turn',
        },
        effects: text('x'),
      },
    ]);
    expect(validateMapData(bothValues)).toBe(false);

    const nonIntRef = map([
      {
        id: 'bad',
        when: { op: 'state_assert', path: 'gamestate.turn', cmp: '>', value_ref: 'gamestate.phase' },
        effects: text('x'),
      },
    ]);
    expect(validateMapData(nonIntRef)).toBe(false);
  });

  it('拒绝未知路径、越界参数与不匹配的预期值', () => {
    const badPath = map([
      { id: 'bad', when: { op: 'state_assert', path: 'gamestate.mystery', cmp: '=', value: 1 }, effects: text('x') },
    ]);
    expect(validateMapData(badPath)).toBe(false);

    const outOfRange = map([
      { id: 'bad', when: { op: 'state_assert', path: 'gamestate.tiles.99.terrain', cmp: '=', value: 0 }, effects: text('x') },
    ]);
    expect(validateMapData(outOfRange)).toBe(false);

    const badValue = map([
      { id: 'bad', when: { op: 'state_assert', path: 'gamestate.turn', cmp: '=', value: 'one' }, effects: text('x') },
    ]);
    expect(validateMapData(badValue)).toBe(false);

    const badCompare = map([
      { id: 'bad', when: { op: 'state_assert', path: 'gamestate.phase', cmp: '>', value: 1 }, effects: text('x') },
    ]);
    expect(validateMapData(badCompare)).toBe(false);

    const okCompare = map([
      { id: 'ok', when: { op: 'state_assert', path: 'gamestate.turn', cmp: '>=', value: 1 }, effects: text('x') },
    ]);
    expect(validateMapData(okCompare)).toBe(true);

    const changedWithoutValue = map([
      {
        id: 'ok',
        when: { op: 'state_assert', path: 'gamestate.tiles.0.soldier.strength', cmp: 'changed' },
        effects: text('x'),
      },
    ]);
    expect(validateMapData(changedWithoutValue)).toBe(true);

    const intentValue = map([
      {
        id: 'ok',
        when: { op: 'state_assert', path: 'gamestate.lastIntentType', cmp: '=', value: 'MOVE' },
        effects: text('x'),
      },
    ]);
    expect(validateMapData(intentValue)).toBe(true);

    const badIntentValue = map([
      {
        id: 'bad',
        when: { op: 'state_assert', path: 'gamestate.lastIntentType', cmp: '=', value: 'FLY' },
        effects: text('x'),
      },
    ]);
    expect(validateMapData(badIntentValue)).toBe(false);

    const badText = map([
      {
        id: 'bad',
        when: { op: 'turn_start', turn: 1 },
        effects: [
          {
            op: 'show_text',
            text_id: 'x',
            text: '{gamestate.unknown}',
            placement: { kind: 'screen', position: 'top-right' },
          },
        ],
      },
    ]);
    expect(validateMapData(badText)).toBe(false);
  });
});

describe('路径表契约', () => {
  it('编辑器 JS 副本与 shared 定义一致', () => {
    const file = readFileSync(
      fileURLToPath(new URL('../../../mapeditor/js/statepaths.js', import.meta.url)),
      'utf8',
    );
    const re = /D\('([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)'(?:,\s*\[([^\]]*)\])?(?:,\s*(true))?\)/g;
    const editor = [...file.matchAll(re)].map((m) => ({
      template: m[1],
      label: m[2],
      group: m[3],
      kind: m[4],
      params: m[5] ? [...m[5].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [],
      nullable: !!m[6],
    }));
    const shared = STATE_PATH_DEFS.map((d) => ({
      template: d.template,
      label: d.label,
      group: d.group,
      kind: d.kind,
      params: [...d.params],
      nullable: !!d.nullable,
    }));
    expect(editor).toEqual(shared);
  });
});
