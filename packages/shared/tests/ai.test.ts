// AI 策略层（意图入流）：planAiTurn 难度1 返回意图序列（状态Ⅰ/Ⅱ），难度 2/3/255 保持 skip；
// reducer 不再自动完成 AI 回合（initState 停在 AI 席位），AI 意图以 PLAYER seat=AI 路径应用。
import { describe, it, expect } from 'vitest';
import { makeMap, startGame, assignments, act, CITY, PLAIN, MOUNTAIN, BLOCKER, WILD } from './helpers.js';
import { buildAiView, listAiActions, planAiTurn, applyIntent } from '../src/index.js';

const aiMap = (computer: number) =>
  makeMap({
    players: [
      { seat: 1, team: 1, computer: 255 },
      { seat: 2, team: 2, computer },
    ],
    tiles: {
      6: [CITY, 1, 2],
      12: [CITY, 2, 2],
      7: [PLAIN, 1, 3],
      13: [PLAIN, 2, 3],
    },
  });

describe('planAiTurn：难度分派', () => {
  it.each([2, 3, 255])('computer=%d 保持 skip（休闲语义）', (computer) => {
    const { state } = startGame(
      aiMap(computer),
      assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: null, isAI: true }),
    );
    expect(planAiTurn(state, 2)).toEqual({ kind: 'skip' });
  });

  it('难度1 返回 intents；整个计划可完整应用并完成 AI 回合', () => {
    const map = makeMap({
      players: [
        { seat: 1, team: 1, computer: 1 },
        { seat: 2, team: 2 },
      ],
      tiles: { 0: [CITY, 1, 2], 6: [CITY, 2, 2] },
    });
    const { state } = startGame(map, assignments({ seat: 1, playerId: null, isAI: true }, { seat: 2, playerId: 102 }));
    // 首势力为 AI：initState 停在行动阶段（不再自动完成/自动跳过）
    expect(state.currentSeat).toBe(1);
    expect(state.phase).toBe('ACTION');
    const plan = planAiTurn(state, 1);
    expect(plan.kind).toBe('intents');
    if (plan.kind !== 'intents') return;
    expect(plan.intents.length).toBeGreaterThan(0);
    // 逐步应用整个计划（模拟与真实应用共用同一 reducer）：全部可执行，AI 回合完成
    let cur = state;
    for (const intent of plan.intents) {
      const r = applyIntent(cur, { actor: { kind: 'PLAYER', seat: 1 }, intent });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      cur = r.state;
    }
    expect(cur.currentSeat).toBe(2);
    expect(cur.phase).toBe('ACTION');
  });

  it('确定性：同 seed 同局面两次决策结果全等', () => {
    const map = makeMap({
      players: [
        { seat: 1, team: 1, computer: 1 },
        { seat: 2, team: 2 },
      ],
      tiles: { 0: [CITY, 1, 2], 6: [CITY, 2, 2] },
    });
    const a = startGame(map, assignments({ seat: 1, playerId: null, isAI: true }, { seat: 2, playerId: 102 }), 'seed-1');
    const b = startGame(map, assignments({ seat: 1, playerId: null, isAI: true }, { seat: 2, playerId: 102 }), 'seed-1');
    expect(planAiTurn(a.state, 1)).toEqual(planAiTurn(b.state, 1));
  });
});

describe('难度1 行动阶段（状态Ⅰ）', () => {
  it('坐标交换例外：同兵力两兵恰好两个且唯一更强兵 C 坐标更大 → 坐标大的先行动', () => {
    const map = makeMap({
      players: [
        { seat: 1, team: 1, computer: 1 },
        { seat: 2, team: 2 },
      ],
      tiles: {
        0: [CITY, 1, 1], // 锚点据点（兵力1，不在可动池）
        1: [PLAIN, 1, 2], // A
        2: [PLAIN, 1, 2], // B
        9: [CITY, 1, 3], // C：唯一更强、坐标最大，周围是敌据点（无可扩张空平原）
        4: [CITY, 2, 2],
        8: [CITY, 2, 2],
        14: [CITY, 2, 2],
      },
    });
    const { state } = startGame(map, assignments({ seat: 1, playerId: null, isAI: true }, { seat: 2, playerId: 102 }));
    const plan = planAiTurn(state, 1);
    expect(plan.kind).toBe('intents');
    if (plan.kind !== 'intents') return;
    // 正序 = [C, B, A]（坐标交换后 B 在 A 前）→ 扩张判定先命中 B（坐标 2）
    expect(plan.intents[0]).toMatchObject({ intentType: 'MOVE', from: 2 });
  });

  it('坐标交换例外不触发：C 坐标小于 A、B → 坐标小的先行动', () => {
    const map = makeMap({
      players: [
        { seat: 1, team: 1, computer: 1 },
        { seat: 2, team: 2 },
      ],
      tiles: {
        0: [CITY, 1, 3], // C：坐标最小
        1: [PLAIN, 1, 2], // A
        4: [PLAIN, 1, 2], // B
        3: [CITY, 1, 1], // 锚点据点
        5: [CITY, 2, 2], // 敌据点（邻 C 与 A）
      },
    });
    const { state } = startGame(map, assignments({ seat: 1, playerId: null, isAI: true }, { seat: 2, playerId: 102 }));
    const plan = planAiTurn(state, 1);
    expect(plan.kind).toBe('intents');
    if (plan.kind !== 'intents') return;
    // 正序 = [C, A, B]（无交换）→ 扩张判定先命中 A（坐标 1）
    expect(plan.intents[0]).toMatchObject({ intentType: 'MOVE', from: 1 });
  });

  it('正攻判定α（步骤2）：周围存在无反击敌兵 → 进攻其中兵力最大者', () => {
    const map = makeMap({
      players: [
        { seat: 1, team: 1, computer: 1 },
        { seat: 2, team: 2 },
      ],
      tiles: {
        0: [PLAIN, 1, 3], // AI 断兵
        1: [PLAIN, BLOCKER, 4], // 阻挡兵（反击 0，兵力更大）
        5: [PLAIN, WILD, 2], // 野生兵（反击 1）
        6: [CITY, 2, 2],
      },
    });
    const { state } = startGame(map, assignments({ seat: 1, playerId: null, isAI: true }, { seat: 2, playerId: 102 }));
    const plan = planAiTurn(state, 1);
    expect(plan.kind).toBe('intents');
    if (plan.kind !== 'intents') return;
    expect(plan.intents[0]).toMatchObject({ intentType: 'ATTACK', from: 0, to: 1 });
  });

  it('正攻判定β（步骤4）：进攻力 ≥ 相邻具反击敌兵兵力 → 进攻其中兵力最小者', () => {
    const map = makeMap({
      players: [
        { seat: 1, team: 1, computer: 1 },
        { seat: 2, team: 2 },
      ],
      tiles: {
        0: [CITY, 1, 3], // AI 连兵（进攻力 2）
        1: [PLAIN, 2, 2], // 敌断兵（兵力 2，可击败）
        5: [PLAIN, 2, 3], // 敌断兵（兵力 3，不可击败）
      },
    });
    const { state } = startGame(map, assignments({ seat: 1, playerId: null, isAI: true }, { seat: 2, playerId: 102 }));
    const plan = planAiTurn(state, 1);
    expect(plan.kind).toBe('intents');
    if (plan.kind !== 'intents') return;
    expect(plan.intents[0]).toMatchObject({ intentType: 'ATTACK', from: 0, to: 1 });
  });

  it('移动判定（步骤5）：断兵向最近敌对据点 A* 路径移动一格（目标为敌兵格时 MOVE 转进攻）', () => {
    const map = makeMap({
      players: [
        { seat: 1, team: 1, computer: 1 },
        { seat: 2, team: 2 },
      ],
      tiles: {
        0: [PLAIN, 1, 3], // AI 断兵（进攻力 3 < 敌兵力 4，无法正攻）
        1: [CITY, 2, 4], // 敌对据点
      },
    });
    const { state } = startGame(map, assignments({ seat: 1, playerId: null, isAI: true }, { seat: 2, playerId: 102 }));
    const plan = planAiTurn(state, 1);
    expect(plan.kind).toBe('intents');
    if (plan.kind !== 'intents') return;
    expect(plan.intents[0]).toMatchObject({ intentType: 'MOVE', from: 0, to: 1 });
  });

  it('夹击判定（步骤6）：友兵合力可击败最强相邻敌兵 → 进攻该敌兵', () => {
    const map = makeMap({
      players: [
        { seat: 1, team: 1, computer: 1 },
        { seat: 2, team: 2 },
      ],
      tiles: {
        0: [PLAIN, 1, 2], // x：断兵，进攻力 2
        1: [PLAIN, 2, 5], // z：敌断兵（兵力 5，反击 1）
        5: [PLAIN, 1, 4], // y：友兵（进攻力 4），与 x、z 均相邻
      },
    });
    const { state } = startGame(map, assignments({ seat: 1, playerId: null, isAI: true }, { seat: 2, playerId: 102 }));
    const plan = planAiTurn(state, 1);
    expect(plan.kind).toBe('intents');
    if (plan.kind !== 'intents') return;
    // x 进攻力 2 + y 进攻力 4 = 6 > z 兵力 5 → 夹击 z
    expect(plan.intents[0]).toMatchObject({ intentType: 'ATTACK', from: 0, to: 1 });
  });

  it('敢死判定（步骤7）：存在被围死的同队友兵 → 牺牲自己进攻兵力最大的敌兵', () => {
    const map = makeMap({
      players: [
        { seat: 1, team: 1, computer: 1 },
        { seat: 2, team: 2 },
      ],
      tiles: {
        0: [PLAIN, 1, 2], // x：断兵，进攻力 2 < 敌兵力 5
        1: [PLAIN, 2, 5], // z：敌兵（兵力 5，反击 1）
        18: [CITY, 1, 5], // y：友兵（进攻力 4），被山地围死、远离战场
        13: [MOUNTAIN, 128, 0],
        14: [MOUNTAIN, 128, 0],
        17: [MOUNTAIN, 128, 0],
        19: [MOUNTAIN, 128, 0],
      },
    });
    const { state } = startGame(map, assignments({ seat: 1, playerId: null, isAI: true }, { seat: 2, playerId: 102 }));
    const plan = planAiTurn(state, 1);
    expect(plan.kind).toBe('intents');
    if (plan.kind !== 'intents') return;
    expect(plan.intents[0]).toMatchObject({ intentType: 'ATTACK', from: 0, to: 1 });
  });
});

describe('难度1 加点阶段（状态Ⅱ）', () => {
  it('防守压力超支：D_k > 当前点数 → 逐点随机全分给该类并结束回合', () => {
    const map = makeMap({
      players: [
        { seat: 1, team: 1, computer: 1 },
        { seat: 2, team: 2 },
      ],
      tiles: {
        0: [CITY, 1, 2], // AI 连兵据点（防守压力 d=3-2+1=2 > 点数 1）
        1: [PLAIN, 2, 3], // 敌断兵（进攻力 3）
      },
    });
    const { state } = startGame(map, assignments({ seat: 1, playerId: null, isAI: true }, { seat: 2, playerId: 102 }));
    // AI 首势力处于行动阶段 → 手动切到加点阶段（点数 = 连兵数 1）
    const r = act(state, 1, { intentType: 'SWITCH_PHASE' });
    expect(r.state.phase).toBe('ADD_POINT');
    const plan = planAiTurn(r.state, 1);
    expect(plan).toEqual({ kind: 'intents', intents: [{ intentType: 'ADD_POINT', coordinate: 0, amount: 1 }] });
  });

  it('无点数：直接跳过阶段结束回合', () => {
    const map = makeMap({
      players: [
        { seat: 1, team: 1, computer: 1 },
        { seat: 2, team: 2 },
      ],
      tiles: { 0: [PLAIN, 1, 2], 6: [CITY, 2, 2] }, // AI 仅断兵（0 连兵 → 0 点数）
    });
    const { state } = startGame(map, assignments({ seat: 1, playerId: null, isAI: true }, { seat: 2, playerId: 102 }));
    const r = act(state, 1, { intentType: 'SWITCH_PHASE' });
    expect(r.state.phase).toBe('ADD_POINT');
    const plan = planAiTurn(r.state, 1);
    expect(plan).toEqual({ kind: 'intents', intents: [{ intentType: 'SWITCH_PHASE' }] });
  });
});

describe('reducer 行为（AI 意图入流）', () => {
  it('首势力为 AI：initState 停在 AI 席位，不自动完成', () => {
    const { state } = startGame(
      aiMap(1),
      assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: null, isAI: true }),
    );
    // 首势力为玩家（seat1）：正常开始
    expect(state.currentSeat).toBe(1);
    expect(state.phase).toBe('ACTION');
  });

  it('玩家结束回合 → 轮到 AI 席位停在行动阶段；以 PLAYER seat=AI 提交的意图被接受', () => {
    const { state } = startGame(
      aiMap(1),
      assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: null, isAI: true }),
    );
    const a = act(state, 1, { intentType: 'SWITCH_PHASE' });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = act(a.state, 1, { intentType: 'SWITCH_PHASE' });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.state.currentSeat).toBe(2); // AI 席位，不再自动完成
    expect(b.state.phase).toBe('ACTION');
    // AI 席位（seat2）的意图可正常应用（MOVE/ATTACK/ADD_POINT/SWITCH_PHASE 同玩家路径）
    const plan = planAiTurn(b.state, 2);
    expect(plan.kind).toBe('intents');
    if (plan.kind !== 'intents') return;
    let cur = b.state;
    for (const intent of plan.intents) {
      const r = act(cur, 2, intent);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      cur = r.state;
    }
  });
});

describe('buildAiView（战场信息接口，策略输入）', () => {
  it('我方/敌方兵、据点、连兵、总兵力信息正确', () => {
    const { state } = startGame(
      aiMap(3),
      assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: null, isAI: true }),
    );
    const view = buildAiView(state, 1);
    expect(view).not.toBeNull();
    if (!view) return;
    expect(view.seat).toBe(1);
    expect(view.computer).toBe(255);
    expect(view.phase).toBe('ACTION');
    expect(view.me?.strongholdCount).toBe(1);
    expect(view.me?.linkedCount).toBe(2); // 据点 6 与平原 7 开局级联连兵
    expect(view.me?.totalStrength).toBe(5);
    expect(view.me?.soldiers.map((s) => s.tile)).toEqual([6, 7]);
    expect(view.me?.soldiers.every((s) => s.isLinked)).toBe(true);
    expect(view.others.map((o) => o.seat)).toEqual([2]);
    expect(view.others[0].computer).toBe(3);
    expect(view.others[0].strongholdCount).toBe(1);
    expect(view.neutralSoldiers).toEqual([]);
  });

  it('中立兵单独归集（野生/阻挡）；阻挡兵反击为 0', () => {
    const map = makeMap({
      tiles: {
        6: [CITY, 1, 2],
        12: [CITY, 2, 2],
        7: [PLAIN, 0, 4], // 野生
        13: [PLAIN, 255, 5], // 阻挡
      },
    });
    const { state } = startGame(map, assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: 102 }));
    const view = buildAiView(state, 1);
    expect(view?.neutralSoldiers.map((s) => s.tile)).toEqual([7, 13]);
    expect(view?.neutralSoldiers.find((s) => s.tile === 13)?.counter).toBe(0);
  });

  it('seat 不存在返回 null；确定性：同输入两次调用输出全等', () => {
    const { state } = startGame(
      aiMap(1),
      assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: null, isAI: true }),
    );
    expect(buildAiView(state, 99)).toBeNull();
    expect(buildAiView(state, 1)).toEqual(buildAiView(state, 1));
  });
});

describe('listAiActions（合法行动枚举，与 reducer 前置一致）', () => {
  it('行动阶段：枚举 MOVE（空目标）与 ATTACK（非同队目标）；每个选项可被 reducer 执行', () => {
    const { state } = startGame(aiMap(255), assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: 102 }));
    const options = listAiActions(state, 1);
    expect(options.length).toBeGreaterThan(0);
    expect(options.some((o) => o.kind === 'ATTACK' && o.from === 6 && o.to === 12)).toBe(true);
    expect(options.some((o) => o.kind === 'ATTACK' && o.from === 7 && o.to === 13)).toBe(true);
    expect(options.some((o) => o.kind === 'MOVE')).toBe(true);
    // 与 reducer 执行一致：每个选项按意图应用均合法
    for (const o of options) {
      const r = act(state, 1, { intentType: o.kind, from: o.from, to: o.to });
      expect(r.ok).toBe(true);
    }
  });

  it('同队目标不枚举进攻；兵力 1 连兵不可动', () => {
    const map = makeMap({
      players: [
        { seat: 1, team: 1 },
        { seat: 2, team: 1 }, // 同队
      ],
      tiles: {
        6: [CITY, 1, 1], // 兵力 1 连兵（据点）→ 无移动力
        7: [PLAIN, 1, 3],
        12: [CITY, 2, 2],
      },
    });
    const { state } = startGame(map, assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: 102 }));
    const options = listAiActions(state, 1);
    expect(options.some((o) => o.from === 6)).toBe(false);
    expect(options.some((o) => o.kind === 'ATTACK' && o.to === 12)).toBe(false);
    expect(options.some((o) => o.from === 7)).toBe(true);
  });

  it('非自己回合 / 非行动阶段返回空', () => {
    const { state } = startGame(aiMap(255), assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: 102 }));
    expect(listAiActions(state, 2)).toEqual([]); // 非当前行动势力
    const a = act(state, 1, { intentType: 'SWITCH_PHASE' }); // → ADD_POINT
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(listAiActions(a.state, 1)).toEqual([]);
  });
});
