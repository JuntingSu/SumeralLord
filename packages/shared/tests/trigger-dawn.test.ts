// 昏晓战役触发器测试：文本 a → 任意意图隐藏 → 坐标3空则文本 b → 占领坐标3后隐藏 b 并生成下一势力 99 兵。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyIntent, initState, nextAfterPlayer, validateMapData } from '../src/index.js';
import type { GameEvent, GameState, InitStateResult, MapFullData } from '../src/index.js';
import { DEFAULT_TIME, assignments } from './helpers.js';

const MAP_PATH = fileURLToPath(new URL('../../../dawn-trigger.json', import.meta.url));
const MAP = JSON.parse(readFileSync(MAP_PATH, 'utf8')) as MapFullData;

function initGame(controlledSeat = 1, humanPlayerId = 1): InitStateResult {
  return initState({
    map: MAP,
    seatAssignments: assignments(
      { seat: 1, playerId: controlledSeat === 1 ? humanPlayerId : null, isAI: controlledSeat !== 1 },
      { seat: 2, playerId: controlledSeat === 2 ? humanPlayerId : null, isAI: controlledSeat !== 2 },
    ),
    timeSettings: DEFAULT_TIME,
    seed: 'dawn-seed',
    triggerMode: true,
    controlledSeat,
    humanPlayerId,
  });
}

function addPlayerSoldier(state: GameState, tile: number): GameState {
  const s = structuredClone(state);
  s.tiles[tile].soldier = {
    owner: 1,
    strength: 1,
    isLinked: false,
    hasMovement: true,
    counter: 1,
  };
  return s;
}

const move = (from: number, to: number) => ({ intentType: 'MOVE' as const, from, to });

function fired(chain: GameEvent[], triggerId: string): boolean {
  return chain.some((e) => e.kind === 'TRIGGER_FIRE' && e.triggerId === triggerId);
}
function textShown(chain: GameEvent[], textId: string): boolean {
  return chain.some((e) => e.kind === 'TRIGGER_TEXT_SHOW' && e.textId === textId);
}
function textHidden(chain: GameEvent[], textId: string): boolean {
  return chain.some((e) => e.kind === 'TRIGGER_TEXT_HIDE' && e.textId === textId);
}
function shownPlacement(chain: GameEvent[], textId: string) {
  for (const e of chain) {
    if (e.kind === 'TRIGGER_TEXT_SHOW' && e.textId === textId) return e.placement;
  }
  return undefined;
}

describe('dawn-trigger.json', () => {
  it('validates and shows text a at the player first ACTION start', () => {
    expect(validateMapData(MAP)).toBe(true);
    const init = initGame();
    expect(fired(init.chain, 'show-a')).toBe(true);
    expect(textShown(init.chain, 'dawn-a')).toBe(true);
    expect(shownPlacement(init.chain, 'dawn-a')).toEqual({ kind: 'screen', position: 'top' });
    expect(init.state.triggerRuntime?.firedCounts['show-a']).toBe(1);
  });

  it('hides text a after any player intent and shows text b when tile 3 is empty', () => {
    const init = initGame();
    const r = applyIntent(init.state, {
      actor: { kind: 'PLAYER', seat: 1 },
      intent: { intentType: 'SWITCH_PHASE' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fired(r.chain, 'hide-a')).toBe(true);
    expect(textHidden(r.chain, 'dawn-a')).toBe(true);
    expect(fired(r.chain, 'show-b')).toBe(true);
    expect(textShown(r.chain, 'dawn-b')).toBe(true);
    expect(shownPlacement(r.chain, 'dawn-b')).toEqual({ kind: 'tile', tile: 3 });
  });

  it('hides text b and spawns the next force 99-soldier after tile 3 is occupied', () => {
    const init = initGame();
    const s1 = addPlayerSoldier(init.state, 2);
    const first = applyIntent(s1, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(2, 11) });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(textShown(first.chain, 'dawn-b')).toBe(true);

    const s2 = addPlayerSoldier(first.state, 4);
    const second = applyIntent(s2, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(4, 3) });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(fired(second.chain, 'hide-b')).toBe(true);
    expect(textHidden(second.chain, 'dawn-b')).toBe(true);
    expect(fired(second.chain, 'spawn-next-force')).toBe(true);
    expect(second.state.tiles[4].soldier).toMatchObject({ owner: 2, strength: 99 });
    expect(second.state.triggerRuntime?.firedCounts['show-b']).toBe(1);
    expect(second.state.triggerRuntime?.firedCounts['hide-b']).toBe(1);
    expect(second.state.triggerRuntime?.firedCounts['spawn-next-force']).toBe(1);
  });

  it('does not show text b when the first intent already occupies tile 3', () => {
    const init = initGame();
    const s1 = addPlayerSoldier(init.state, 2);
    const r = applyIntent(s1, { actor: { kind: 'PLAYER', seat: 1 }, intent: move(2, 3) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fired(r.chain, 'hide-b')).toBe(true);
    expect(fired(r.chain, 'spawn-next-force')).toBe(true);
    expect(textShown(r.chain, 'dawn-b')).toBe(false);
    expect(r.state.triggerRuntime?.firedCounts['show-b']).toBeUndefined();
    expect(r.state.tiles[4].soldier).toMatchObject({ owner: 2, strength: 99 });
  });

  it('resolves next_after_player from the controlled seat', () => {
    const init = initGame();
    expect(nextAfterPlayer(init.state)).toBe(2);
    const init2 = initGame(2, 2);
    expect(nextAfterPlayer(init2.state)).toBe(1);
  });

  it('shows text a when the player is seat 2 and their first turn starts after the AI', () => {
    const init = initGame(2, 2);
    expect(fired(init.chain, 'show-a')).toBe(false);

    let cur = init.state;
    for (let i = 0; i < 2; i++) {
      const r = applyIntent(cur, { actor: { kind: 'AI', seat: 1 }, intent: { intentType: 'SWITCH_PHASE' } });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      cur = r.state;
      if (i === 1) {
        expect(fired(r.chain, 'show-a')).toBe(true);
        expect(textShown(r.chain, 'dawn-a')).toBe(true);
      }
    }
    expect(cur.currentSeat).toBe(2);
    expect(cur.phase).toBe('ACTION');
  });

  it('rejects invalid text placements during map validation', () => {
    const make = (placement: unknown) =>
      ({
        ...MAP,
        triggers: [
          {
            id: 'bad-placement',
            when: { op: 'tile_owner_changed', tile: 0, from: 'any', to: 'null' },
            effects: [{ op: 'show_text', text_id: 'bad', text: 'bad', placement }],
          },
        ],
      }) as unknown as MapFullData;
    expect(validateMapData(make({ kind: 'screen', position: 'top-left' }))).toBe(true);
    expect(validateMapData(make({ kind: 'screen', position: 'center' }))).toBe(true);
    expect(validateMapData(make({ kind: 'tile', tile: 3 }))).toBe(true);
    expect(validateMapData(make({ kind: 'screen', position: 'middle' }))).toBe(false);
    expect(validateMapData(make({ kind: 'tile', tile: 999 }))).toBe(false);
    expect(validateMapData(make({ kind: 'tile' }))).toBe(false);
    expect(validateMapData(make({ position: 'top' }))).toBe(false);
  });
});
