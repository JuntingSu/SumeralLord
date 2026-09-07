// §8.1.6 初始化事件 / §4.1 连断本质 / §6.3 初始化流程 / §6.4 无主势力与 AI 接管
import { describe, it, expect } from 'vitest';
import { makeMap, startGame, assignments, act, force, soldierAt, chainKinds, CITY, PLAIN, OCEAN, MOUNTAIN, BLOCKER, WILD } from './helpers.js';

// 布局（4 行 5 列，row1/row3 右移）：
// row3: 15 16 17 18 19
// row2: 10 11 12 13 14
// row1:  5  6  7  8  9
// row0:  0  1  2  3  4

describe('§8.1.6 初始化事件与级联重连', () => {
  it('全接地块置连，级联把整个同势力连通网络置为连兵', () => {
    const map = makeMap({
      tiles: {
        6: [CITY, 1, 1],
        1: [PLAIN, 1, 2],
        7: [PLAIN, 1, 2],
        12: [PLAIN, 1, 2],
      },
    });
    const { state, chain } = startGame(map);
    expect(soldierAt(state, 6)!.isLinked).toBe(true);
    expect(soldierAt(state, 1)!.isLinked).toBe(true);
    expect(soldierAt(state, 7)!.isLinked).toBe(true);
    expect(soldierAt(state, 12)!.isLinked).toBe(true);
    // 事件链以 INIT 开头，含 UPDATE（变连）与 REJOIN
    expect(chain[0]).toMatchObject({ level: 1, kind: 'INIT' });
    expect(chainKinds({ chain })).toContain('REJOIN');
  });

  it('半断地块（海洋）强制断兵：即使邻接连兵网络也不变连', () => {
    const map = makeMap({
      tiles: {
        6: [CITY, 1, 1],
        7: [OCEAN, 1, 2], // 7 与 6 相邻
        12: [PLAIN, 1, 2],
      },
    });
    const { state } = startGame(map);
    expect(soldierAt(state, 7)!.isLinked).toBe(false);
    expect(soldierAt(state, 12)!.isLinked).toBe(true);
  });

  it('开局后：首回合准备阶段已自动执行（点数=连兵数、移动力发放、进入行动阶段）', () => {
    const map = makeMap({
      tiles: {
        6: [CITY, 1, 1],
        7: [PLAIN, 1, 3],
        12: [PLAIN, 1, 2],
      },
    });
    const { state } = startGame(map);
    expect(state.currentSeat).toBe(1);
    expect(state.phase).toBe('ACTION');
    expect(state.turn).toBe(1);
    // 连兵数 = 3（城1 + 平原2）→ 点数 3
    expect(force(state, 1).points).toBe(3);
    // 移动力：非兵力1连兵均发放
    expect(soldierAt(state, 7)!.hasMovement).toBe(true);
    expect(soldierAt(state, 12)!.hasMovement).toBe(true);
    // 兵力 1 的连兵（城）始终无移动力
    expect(soldierAt(state, 6)!.hasMovement).toBe(false);
  });
});

describe('§6.4 无主势力删兵', () => {
  const map = makeMap({
    tiles: {
      6: [CITY, 1, 1],
      7: [PLAIN, 1, 2],
      12: [CITY, 2, 1],
      13: [PLAIN, 2, 3],
    },
  });

  it('无玩家且无 AI 的势力：删全部兵、不进轮转与胜负、据点归属视同无主', () => {
    const { state } = startGame(map, assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: null }));
    const f2 = force(state, 2);
    expect(f2.exists).toBe(false);
    expect(f2.alive).toBe(false);
    expect(soldierAt(state, 12)).toBeNull();
    expect(soldierAt(state, 13)).toBeNull();
    // 据点地块保留地形
    expect(state.tiles[12].terrain).toBe(CITY);
    // 不触发胜利（无主势力等同从未存在）
    expect(state.finished).toBe(false);
    // 无主势力不在轮转：seat1 结束回合后回绕自己
    const r = act(state, 1, { intentType: 'SWITCH_PHASE' }); // ACTION → ADD_POINT
    const r2 = act(r.state, 1, { intentType: 'SWITCH_PHASE' }); // → END → 结束回合
    expect(r2.state.turn).toBe(2);
    expect(r2.state.currentSeat).toBe(1);
  });

  it('AI 接管的势力：兵保留、进入轮转、回合由提交方意图推进（reducer 不自动完成）', () => {
    const { state } = startGame(map, assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: null, isAI: true }));
    const f2 = force(state, 2);
    expect(f2.exists).toBe(true);
    expect(f2.alive).toBe(true);
    expect(soldierAt(state, 12)).not.toBeNull();
    expect(soldierAt(state, 13)).not.toBeNull();
    // seat1 结束回合 → 轮到 seat2(AI)：停在行动阶段
    const r = act(state, 1, { intentType: 'SWITCH_PHASE' });
    const r2 = act(r.state, 1, { intentType: 'SWITCH_PHASE' });
    expect(r2.state.currentSeat).toBe(2);
    expect(r2.state.phase).toBe('ACTION');
    // 以 PLAYER seat=2 提交跳过意图可推进其回合（ACTION → ADD_POINT → END → 回到 seat1）
    const a = act(r2.state, 2, { intentType: 'SWITCH_PHASE' });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = act(a.state, 2, { intentType: 'SWITCH_PHASE' });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.state.currentSeat).toBe(1);
    expect(b.state.turn).toBe(2);
    expect(b.state.phase).toBe('ACTION');
  });

  it('computer 值不影响 reducer：AI 回合一律停在行动阶段等待意图提交', () => {
    const map3 = makeMap({
      players: [
        { seat: 1, team: 1 },
        { seat: 2, team: 2, computer: 2 },
      ],
      tiles: {
        6: [CITY, 1, 2],
        12: [CITY, 2, 2],
      },
    });
    const { state } = startGame(map3, assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: null, isAI: true }));
    const r = act(state, 1, { intentType: 'SWITCH_PHASE' });
    const r2 = act(r.state, 1, { intentType: 'SWITCH_PHASE' });
    expect(r2.state.currentSeat).toBe(2);
    expect(r2.state.phase).toBe('ACTION');
    // 难度决策在提交方（planAiTurn），reducer 对 AI 与玩家意图一视同仁
    const a = act(r2.state, 2, { intentType: 'SWITCH_PHASE' });
    const b = act(a.state, 2, { intentType: 'SWITCH_PHASE' });
    expect(b.state.currentSeat).toBe(1);
    expect(b.state.turn).toBe(2);
  });

  it('seatAssignment.computer 覆盖地图默认难度（房主指定 AI 难度落地）', () => {
    const map = makeMap({
      players: [
        { seat: 1, team: 1, computer: 255 },
        { seat: 2, team: 2, computer: 255 },
      ],
      tiles: { 6: [CITY, 1, 2], 12: [CITY, 2, 2] },
    });
    // seat2 由房主指定难度 1（isAI + computer 覆盖）；seat1 未指定
    const { state } = startGame(map, [
      { seat: 1, playerId: 101, isAI: false },
      { seat: 2, playerId: null, isAI: true, computer: 1 },
    ]);
    expect(force(state, 2).computer).toBe(1);
    expect(force(state, 1).computer).toBe(255); // 未指定 → 地图默认
  });
});

describe('中立兵初始状态（§9 前置）', () => {
  it('阻挡兵初始反击为 0，野生兵初始反击为地形值', () => {
    const map = makeMap({
      tiles: {
        6: [CITY, 1, 1],
        7: [PLAIN, BLOCKER, 2],
        12: [PLAIN, WILD, 3],
      },
    });
    const { state } = startGame(map);
    expect(soldierAt(state, 7)!.counter).toBe(0);
    expect(soldierAt(state, 12)!.counter).toBe(1);
  });
});
