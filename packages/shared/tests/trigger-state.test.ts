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
