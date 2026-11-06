// 选项文本：首次显示阻塞、选择后关闭并记录下标；再次显示不阻塞并回显已选项。
import { describe, expect, it } from 'vitest';
import { applyIntent, initState, resolveStatePath, validateMapData } from '../src/index.js';
import type { GameState, MapFullData, TriggerDef } from '../src/index.js';
import { DEFAULT_TIME, PLAIN, assignments, makeMap } from './helpers.js';

const THREE_PLAYERS = [
  { seat: 1, team: 1, name: '红方' },
  { seat: 2, team: 2, name: '蓝方' },
  { seat: 3, team: 3, name: '绿方' },
];

const SHOW: Extract<TriggerDef['effects'][number], { op: 'show_choice_text' }> = {
  op: 'show_choice_text',
  text_id: 't1',
  text: '请选择',
  placement: { kind: 'screen', position: 'top-right' },
  options: ['A', 'B'],
};

function start(triggers: TriggerDef[]): GameState {
  const map: MapFullData = {
    ...makeMap({ rows: 3, columns: 3, players: THREE_PLAYERS, tiles: { 0: [PLAIN, 1, 1] } }),
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
    seed: 'choice-seed',
    triggerMode: true,
    controlledSeat: 1,
    humanPlayerId: 1,
  }).state;
}

const move = (from: number, to: number) => ({ intentType: 'MOVE' as const, from, to });
const choose = (index: number) => ({ intentType: 'CHOOSE_TEXT' as const, textId: 't1', index });

const ask: TriggerDef = {
  id: 'ask',
  when: { op: 'tile_owner_changed', tile: 1, from: 'any', to: 1 },
  effects: [SHOW],
};

describe('选项文本', () => {
  it('首次显示阻塞对局，选择后写入下标并关闭', () => {
    const state = start([ask]);
    const first = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const shown = first.state;
    expect(shown.triggerRuntime?.pendingChoices?.t1).toBe(2);
    expect(resolveStatePath(shown, 'gamestate.texts.t1.visible')).toBe(true);
    expect(resolveStatePath(shown, 'gamestate.texts.t1.option')).toBeUndefined();

    const blocked = applyIntent(shown, {
      actor: { kind: 'PLAYER', seat: 1 },
      intent: { intentType: 'SWITCH_PHASE' },
    });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('PENDING_CHOICE');

    const aiChoose = applyIntent(shown, { actor: { kind: 'AI', seat: 1 }, intent: choose(0) });
    expect(aiChoose.ok).toBe(false);

    const chosen = applyIntent(shown, { actor: { kind: 'PLAYER', seat: 1 }, intent: choose(1) });
    expect(chosen.ok).toBe(true);
    if (!chosen.ok) return;
    expect(chosen.state.triggerRuntime?.choiceValues?.t1).toBe(1);
    expect(chosen.state.triggerRuntime?.pendingChoices?.t1).toBeUndefined();
    expect(resolveStatePath(chosen.state, 'gamestate.texts.t1.option')).toBe(1);
    expect(resolveStatePath(chosen.state, 'gamestate.texts.t1.visible')).toBe(false);
  });

  it('非法下标、未等待选择时拒绝 CHOOSE_TEXT', () => {
    const state = start([ask]);
    const noPending = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: choose(0) });
    expect(noPending.ok).toBe(false);
    if (!noPending.ok) expect(noPending.reason).toBe('ILLEGAL_CHOICE');

    const first = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const bad = applyIntent(first.state, { actor: { kind: 'PLAYER', seat: 1 }, intent: choose(2) });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe('ILLEGAL_CHOICE');
  });

  it('再次显示不阻塞，并回显已选下标', () => {
    const reshow: TriggerDef = {
      id: 'reshow',
      when: { op: 'state_assert', path: 'gamestate.lastIntentType', cmp: '=', value: 'CHOOSE_TEXT' },
      effects: [SHOW],
    };
    const state = start([ask, reshow]);
    const first = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(0, 1) });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const chosen = applyIntent(first.state, { actor: { kind: 'PLAYER', seat: 1 }, intent: choose(1) });
    expect(chosen.ok).toBe(true);
    if (!chosen.ok) return;
    const shows = chosen.chain.filter(
      (e): e is Extract<typeof e, { kind: 'TRIGGER_TEXT_SHOW' }> => e.kind === 'TRIGGER_TEXT_SHOW',
    );
    const again = shows[shows.length - 1];
    expect(again.blocking).toBe(false);
    expect(again.selected).toBe(1);
    expect(again.options).toEqual(['A', 'B']);
    expect(chosen.state.triggerRuntime?.pendingChoices?.t1).toBeUndefined();
  });
});

describe('选项文本地图校验', () => {
  const map = (triggers: TriggerDef[]): MapFullData => ({
    ...makeMap({ players: THREE_PLAYERS }),
    trigger_schema_version: 2,
    triggers,
  });

  it('接受合法选项文本与已选下标断言', () => {
    expect(
      validateMapData(
        map([
          { id: 'ask', when: { op: 'turn_start', turn: 1 }, effects: [SHOW] },
          {
            id: 'see',
            when: { op: 'state_assert', path: 'gamestate.texts.t1.option', cmp: '=', value: 1 },
            effects: [SHOW],
          },
        ]),
      ),
    ).toBe(true);
  });

  it('拒绝空选项、非法选项模板与未知文本 id', () => {
    const emptyOptions = map([
      {
        id: 'ask',
        when: { op: 'turn_start', turn: 1 },
        effects: [{ ...SHOW, options: [] }],
      },
    ]);
    expect(validateMapData(emptyOptions)).toBe(false);

    const badOption = map([
      {
        id: 'ask',
        when: { op: 'turn_start', turn: 1 },
        effects: [{ ...SHOW, options: ['{gamestate.nope}'] }],
      },
    ]);
    expect(validateMapData(badOption)).toBe(false);

    const unknownText = map([
      {
        id: 'see',
        when: { op: 'state_assert', path: 'gamestate.texts.nope.option', cmp: '=', value: 0 },
        effects: [SHOW],
      },
    ]);
    expect(validateMapData(unknownText)).toBe(false);
  });
});
