import { describe, expect, it } from 'vitest';
import { stripJsonComments, validateMapData } from '../src/index.js';
import { makeMap } from './helpers.js';

describe('validateMapData', () => {
  it('接受合法地图', () => {
    expect(validateMapData(makeMap())).toBe(true);
  });

  it('拒绝地块数量与行列不符', () => {
    const map = makeMap();
    map.battlefield.pop();
    expect(validateMapData(map)).toBe(false);
  });

  it('拒绝重复 seat', () => {
    const map = makeMap();
    map.player_list[1].seat = map.player_list[0].seat;
    expect(validateMapData(map)).toBe(false);
  });

  it('拒绝非法地形（废弃编码 2）', () => {
    const map = makeMap();
    map.battlefield[0] = [2, 128, 0];
    expect(validateMapData(map)).toBe(false);
  });

  it('拒绝非法归属/负兵力', () => {
    const map = makeMap();
    map.battlefield[0] = [0, 200, 0];
    expect(validateMapData(map)).toBe(false);
    map.battlefield[0] = [0, 128, -1];
    expect(validateMapData(map)).toBe(false);
  });
});

describe('stripJsonComments', () => {
  it('剥离行注释且不破坏字符串内的 //', () => {
    const raw = `{
      // 行注释
      "title": "http://example.com/a//b",
      "n": 1 // 尾注释
    }`;
    const parsed = JSON.parse(stripJsonComments(raw)) as { title: string; n: number };
    expect(parsed.title).toBe('http://example.com/a//b');
    expect(parsed.n).toBe(1);
  });
});
