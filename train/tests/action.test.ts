// action.test.ts — 阶段2：行动阶段三段式算法逐行为对拍
import { describe, expect, it } from 'vitest';
import { TERRAIN, applyIntent, initState } from '@dl/shared';
import type { GameState, PlayerIntent } from '@dl/shared';
import { planActionPhase } from '../lib/action.js';
import { generateTrainMap } from '../lib/mapgen.js';
import { lineState, makeSoldier, makeState } from './helpers.js';

const P = TERRAIN.PLAIN;
const C = TERRAIN.CITY;
const O = TERRAIN.OCEAN;

/** 应用意图序列（跳过被拒的），返回终局与拒绝数 */
function replay(state: GameState, seat: number, intents: PlayerIntent[]) {
  let cur = state;
  let rejects = 0;
  for (const intent of intents) {
    const r = applyIntent(cur, { actor: { kind: 'PLAYER', seat }, intent });
    if (r.ok) cur = r.state;
    else rejects++;
  }
  return { state: cur, rejects };
}

describe('铺场与锁兵链', () => {
  it('连兵铺场后锁兵继续推进（链意图来自生成兵）', () => {
    const state = lineState([
      { terrain: C, soldier: makeSoldier(1, 3, true, true) },
      { terrain: P, soldier: makeSoldier(1, 5, true, true) },
      { terrain: P },
      { terrain: P },
      { terrain: P },
      { terrain: C, soldier: makeSoldier(2, 9, true, true) },
    ]);
    const plans = planActionPhase(state, 1);
    expect(plans.length).toBeGreaterThanOrEqual(1);
    const first = plans[0].intents;
    expect(first.length).toBeGreaterThanOrEqual(1);
    expect(first[0].intentType).toBe('MOVE');
    const { rejects } = replay(state, 1, plans[0].intents);
    expect(rejects).toBe(0);
  });

  it('链中生成兵连续铺场：同一兵的移动序列', () => {
    const state = lineState([
      { terrain: C, soldier: makeSoldier(1, 3, true, true) },
      { terrain: P, soldier: makeSoldier(1, 9, true, true) },
      { terrain: P },
      { terrain: P },
      { terrain: P },
      { terrain: P, soldier: makeSoldier(2, 9, true, true) },
    ]);
    const plans = planActionPhase(state, 1);
    // 最优链应是把 9 兵一路铺到最远（每步 −1）
    const longest = plans.reduce((a, p) => (p.intents.length > a.intents.length ? p : a), plans[0]);
    const moves = longest.intents.filter((i) => i.intentType === 'MOVE') as Array<{ from: number; to: number }>;
    expect(moves.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < moves.length; i++) {
      expect(moves[i].from).toBe(moves[i - 1].to); // 锁兵：上一生成兵继续行动
    }
  });
});

describe('就近进攻', () => {
  it('进攻力 ≥ 防守兵力时生成 ATTACK 意图并吃掉敌兵', () => {
    const state = lineState([
      { terrain: C, soldier: makeSoldier(1, 3, true, true) },
      { terrain: P, soldier: makeSoldier(1, 6, true, true) },
      { terrain: P, soldier: makeSoldier(2, 4, true, false) },
      { terrain: P },
    ]);
    const plans = planActionPhase(state, 1);
    const attackPlan = plans.find((p) => p.intents.some((i) => i.intentType === 'ATTACK' && i.to === 2));
    expect(attackPlan).toBeDefined();
    const { state: after } = replay(state, 1, attackPlan!.intents);
    const t2 = after.tiles[2].soldier;
    expect(t2 && t2.owner).toBe(1); // 敌兵被吃
  });
});

describe('前置行为：进攻据点', () => {
  it('Σ进攻力 > 据点防守兵力时，方案以 ATTACK 据点为前缀', () => {
    // 我兵3(tile3) 邻 敌城(tile4, 守1)：Σ=2 > 1 → 前置成立
    const state = lineState([
      { terrain: C, soldier: makeSoldier(1, 3, true, true) },
      { terrain: P, soldier: makeSoldier(1, 3, true, true) },
      { terrain: P },
      { terrain: P, soldier: makeSoldier(1, 3, true, true) },
      { terrain: C, soldier: makeSoldier(2, 1, true, true) },
    ]);
    const plans = planActionPhase(state, 1);
    expect(plans.length).toBeGreaterThanOrEqual(1);
    for (const p of plans) {
      expect(p.intents[0]).toEqual({ intentType: 'ATTACK', from: 3, to: 4 }); // 前置链必须为前缀
    }
    const { state: after } = replay(state, 1, plans[0].intents);
    expect(after.tiles[4].soldier?.owner).toBe(1); // 据点被攻占
  });

  it('Σ进攻力不大于防守兵力时无前置链', () => {
    const state = lineState([
      { terrain: C, soldier: makeSoldier(1, 3, true, true) },
      { terrain: P },
      { terrain: P },
      { terrain: P, soldier: makeSoldier(1, 3, true, true) },
      { terrain: C, soldier: makeSoldier(2, 9, true, true) },
    ]);
    const plans = planActionPhase(state, 1);
    for (const p of plans) {
      const first = p.intents[0];
      if (first.intentType === 'ATTACK') {
        expect(first.to).not.toBe(4); // 不会直接进攻打不动的据点（就近/远海条件不满足）
      }
    }
  });
});

describe('兑换与原点剪枝', () => {
  it('等兵力水路兑换成立时，原点仅保留兑换/自杀分支', () => {
    // 我连兵4(tile1) 邻空海洋(tile2)：下海复制−1 → 到达兵力3；敌海洋兵3：到达==X → 兑换（同归于尽）
    const state = lineState([
      { terrain: C, soldier: makeSoldier(1, 3, true, true) },
      { terrain: P, soldier: makeSoldier(1, 4, true, true) },
      { terrain: O },
      { terrain: O, soldier: makeSoldier(2, 3, false, true) },
      { terrain: O },
    ]);
    const plans = planActionPhase(state, 1);
    expect(plans.length).toBeGreaterThanOrEqual(1);
    // 原点剪枝：所有方案的第一意图必须是兑换（MOVE 下海 + ATTACK）或自杀，不允许铺场开头
    for (const p of plans) {
      expect(['MOVE', 'ATTACK']).toContain(p.intents[0].intentType);
    }
    const ex = plans.find((q) => q.intents.length >= 2 && q.intents[0].intentType === 'MOVE' && q.intents[1].intentType === 'ATTACK');
    expect(ex).toBeDefined();
    // 兑换执行：A 与 X 同归于尽（进攻力==兵力 → 反击归零 → 双删）
    const { state: after } = replay(state, 1, ex!.intents);
    expect(after.tiles[3].soldier).toBeNull(); // X 死
    expect(after.tiles[2].soldier).toBeNull(); // A 同归
  });
});

describe('自杀与消耗战循环', () => {
  it('A 必败进攻后，补刀 B 继续进攻 X 直到成功', () => {
    // X = tile3 敌兵2；A = tile4 我断兵1（进攻力1 < 2 必败，到达兵力1）；
    // B = tile2 我连兵4 邻 X：到达兵力4 > 1 ✓（自杀条件②成立 → 原点剪枝仅保留自杀分支）
    // 消耗战：A 进攻失败 → X 剩 1 → B 进攻成功吃掉 X
    const state = lineState([
      { terrain: C, soldier: makeSoldier(1, 3, true, true) },
      { terrain: P },
      { terrain: P, soldier: makeSoldier(1, 4, true, true) },
      { terrain: P, soldier: makeSoldier(2, 2, false, true) },
      { terrain: P, soldier: makeSoldier(1, 1, false, true) },
    ]);
    const plans = planActionPhase(state, 1);
    // 原点存在自杀 → 剪枝后所有方案从 A 的必败 ATTACK 开始
    expect(plans.length).toBeGreaterThanOrEqual(1);
    const suicidePlan = plans.find((p) => p.intents.length > 0 && p.intents[0].intentType === 'ATTACK' && p.intents[0].from === 4);
    expect(suicidePlan).toBeDefined();
    const { state: after } = replay(state, 1, suicidePlan!.intents);
    expect(after.tiles[3].soldier?.owner).toBe(1); // X 最终被 B 吃掉
  });

  it('海洋断兵自杀新情形：A 牺牲后 B 新获得远海进攻能力 → 允许 A 自杀（海洋消耗战）', () => {
    // 2x4：t0 我城锚；t5 我连兵B；t1 海洋断兵A(str2)；t2 敌海洋兵X(str3)（A 邻 X 必败）
    // A 进攻前：B 无航道（t1 被 A 占据、t2 被 X 占据）→ 不能远海进攻 X
    // A 必败进攻后：A 死（X 反击）→ t1 空出、X 削弱到 1 → B 可下海 t1 远海进攻 X → 新能力出现
    const state = makeState({
      rows: 2,
      columns: 4,
      tiles: [
        { terrain: O }, // 0 (0,0) 空海洋
        { terrain: O, soldier: makeSoldier(1, 2, false, true) }, // 1 (0,1) 海洋断兵 A
        { terrain: O, soldier: makeSoldier(2, 3, false, true) }, // 2 (0,2) 敌海洋兵 X
        { terrain: P }, // 3 (0,3) 空平原
        { terrain: C, soldier: makeSoldier(1, 3, true, true) }, // 4 (1,0) 我城锚
        { terrain: P, soldier: makeSoldier(1, 4, true, true) }, // 5 (1,1) 我连兵 B（邻 t1/t2）
        { terrain: P }, // 6 (1,2)
        { terrain: P }, // 7 (1,3)
      ],
    });
    const plans = planActionPhase(state, 1);
    // 原点剪枝：存在自杀 → 方案以 A 的 ATTACK(1→2) 开始（新情形允许）
    const suicidePlan = plans.find((p) => p.intents.length > 0 && p.intents[0].intentType === 'ATTACK' && p.intents[0].from === 1 && p.intents[0].to === 2);
    expect(suicidePlan).toBeDefined();
    // 消耗战继续：A 死后 B 下海补刀吃掉 X（X 削弱到 1，B 远海进攻成功）
    const { state: after } = replay(state, 1, suicidePlan!.intents);
    expect(after.tiles[2].soldier?.owner).toBe(1); // X 被 B 吃掉（海洋）
  });
});

describe('防守行为段', () => {
  it('兵力1断兵下海改善 E_ape（威胁推进）时被批准并附加于方案尾部', () => {
    // 我断兵1(tile1) 邻空海洋(tile2)；下海后 f4 威胁改善 → 批准
    const state = lineState([
      { terrain: C, soldier: makeSoldier(1, 3, true, true) },
      { terrain: P, soldier: makeSoldier(1, 1, false, true) },
      { terrain: O },
      { terrain: O },
      { terrain: O },
      { terrain: C, soldier: makeSoldier(2, 9, true, true) },
    ]);
    const plans = planActionPhase(state, 1);
    expect(plans.length).toBeGreaterThanOrEqual(1);
    const plan = plans[0];
    // 叶子无基础行为（断兵只能下海=防守；城锚兵无目标）→ 方案 = 防守意图
    expect(plan.intents).toEqual([{ intentType: 'MOVE', from: 1, to: 2 }]);
    const { state: after, rejects } = replay(state, 1, plan.intents);
    expect(rejects).toBe(0);
    expect(after.tiles[2].soldier?.owner).toBe(1); // 下海成断兵
    expect(after.tiles[2].soldier?.isLinked).toBe(false);
  });
});

describe('真实地图端到端', () => {
  it('initState 后生成 ≤4 个候选方案，意图全部可应用', () => {
    const { map } = generateTrainMap('action-e2e');
    const { state } = initState({
      map,
      seatAssignments: [
        { seat: 1, playerId: 900001, isAI: false },
        { seat: 2, playerId: 900002, isAI: false },
      ],
      seed: 'action-e2e',
      timeSettings: { stepTime: 30, gameTime: 600, additionalTime: 10 },
    });
    expect(state.phase).toBe('ACTION');
    const plans = planActionPhase(state, 1);
    expect(plans.length).toBeGreaterThanOrEqual(1);
    expect(plans.length).toBeLessThanOrEqual(4);
    for (const p of plans) {
      const { rejects } = replay(state, 1, p.intents);
      expect(rejects).toBe(0);
    }
  });
});
