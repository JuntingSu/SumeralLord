// features.test.ts — 阶段1：E_te 6 特征与 E_ape 4 特征逐项手工小局面验证
import { describe, expect, it } from 'vitest';
import { TERRAIN } from '@dl/shared';
import { apeFeatures, teFeatures } from '../lib/features.js';
import { lineState, makeSoldier, makeState } from './helpers.js';

const P = TERRAIN.PLAIN;
const C = TERRAIN.CITY;

describe('E_te 特征', () => {
  it('f1 子力差值：我总兵力 − sqrt(敌总兵力×(敌总兵力+敌连兵数))', () => {
    const end = lineState([
      { terrain: C, soldier: makeSoldier(1, 4, true) },
      { terrain: P, soldier: makeSoldier(1, 6, true) }, // 我总 10
      { terrain: P, soldier: makeSoldier(2, 5, true) },
      { terrain: P, soldier: makeSoldier(2, 4, false) }, // 敌总 9，敌连兵 1
      { terrain: P },
    ]);
    const f = teFeatures(end, end, 1);
    expect(f[0]).toBeCloseTo(10 - Math.sqrt(9 * 10), 10);
  });

  it('f2 连兵差值：双快照差分', () => {
    const start = lineState([
      { terrain: C, soldier: makeSoldier(1, 3, true) },
      { terrain: P, soldier: makeSoldier(1, 2, false) }, // 我连兵 1
      { terrain: C, soldier: makeSoldier(2, 5, true) },
      { terrain: P, soldier: makeSoldier(2, 2, true) }, // 敌连兵 2
      { terrain: P },
    ]);
    const end = lineState([
      { terrain: C, soldier: makeSoldier(1, 3, true) },
      { terrain: P, soldier: makeSoldier(1, 2, true) }, // 我连兵 2
      { terrain: C, soldier: makeSoldier(2, 5, true) },
      { terrain: P, soldier: makeSoldier(2, 2, false) }, // 敌连兵 1
      { terrain: P },
    ]);
    // (2−1) − (1−2) = 1 − (−1) = 2
    expect(teFeatures(end, start, 1)[1]).toBe(2);
  });

  it('f3 网络脆弱性：边界兵被吃引发断电的连兵减少量', () => {
    // line: [敌城5, 敌连兵4, 空, 我兵1, 我兵2, 我城锚3]
    const end = lineState([
      { terrain: C, soldier: makeSoldier(2, 5, true) },
      { terrain: P, soldier: makeSoldier(2, 4, true) },
      { terrain: P },
      { terrain: P, soldier: makeSoldier(1, 1, true) },
      { terrain: P, soldier: makeSoldier(1, 2, true) },
      { terrain: C, soldier: makeSoldier(1, 3, true) },
    ]);
    // 敌网络 {0,1,2,3}；我边界兵 = tile3（邻居 tile4 我兵不在网络）
    // 吃 tile3：我连兵 {3,4,5} → {4,5}，减少 1
    expect(teFeatures(end, end, 1)[2]).toBe(1);
  });

  it('f3 组合：多个边界兵一起吃掉引发更大断电', () => {
    // line: [敌城9, 敌连兵9, 我兵1, 我兵1, 我兵1, 我城锚3] —— 敌方可吃穿整条链
    const end = lineState([
      { terrain: C, soldier: makeSoldier(2, 9, true) },
      { terrain: P, soldier: makeSoldier(2, 9, true) },
      { terrain: P, soldier: makeSoldier(1, 1, true) },
      { terrain: P, soldier: makeSoldier(1, 1, true) },
      { terrain: P, soldier: makeSoldier(1, 1, true) },
      { terrain: C, soldier: makeSoldier(1, 3, true) },
    ]);
    // 敌兵1（进攻力8）：tile2(7) tile3 我兵1 消耗2 → 5, tile4 → 3, tile5 我兵3 消耗4 → −1
    // 网络 = {0,1,2,3,4}；我方兵在网络内：tile2/3/4；边界兵 = tile4（邻居 tile5 我兵不在网络）
    // 组合 {tile4}：tile4 是桥——被吃后 tile2、tile3 断电脱离 + 自身被吃 → 损失 3（{2,3,4,5} → {5}）
    expect(teFeatures(end, end, 1)[2]).toBe(3);
  });

  it('f4 网络可靠性：强化敌连兵连续吃链，值 = 连兵减少²/总损失', () => {
    // line: [敌城5, 敌连兵6, 我兵1, 我兵1, 我兵1, 我城锚3]
    const end = lineState([
      { terrain: C, soldier: makeSoldier(2, 5, true) },
      { terrain: P, soldier: makeSoldier(2, 6, true) },
      { terrain: P, soldier: makeSoldier(1, 1, true) },
      { terrain: P, soldier: makeSoldier(1, 1, true) },
      { terrain: P, soldier: makeSoldier(1, 1, true) },
      { terrain: C, soldier: makeSoldier(1, 3, true) },
    ]);
    // 敌连兵数 = 2（tile0/tile1）。候选按距我兵最近：tile1(1)、tile0(2)。
    // tile1 子局面：S = 6+2 = 8；吃 tile2(消耗2,S=6) → tile3(4) → tile4(2)；
    //   tile5 我兵3：进攻力1 < 3 停。损失 = {2,3,4} 被吃+断电 → 我连兵 4 → 1，损失 3；总消耗 6 → 9/6 = 1.5
    // tile0 子局面：S = 5+2 = 7；邻居仅 tile1（敌方）→ 无可吃 → 0
    expect(teFeatures(end, end, 1)[3]).toBeCloseTo(1.5, 10);
  });

  it('f5 我方威胁性：可达格 Σ max(0, 1−d/B)', () => {
    // line: [我城锚3, 空, 空, 空, 敌城5]：我连兵（兵力3，进攻力2）可达 {0,1,2}
    const end = lineState([
      { terrain: C, soldier: makeSoldier(1, 3, true) },
      { terrain: P },
      { terrain: P },
      { terrain: P },
      { terrain: C, soldier: makeSoldier(2, 5, true) },
    ]);
    // B = 5；d(tile0)=4, d(tile1)=3, d(tile2)=2 → 0.2+0.4+0.6 = 1.2
    expect(teFeatures(end, end, 1)[4]).toBeCloseTo(1.2, 10);
  });

  it('f6 叫杀得分：兵临敌据点且敌可加点数 < 兵力', () => {
    const base = (myStrength: number) =>
      lineState([
        { terrain: C, soldier: makeSoldier(1, 3, true) },
        { terrain: P, soldier: makeSoldier(1, myStrength, true) }, // 与敌城距离1
        { terrain: C, soldier: makeSoldier(2, 5, true) }, // 敌连兵数 = 1
      ]);
    expect(teFeatures(base(5), base(5), 1)[5]).toBe(1); // 1 < 5
    expect(teFeatures(base(1), base(1), 1)[5]).toBe(0); // 1 < 1 不成立
  });
});

describe('E_ape 特征', () => {
  it('f1 兵力差净变化 / f2 可靠连兵差净变化（无威胁排除时）', () => {
    // start：我总12（连兵3）敌总8（连兵2）
    const start = lineState([
      { terrain: C, soldier: makeSoldier(1, 6, true) },
      { terrain: P, soldier: makeSoldier(1, 3, true) },
      { terrain: P, soldier: makeSoldier(1, 3, true) },
      { terrain: C, soldier: makeSoldier(2, 4, true) },
      { terrain: P, soldier: makeSoldier(2, 4, true) },
    ]);
    // post：反击损耗1个我兵、吃掉1个敌兵：我总10（连兵3）敌总4（连兵1）
    // f1 = (10−4) − (12−8) = 2；f2 = (3−1) − (3−2) = 1
    const post = lineState([
      { terrain: C, soldier: makeSoldier(1, 6, true) },
      { terrain: P, soldier: makeSoldier(1, 3, true) },
      { terrain: P, soldier: makeSoldier(1, 1, true) },
      { terrain: C, soldier: makeSoldier(2, 4, true) },
      { terrain: P },
    ]);
    const f = apeFeatures(post, start, 1);
    expect(f[0]).toBe(2);
    expect(f[1]).toBe(1);
  });

  it('f2 威胁排除（2x3 棋盘）', () => {
    const mkState = (myTile1Linked: boolean) =>
      makeState({
        rows: 2,
        columns: 3,
        tiles: [
          { terrain: P },                                     // 0
          { terrain: P, soldier: makeSoldier(2, 1, false) },  // 1 敌断兵
          { terrain: P, soldier: makeSoldier(2, 1, false) },  // 2 敌断兵
          { terrain: C, soldier: makeSoldier(1, 3, true) },   // 3 我城锚
          { terrain: P, soldier: makeSoldier(1, 2, myTile1Linked) }, // 4 我连兵（被2威胁）
          { terrain: P, soldier: makeSoldier(1, 2, true) },   // 5 我连兵
        ],
      });
    // post：我连兵 {3,4,5}，tile4 有 2 威胁性敌兵 → 有效 = 2；敌连兵 = 0
    // start（同一局面，排除不生效）→ 我连兵 3；敌连兵 0 → f2 = (2−0) − (3−0) = −1
    const post = mkState(true);
    expect(apeFeatures(post, post, 1)[1]).toBe(-1);
  });

  it('f3 坏型数：割点 × 防护衰减因子', () => {
    // 2x3：我城锚 tile3，链 tile4-tile5；tile4 为割点（被威胁排除外）；
    // 此处无敌方据点 → protectionCost = Infinity → factor 0 → f3 = 0
    const post = makeState({
      rows: 2,
      columns: 3,
      tiles: [
        { terrain: P },
        { terrain: P },
        { terrain: P },
        { terrain: C, soldier: makeSoldier(1, 3, true) },
        { terrain: P, soldier: makeSoldier(1, 2, true) },
        { terrain: P, soldier: makeSoldier(1, 2, true) },
      ],
    });
    expect(apeFeatures(post, post, 1)[2]).toBe(0);
  });

  it('f3 坏型数：有敌方据点可防护时 factor = 1 − 0.2x', () => {
    // 2x3：敌方据点兵在 tile2（与 tile5 相邻），我方据点在 tile3；
    // 割点 = tile3（去除则 4、5 断电）；tile4 不是割点（去除只少自己）？
    //   ——去除 tile4 → tile5 脱离 → tile4 是割点；但 tile4 有威胁排除检查（无威胁敌兵）→ 保留
    // x(tile3)：tile3→tile4(我连兵,不可过)→tile5(我连兵,不可过) → 不可达 Infinity；
    //   但 tile3 邻 tile1(空,0)→tile2(敌方据点,0)= 目标 → x=0 → factor 1
    // x(tile4)：tile4 邻 tile1(空,0)→tile2 目标 x=0；tile4→tile2 直达 x=0 → factor 1
    // f3 = 1×1 + 1×1 = 2（tile3、tile4 均为坏型且无威胁包围）
    const post = makeState({
      rows: 2,
      columns: 3,
      tiles: [
        { terrain: P },                                    // 0
        { terrain: P },                                    // 1
        { terrain: C, soldier: makeSoldier(2, 5, true) },  // 2 敌据点
        { terrain: C, soldier: makeSoldier(1, 3, true) },  // 3 我据点（锚）
        { terrain: P, soldier: makeSoldier(1, 2, true) },  // 4
        { terrain: P, soldier: makeSoldier(1, 2, true) },  // 5
      ],
    });
    expect(apeFeatures(post, post, 1)[2]).toBeCloseTo(2, 10);
  });

  it('f4 我方威胁程度：2 − d/B', () => {
    // line: [我城3, 我兵2, 空, 空, 敌城5]：d = min(我兵×敌城) = 3（tile1）；B = 5
    const post = lineState([
      { terrain: C, soldier: makeSoldier(1, 3, true) },
      { terrain: P, soldier: makeSoldier(1, 2, true) },
      { terrain: P },
      { terrain: P },
      { terrain: C, soldier: makeSoldier(2, 5, true) },
    ]);
    expect(apeFeatures(post, post, 1)[3]).toBeCloseTo(2 - 3 / 5, 10);
  });
});
