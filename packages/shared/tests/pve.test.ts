import { describe, expect, it } from 'vitest';
import { defaultPveSetup, isPvePlayableMap, normalizeAiLevel } from '../src/index.js';
import { makeMap } from './helpers.js';

describe('PVE 默认设置', () => {
  it('玩家默认 seat1，其余全部简单', () => {
    const map = makeMap({ players: [{ seat: 1 }, { seat: 2 }, { seat: 3 }] });
    expect(defaultPveSetup(map)).toEqual({ playerSeat: 1, aiLevels: { 2: 1, 3: 1 } });
  });

  it('没有 seat1 时取最小 seat', () => {
    const map = makeMap({ players: [{ seat: 3 }, { seat: 5 }] });
    expect(defaultPveSetup(map)).toEqual({ playerSeat: 3, aiLevels: { 5: 1 } });
  });
});

describe('normalizeAiLevel', () => {
  it('2→普通，3/255→休闲，其余→简单', () => {
    expect(normalizeAiLevel(1)).toBe(1);
    expect(normalizeAiLevel(2)).toBe(2);
    expect(normalizeAiLevel(3)).toBe(255);
    expect(normalizeAiLevel(255)).toBe(255);
    expect(normalizeAiLevel(0)).toBe(1);
    expect(normalizeAiLevel(4)).toBe(1);
  });
});

describe('isPvePlayableMap', () => {
  it('至少 2 势力且不超过 255×255', () => {
    expect(isPvePlayableMap({ playerNum: 2, row: 255, column: 255 })).toBe(true);
    expect(isPvePlayableMap({ playerNum: 1, row: 15, column: 15 })).toBe(false);
    expect(isPvePlayableMap({ playerNum: 2, row: 256, column: 15 })).toBe(false);
  });
});
