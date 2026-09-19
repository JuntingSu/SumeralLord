// addpoint.test.ts — 阶段3：加点算法与回合计划组装
import { describe, expect, it } from 'vitest';
import { TERRAIN, applyIntent, hashGameState, initState } from '@dl/shared';
import type { GameState, PlayerIntent } from '@dl/shared';
import { planAddPoints } from '../lib/addpoint.js';
import { planTurnCandidates } from '../lib/turnplan.js';
import { SEED_TE_WEIGHTS } from '../lib/eval.js';
import { generateTrainMap } from '../lib/mapgen.js';
import { makeSoldier, makeState } from './helpers.js';

const P = TERRAIN.PLAIN;
const C = TERRAIN.CITY;

/** 2x3 棋盘：tile3=我城锚，tile4/tile5 成链；敌方从 tile0 一侧推进 */
function chainState(myPoints: number, enemyStrength: number): GameState {
  return makeState({
    rows: 2,
    columns: 3,
    tiles: [
      { terrain: P, soldier: makeSoldier(2, enemyStrength, true, true) }, // 0 敌连兵
      { terrain: P }, // 1
      { terrain: P }, // 2
      { terrain: C, soldier: makeSoldier(1, 3, true, true) }, // 3 我城锚
      { terrain: P, soldier: makeSoldier(1, 2, true, true) }, // 4 割点（去除则 5 脱网）
      { terrain: P, soldier: makeSoldier(1, 2, true, true) }, // 5
    ],
  });
}
// 覆盖 points（makeState 缺省 0）
function withPoints(state: GameState, seat: number, points: number): GameState {
  return { ...state, forces: state.forces.map((f) => (f.seat === seat ? { ...f, points } : f)) };
}

function sumByTile(intents: PlayerIntent[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const i of intents) {
    if (i.intentType === 'ADD_POINT') m.set(i.coordinate, (m.get(i.coordinate) ?? 0) + i.amount);
  }
  return m;
}

describe('规则1 防断电（可达威胁，全有或全无）', () => {
  it('割点按（是否割点、断电规模降序）依次补防：城锚兵（规模3）先于链中割点（规模2）', () => {
    // 敌连兵6（进攻力5）贴脸 tile3（我城兵3）：tile3 威胁5 → need 3；tile4 割点：威胁4 → need 3
    // 排序：tile3（割点，断电规模3）先于 tile4（割点，规模2）；点数6 恰好两者都补
    const state = withPoints(chainState(0, 6), 1, 6);
    const intents = planAddPoints(state, state, 1, SEED_TE_WEIGHTS);
    const m = sumByTile(intents);
    expect(m.get(3)).toBe(3);
    expect(m.get(4)).toBe(3);
    expect([...m.values()].reduce((a, b) => a + b, 0)).toBe(6);
  });

  it('点数不足时整兵跳过（全有或全无）→ 剩余进入规则3（逐点 amount=1）', () => {
    const state = withPoints(chainState(0, 6), 1, 2); // tile3 需3 只有2 → 规则1/2 跳过
    const intents = planAddPoints(state, state, 1, SEED_TE_WEIGHTS);
    const m = sumByTile(intents);
    expect([...m.values()].reduce((a, b) => a + b, 0)).toBe(2); // 规则3 花完
    for (const i of intents) {
      expect(i.intentType).toBe('ADD_POINT'); // 全部为规则3 逐点抽签（无规则1/2 批量防御）
      if (i.intentType === 'ADD_POINT') expect(i.amount).toBe(1);
    }
  });
});

describe('规则2 防击杀（邻格威胁）', () => {
  it('邻格有敌兵的非割点连兵按贴脸威胁补防', () => {
    // tile4 邻格无敌兵（敌在 tile0），但敌断兵贴脸：改造——敌兵直接放 tile2（邻 tile4）
    const state = makeState({
      rows: 2,
      columns: 3,
      tiles: [
        { terrain: P }, // 0
        { terrain: P }, // 1
        { terrain: P, soldier: makeSoldier(2, 4, true, false) }, // 2 敌连兵（邻 tile4）进攻力3
        { terrain: C, soldier: makeSoldier(1, 3, true, true) }, // 3
        { terrain: P, soldier: makeSoldier(1, 2, true, true) }, // 4 非割点？去除→5脱网→是割点！
        { terrain: P, soldier: makeSoldier(1, 2, true, true) }, // 5
      ],
    });
    // tile4 去除 → tile5 脱网 → 是割点 → 走规则1 可达语义。此处验证规则2 需要非割点：
    // 让 tile5 另有锚（放一个我城在 tile2？不行被占）——改为直接构造星形：tile4 有 3 个链邻居。
    // 简化：验证排序——割点 tile4 优先于规则2 对象 tile5（tile5 邻敌兵 tile2？tile5 邻居 = {4,2}）
    const withPoints2 = withPoints(state, 1, 6);
    const intents = planAddPoints(withPoints2, withPoints2, 1, SEED_TE_WEIGHTS);
    const m = sumByTile(intents);
    // tile4（割点，可达威胁 = max(reach[邻格])）：敌连兵4 进攻力3 → tile2 可达 0? battleReach 从 tile2：
    //   tile2 自身 power 3；邻 tile4 我兵2 消耗3 → 0；邻 tile1 空 → 2；tile5 邻 tile4 …
    //   tile4 邻格 {5,3,2,1}：reach[5]？敌到 tile5：2→4(消耗3→0) 停；2→1(2)→… 经 tile1→tile5？tile1 邻 tile5（odd row: (0,1)→(1,1)+(1,-1)? tile1=(0,1) 邻 tile4、tile3、tile2、tile0）
    //   reach[5] 可能经 tile1→? tile1 不邻 tile5。→ tile4 威胁 = max(0,0,3,2)=3 → need = 3+1−2 = 2
    // tile5（非割点，邻敌兵 tile2）威胁 = 3 → need = 3+1−2 = 2
    expect(m.get(4)).toBe(2);
    expect(m.get(5)).toBe(2);
    // 割点先于非割点（意图顺序）
    const firstIdx = intents.findIndex((i) => i.intentType === 'ADD_POINT' && i.coordinate === 4);
    const secondIdx = intents.findIndex((i) => i.intentType === 'ADD_POINT' && i.coordinate === 5);
    expect(firstIdx).toBeGreaterThanOrEqual(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });
});

describe('规则3 E_te 饱和分配', () => {
  it('同局面抽签确定（哈希种子）；总点数花完；只加给连兵', () => {
    const { map } = generateTrainMap('addpoint-det');
    const { state } = initState({
      map,
      seatAssignments: [
        { seat: 1, playerId: 900001, isAI: false },
        { seat: 2, playerId: 900002, isAI: false },
      ],
      seed: 'addpoint-det',
      timeSettings: { stepTime: 30, gameTime: 600, additionalTime: 10 },
    });
    const a = planAddPoints(state, state, 1, SEED_TE_WEIGHTS);
    const b2 = planAddPoints(state, state, 1, SEED_TE_WEIGHTS);
    expect(a).toEqual(b2);
    const total = a.reduce((acc, i) => acc + (i.intentType === 'ADD_POINT' ? i.amount : 0), 0);
    expect(total).toBe(state.forces.find((f) => f.seat === 1)!.points);
    for (const i of a) {
      if (i.intentType === 'ADD_POINT') {
        expect(state.tiles[i.coordinate].soldier?.owner).toBe(1);
        expect(state.tiles[i.coordinate].soldier?.isLinked).toBe(true);
      }
    }
  });

  it('无连兵时不产生加点意图', () => {
    const state = makeState({
      rows: 1,
      columns: 2,
      tiles: [
        { terrain: C, soldier: makeSoldier(1, 3, false, true) }, // 断兵（非连兵）
        { terrain: P },
      ],
    });
    const withPts = withPoints(state, 1, 5);
    const intents = planAddPoints(withPts, withPts, 1, SEED_TE_WEIGHTS);
    expect(intents).toEqual([]);
  });
});

describe('回合计划组装（4 候选）', () => {
  it('真实地图：≤4 计划；意图重放与 resultState 一致；边界为对方 ACTION 相位', () => {
    const { map } = generateTrainMap('turnplan-e2e');
    const { state } = initState({
      map,
      seatAssignments: [
        { seat: 1, playerId: 900001, isAI: false },
        { seat: 2, playerId: 900002, isAI: false },
      ],
      seed: 'turnplan-e2e',
      timeSettings: { stepTime: 30, gameTime: 600, additionalTime: 10 },
    });
    const plans = planTurnCandidates(state, 1, SEED_TE_WEIGHTS);
    expect(plans.length).toBeGreaterThanOrEqual(1);
    expect(plans.length).toBeLessThanOrEqual(4);
    for (const plan of plans) {
      // 重放：行动意图（ACTION 相位门控）→ SWITCH_PHASE → 加点意图
      let cur = state;
      for (const intent of plan.actionIntents) {
        if (cur.phase !== 'ACTION') break;
        const r = applyIntent(cur, { actor: { kind: 'PLAYER', seat: 1 }, intent });
        if (r.ok) cur = r.state;
      }
      for (const intent of plan.addPointIntents) {
        const r = applyIntent(cur, { actor: { kind: 'PLAYER', seat: 1 }, intent });
        if (r.ok) cur = r.state;
      }
      expect(hashGameState(cur)).toBe(hashGameState(plan.resultState));
      // 回合边界：对局结束 或 轮到对方行动阶段
      if (!plan.resultState.finished) {
        expect(plan.resultState.currentSeat).toBe(2);
        expect(plan.resultState.phase).toBe('ACTION');
      }
    }
  });
});
