// AI 策略层（D1/D3 拍板）：planAiTurn v1 恒跳过（难度 1~3 与 255 行为一致）；
// buildAiView / listAiActions 战场信息接口（未来难度策略的输入与行动枚举）
import { describe, it, expect } from 'vitest';
import { makeMap, startGame, assignments, act, chainKinds, CITY, PLAIN } from './helpers.js';
import { buildAiView, listAiActions, planAiTurn } from '../src/index.js';

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

describe('planAiTurn（v1：难度 1~3 与 255 统一跳过）', () => {
  it.each([1, 2, 3, 255])('computer=%d 恒返回 skip', (computer) => {
    const { state } = startGame(
      aiMap(computer),
      assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: null, isAI: true }),
    );
    expect(planAiTurn(state, 2)).toEqual({ kind: 'skip' });
  });
});

describe('AI(1~3) 回合自动跳过（D3：与 255 行为一致）', () => {
  it.each([1, 2, 3])('computer=%d：轮到即跳过，事件链确定、无玩家意图', (computer) => {
    const map = makeMap({
      players: [
        { seat: 1, team: 1 },
        { seat: 2, team: 2, computer },
        { seat: 3, team: 3, computer },
      ],
      tiles: { 6: [CITY, 1, 2], 12: [CITY, 2, 2], 16: [CITY, 3, 2] },
    });
    const { state } = startGame(
      map,
      assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: null, isAI: true }, { seat: 3, playerId: null, isAI: true }),
    );
    // seat1 结束回合 → seat2、seat3（AI 1~3）连续跳过 → 回到 seat1，轮次 +1
    const a = act(state, 1, { intentType: 'SWITCH_PHASE' });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = act(a.state, 1, { intentType: 'SWITCH_PHASE' });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.state.currentSeat).toBe(1);
    expect(b.state.turn).toBe(2);
    expect(b.state.phase).toBe('ACTION');
    expect(chainKinds(b).filter((k) => k === 'END_TURN').length).toBe(3);
    expect(chainKinds(b)).not.toContain('MOVE');
    expect(chainKinds(b)).not.toContain('ADD_POINT');
  });

  it('首势力为 AI(2)：initState 自动跳过到首个玩家势力', () => {
    const { state } = startGame(aiMap(2), assignments({ seat: 1, playerId: null, isAI: true }, { seat: 2, playerId: 102 }));
    expect(state.currentSeat).toBe(2);
    expect(state.phase).toBe('ACTION');
  });
});

describe('buildAiView（战场信息接口，未来策略输入）', () => {
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
