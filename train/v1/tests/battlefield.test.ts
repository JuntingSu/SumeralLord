// battlefield.test.ts — 阶段1：四个共享设施单测（战场消耗BFS / 割点 / 断连模拟 / 防护BFS）
import { describe, expect, it } from 'vitest';
import { TERRAIN } from '@dl/shared';
import { battleReach, cutVertices, linkedSet, linkedSetAfterRemoval, protectionCost, threatenedNeighborCount } from '../lib/battlefield.js';
import { extractBoard } from '../lib/board.js';
import { lineState, makeSoldier, makeState } from './helpers.js';

const P = TERRAIN.PLAIN;
const C = TERRAIN.CITY;

describe('battleReach（战场消耗 BFS）', () => {
  it('连兵多步推进：空格消耗1、敌兵格消耗=兵力+1；打不动的兵不可达', () => {
    // line: [敌城锚点5, 敌连兵5, 空, 空, 我兵2, 空]
    const state = lineState([
      { terrain: C, soldier: makeSoldier(2, 5, true) },
      { terrain: P, soldier: makeSoldier(2, 5, true) },
      { terrain: P },
      { terrain: P },
      { terrain: P, soldier: makeSoldier(1, 2, true) },
      { terrain: P },
    ]);
    const b = extractBoard(state);
    const reach = battleReach(b, 2);
    expect(reach[0]).toBe(4); // 兵力5连兵，进攻力4
    expect(reach[1]).toBe(4); // 己方源格
    expect(reach[2]).toBe(3);
    expect(reach[3]).toBe(2);
    expect(reach[4]).toBe(-1); // 进攻力2 < 我兵消耗3，吃不动
    expect(reach[5]).toBe(-1);
  });

  it('敌兵足够强时可以吃穿并继续推进', () => {
    const state = lineState([
      { terrain: C, soldier: makeSoldier(2, 5, true) },
      { terrain: P, soldier: makeSoldier(2, 9, true) },
      { terrain: P },
      { terrain: P, soldier: makeSoldier(1, 2, true) },
      { terrain: P },
    ]);
    const b = extractBoard(state);
    const reach = battleReach(b, 2);
    // 兵力9连兵（进攻力8）：tile2 空(7) → tile3 我兵2（消耗3 → 4）→ tile4 空（3）
    expect(reach[2]).toBe(7);
    expect(reach[3]).toBe(4);
    expect(reach[4]).toBe(3);
  });

  it('断兵源单步推进（只能进攻一次）', () => {
    const state = lineState([
      { terrain: P, soldier: makeSoldier(2, 9, false) },
      { terrain: P },
      { terrain: P },
    ]);
    const b = extractBoard(state);
    const reach = battleReach(b, 2);
    expect(reach[0]).toBe(9);
    expect(reach[1]).toBe(8);
    expect(reach[2]).toBe(-1); // 断兵不能第二步
  });

  it('阻挡兵不可通过、野生兵可通过消耗+1', () => {
    const state = lineState([
      { terrain: P, soldier: makeSoldier(2, 5, true) },
      { terrain: P, soldier: makeSoldier(255, 3, false) }, // 阻挡
      { terrain: P },
    ]);
    const b = extractBoard(state);
    const blocked = battleReach(b, 2);
    expect(blocked[1]).toBe(-1);
    expect(blocked[2]).toBe(-1);

    const state2 = lineState([
      { terrain: P, soldier: makeSoldier(2, 5, true) },
      { terrain: P, soldier: makeSoldier(0, 9, false) }, // 野生
      { terrain: P },
    ]);
    const b2 = extractBoard(state2);
    const wild = battleReach(b2, 2);
    expect(wild[1]).toBe(3); // 野生：可通过、消耗 +1
    expect(wild[2]).toBe(2);
  });
});

describe('断连模拟与割点判定', () => {
  it('直线链：除末端外均为割点；移除中段后下游脱离网络', () => {
    // line: [城锚点3, 兵2, 兵2, 兵2, 空, 空]
    const state = lineState([
      { terrain: C, soldier: makeSoldier(1, 3, true) },
      { terrain: P, soldier: makeSoldier(1, 2, true) },
      { terrain: P, soldier: makeSoldier(1, 2, true) },
      { terrain: P, soldier: makeSoldier(1, 2, true) },
      { terrain: P },
      { terrain: P },
    ]);
    const b = extractBoard(state);
    expect([...linkedSet(b, 1)].sort()).toEqual([0, 1, 2, 3]);
    const after = linkedSetAfterRemoval(b, 1, new Set([1]));
    expect([...after].sort()).toEqual([0]); // tile2、tile3 断电脱离
    const cuts = cutVertices(b, 1);
    expect(cuts.sort()).toEqual([0, 1, 2]); // 末端 tile3 不是割点
  });

  it('威胁排除：周围有 ≥2 威胁性敌兵的连兵被排除（E_ape 语义）', () => {
    // 2x3 棋盘：tile3=城锚点，tile4、tile5 成链；tile1/tile2 为敌方断兵
    const state = makeState({
      rows: 2,
      columns: 3,
      tiles: [
        { terrain: P },                                          // 0 (0,0)
        { terrain: P, soldier: makeSoldier(2, 1, false) },       // 1 (0,1) 敌断兵
        { terrain: P, soldier: makeSoldier(2, 1, false) },       // 2 (0,2) 敌断兵
        { terrain: C, soldier: makeSoldier(1, 3, true) },        // 3 (1,0) 锚点
        { terrain: P, soldier: makeSoldier(1, 2, true) },        // 4 (1,1)
        { terrain: P, soldier: makeSoldier(1, 2, true) },        // 5 (1,2)
      ],
    });
    const b = extractBoard(state);
    // tile4 邻居含 tile1、tile2 两个敌断兵 → 威胁数 2
    expect(threatenedNeighborCount(b, 1, 4)).toBe(2);
    const cuts = cutVertices(b, 1);
    expect(cuts.sort()).toEqual([3, 4]);
    const cutsExcl = cutVertices(b, 1, { excludeThreatened: true });
    expect(cutsExcl).toEqual([3]);
  });
});

describe('protectionCost（0-1 防护 BFS）', () => {
  it('敌方据点最小代价：空格0、我方断兵+1、我方连兵不可通过', () => {
    // line: [坏型(我连兵), 我断兵, 空, 敌据点兵, ...]
    const state = lineState([
      { terrain: P, soldier: makeSoldier(1, 3, true) },  // 0 起点（坏型）
      { terrain: P, soldier: makeSoldier(1, 2, false) }, // 1 我方断兵 +1
      { terrain: P },                                    // 2 空 0
      { terrain: C, soldier: makeSoldier(2, 5, true) },  // 3 敌据点 = 目标
      { terrain: P },
    ]);
    const b = extractBoard(state);
    expect(protectionCost(b, 1, 0)).toBe(1); // 0→1(+1)→2(0)→3(0) = 1
  });

  it('我方连兵阻挡时绕路或不可达', () => {
    // line: [坏型, 我连兵(阻挡), 敌据点] → 直路被连兵封死 → 不可达
    const state = lineState([
      { terrain: P, soldier: makeSoldier(1, 3, true) },
      { terrain: P, soldier: makeSoldier(1, 4, true) },
      { terrain: C, soldier: makeSoldier(2, 5, true) },
    ]);
    const b = extractBoard(state);
    expect(protectionCost(b, 1, 0)).toBe(Infinity);
  });
});
