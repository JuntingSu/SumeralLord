// §8.1.4/8.1.5 切换阶段与结束回合 / §6.2 轮转 / §8.1.7 加点 / §5 点数
import { describe, it, expect } from 'vitest';
import { makeMap, startGame, assignments, act, actServer, force, soldierAt, chainKinds, CITY, PLAIN, OCEAN } from './helpers.js';

const twoPlayerMap = () =>
  makeMap({
    tiles: {
      6: [CITY, 1, 2],
      12: [CITY, 2, 2],
      7: [PLAIN, 1, 3],
      13: [PLAIN, 2, 3],
    },
  });
const ASG = assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: 102 });

function endTurnOf(state: Parameters<typeof act>[0], seat: number) {
  const a = act(state, seat, { intentType: 'SWITCH_PHASE' }); // ACTION -> ADD_POINT
  expect(a.ok).toBe(true);
  if (!a.ok) throw new Error('switch1 failed');
  const b = act(a.state, seat, { intentType: 'SWITCH_PHASE' }); // -> END -> 结束回合 -> 下一势力准备
  expect(b.ok).toBe(true);
  if (!b.ok) throw new Error('switch2 failed');
  return b;
}

describe('§6.2 阶段切换与回合轮转', () => {
  it('ACTION → ADD_POINT → END →（下一势力准备 → ACTION）', () => {
    const { state } = startGame(twoPlayerMap(), ASG);
    expect(state.phase).toBe('ACTION');
    const a = act(state, 1, { intentType: 'SWITCH_PHASE' });
    expect(a.state.phase).toBe('ADD_POINT');
    const b = act(a.state, 1, { intentType: 'SWITCH_PHASE' });
    // 结束回合：seat1 -> seat2，准备阶段自动完成，直接进入其行动阶段
    expect(b.state.phase).toBe('ACTION');
    expect(b.state.currentSeat).toBe(2);
    expect(b.state.turn).toBe(1);
    expect(chainKinds(b)).toContain('END_TURN');
    expect(chainKinds(b)).toContain('SWITCH_PHASE');
  });

  it('末位回绕：最后存活势力结束回合后全局轮次 +1 回到首势力', () => {
    const { state } = startGame(twoPlayerMap(), ASG);
    const t1 = endTurnOf(state, 1); // -> seat2
    const t2 = endTurnOf(t1.state, 2); // -> seat1, turn 2
    expect(t2.state.currentSeat).toBe(1);
    expect(t2.state.turn).toBe(2);
  });

  it('已灭势力跳过轮转；结束阶段清除该势力所有兵移动力', () => {
    const map3 = makeMap({
      players: [
        { seat: 1, team: 1 },
        { seat: 2, team: 2 },
        { seat: 3, team: 3 },
      ],
      tiles: { 6: [CITY, 1, 2], 7: [PLAIN, 1, 3], 12: [CITY, 2, 2], 16: [CITY, 3, 2] },
    });
    const asg3 = assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: 102 }, { seat: 3, playerId: 103 });
    const { state } = startGame(map3, asg3);
    expect(soldierAt(state, 7)!.hasMovement).toBe(true);
    const r = act(state, 2, { intentType: 'SURRENDER', seat: 2, reason: 'voluntary' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.finished).toBe(false); // 三队局：seat1/3 仍存活
    // seat1 结束回合：跳过已灭 seat2，轮到 seat3
    const t = endTurnOf(r.state, 1);
    expect(t.state.currentSeat).toBe(3);
    expect(t.state.turn).toBe(1);
    // 结束阶段已清除 seat1 兵移动力；seat3 准备阶段发放
    expect(soldierAt(t.state, 7)!.hasMovement).toBe(false);
  });

  it('结束阶段清除移动力', () => {
    const { state } = startGame(twoPlayerMap(), ASG);
    expect(soldierAt(state, 7)!.hasMovement).toBe(true);
    const t = endTurnOf(state, 1);
    expect(t.state.currentSeat).toBe(2);
    expect(soldierAt(t.state, 7)!.hasMovement).toBe(false); // seat1 兵移动力被清
    expect(soldierAt(t.state, 13)!.hasMovement).toBe(true); // seat2 准备阶段发放
  });

  it('准备阶段：点数=连兵数；反击刷新为地形值（含对方兵），阻挡兵除外', () => {
    const map = makeMap({
      tiles: {
        6: [CITY, 1, 2],
        7: [PLAIN, 1, 3],
        12: [CITY, 2, 2],
        13: [PLAIN, 255, 5], // 阻挡兵
        14: [PLAIN, 0, 4], // 野生兵
      },
    });
    const { state } = startGame(map, ASG);
    // seat1 准备：连兵 2（城+7）→ 点数 2
    expect(force(state, 1).points).toBe(2);
    // 阻挡兵反击恒 0、野生兵反击=平原 1
    expect(soldierAt(state, 13)!.counter).toBe(0);
    expect(soldierAt(state, 14)!.counter).toBe(1);
    // seat2 回合：seat2 准备阶段给 seat1 的兵刷新反击 —— 先消耗一次再验证刷新
    const t = endTurnOf(state, 1); // -> seat2
    expect(force(t.state, 2).points).toBe(1); // seat2 连兵 1（城）
    // seat1 的兵在 seat2 准备时被刷新（其反击本就是地形值，无变化）
    expect(soldierAt(t.state, 7)!.counter).toBe(1);
  });
});

describe('AI(255) 自动跳过（D1）', () => {
  it('连续多个 AI 依次跳过，事件链确定', () => {
    const map = makeMap({
      players: [
        { seat: 1, team: 1 },
        { seat: 2, team: 2 },
        { seat: 3, team: 3 },
      ],
      tiles: { 6: [CITY, 1, 2], 12: [CITY, 2, 2], 16: [CITY, 3, 2] },
    });
    const { state } = startGame(
      map,
      assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: null, isAI: true }, { seat: 3, playerId: null, isAI: true }),
    );
    const t = endTurnOf(state, 1);
    // seat2、seat3 均为 AI：同一事件链内连续跳过，回到 seat1，轮次 +1
    expect(t.state.currentSeat).toBe(1);
    expect(t.state.turn).toBe(2);
    expect(t.state.phase).toBe('ACTION');
    const ends = chainKinds(t).filter((k) => k === 'END_TURN');
    expect(ends.length).toBe(3); // seat1→2, 2→3, 3→1
    // AI 回合不产生玩家意图（链中无 MOVE/ATTACK/ADD_POINT）
    expect(chainKinds(t)).not.toContain('MOVE');
    expect(chainKinds(t)).not.toContain('ADD_POINT');
  });

  it('首势力为 AI：initState 后自动跳过到首个玩家势力', () => {
    const map = makeMap({
      players: [
        { seat: 1, team: 1 },
        { seat: 2, team: 2 },
      ],
      tiles: { 6: [CITY, 1, 2], 12: [CITY, 2, 2] },
    });
    const { state, chain } = startGame(map, assignments({ seat: 1, playerId: null, isAI: true }, { seat: 2, playerId: 102 }));
    expect(state.currentSeat).toBe(2);
    expect(state.phase).toBe('ACTION');
    expect(chainKinds({ chain })).toContain('END_TURN');
  });

  it('AI seat 因据点归零被清除后轮转正确继续；仅剩 AI 时胜利判定结束对局', () => {
    const map = makeMap({
      players: [
        { seat: 1, team: 1 },
        { seat: 2, team: 2 },
      ],
      tiles: { 6: [CITY, 1, 2], 12: [CITY, 2, 2], 13: [PLAIN, 2, 3] },
    });
    // 玩家 101 扮 seat1；seat2 为 AI
    const { state } = startGame(map, assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: null, isAI: true }));
    // seat1 进攻 seat2 据点兵：连兵 str2 -> 力 1 === 1：成功（有反击：1-1=0 -> 同归于尽，双方灭）
    // 换 str4 保证击杀且存活：调整地图
    const map2 = makeMap({
      players: [
        { seat: 1, team: 1 },
        { seat: 2, team: 2 },
      ],
      tiles: { 6: [CITY, 1, 4], 12: [CITY, 2, 1] },
    });
    const g2 = startGame(map2, assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: null, isAI: true }));
    // 12 与 6 相邻？12 nbrs = [13,11,7,6,17,16] -> 相邻
    const r = act(g2.state, 1, { intentType: 'ATTACK', from: 6, to: 12 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // seat2(31) 据点兵被灭 -> 据点数 0 -> 势力清除；seat1 单队存活 -> 胜利
    expect(force(r.state, 2).alive).toBe(false);
    expect(r.state.finished).toBe(true);
    expect(r.state.winners).toEqual(['101']);
    expect(r.consensus.map((c) => c.payload.kind)).toEqual(['FORCE_CLEAR', 'VICTORY']);
  });
});

describe('§8.1.7 加点事件 / §5 点数', () => {
  const map = () => makeMap({ tiles: { 6: [CITY, 1, 2], 7: [PLAIN, 1, 3], 12: [CITY, 2, 2] } });

  it('三判定：己方连兵 / 点数充足 / 加点阶段', () => {
    const { state } = startGame(map(), ASG);
    // 行动阶段 -> 拒绝
    expect(act(state, 1, { intentType: 'ADD_POINT', coordinate: 7, amount: 1 })).toMatchObject({ ok: false, reason: 'WRONG_PHASE' });
    const s1 = act(state, 1, { intentType: 'SWITCH_PHASE' });
    // 非连兵目标（无兵地块/他人兵）-> ILLEGAL_MOVE 借用
    expect(act(s1.state, 1, { intentType: 'ADD_POINT', coordinate: 2, amount: 1 })).toMatchObject({ ok: false, reason: 'ILLEGAL_MOVE' });
    expect(act(s1.state, 1, { intentType: 'ADD_POINT', coordinate: 12, amount: 1 })).toMatchObject({ ok: false, reason: 'ILLEGAL_MOVE' });
    // 点数不足（seat1 只有 2 点）
    expect(act(s1.state, 1, { intentType: 'ADD_POINT', coordinate: 7, amount: 3 })).toMatchObject({ ok: false, reason: 'NO_POINTS' });
    // 非当前势力 -> NOT_YOUR_TURN
    expect(act(s1.state, 2, { intentType: 'ADD_POINT', coordinate: 12, amount: 1 })).toMatchObject({ ok: false, reason: 'NOT_YOUR_TURN' });
  });

  it('批量 amount：兵力+amount、点数-amount', () => {
    const { state } = startGame(map(), ASG);
    const s1 = act(state, 1, { intentType: 'SWITCH_PHASE' });
    const r = act(s1.state, 1, { intentType: 'ADD_POINT', coordinate: 7, amount: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(soldierAt(r.state, 7)!.strength).toBe(5);
    expect(force(r.state, 1).points).toBe(0);
    expect(r.chain[0]).toMatchObject({ kind: 'ADD_POINT', amount: 2 });
  });
});

describe('自动切换（补充规则）', () => {
  it('进入行动阶段无可动兵：代玩家自动切换至加点阶段', () => {
    // seat1 仅一个兵力1连兵（无移动力）→ 自动切到 ADD_POINT
    const map = makeMap({ tiles: { 6: [CITY, 1, 1], 12: [CITY, 2, 2] } });
    const { state, chain } = startGame(map, ASG);
    expect(state.currentSeat).toBe(1);
    expect(state.phase).toBe('ADD_POINT');
    const switches = chain.filter((e) => e.kind === 'SWITCH_PHASE').map((e) => ({ from: e.from, to: e.to }));
    expect(switches).toContainEqual({ from: 'ACTION', to: 'ADD_POINT' });
  });

  it('有可动兵时保持行动阶段（不自动切换）', () => {
    const { state } = startGame(twoPlayerMap(), ASG);
    expect(state.phase).toBe('ACTION');
  });

  it('加点用尽：自动切换结束回合；未用尽保持加点阶段', () => {
    // seat1 连兵 6(str1)+7(str2) → 点数 2；7 可动 → 正常进入行动阶段
    const map = makeMap({ tiles: { 6: [CITY, 1, 1], 7: [PLAIN, 1, 2], 12: [CITY, 2, 2] } });
    const { state } = startGame(map, ASG);
    expect(state.phase).toBe('ACTION');
    const s1 = act(state, 1, { intentType: 'SWITCH_PHASE' });
    expect(s1.state.phase).toBe('ADD_POINT');
    // 加 1 点：点数剩 1，仍处加点阶段
    const s2 = act(s1.state, 1, { intentType: 'ADD_POINT', coordinate: 7, amount: 1 });
    expect(s2.ok).toBe(true);
    if (!s2.ok) return;
    expect(force(s2.state, 1).points).toBe(1);
    expect(s2.state.phase).toBe('ADD_POINT');
    // 再加 1 点：点数归零 → 自动切换结束回合
    const s3 = act(s2.state, 1, { intentType: 'ADD_POINT', coordinate: 7, amount: 1 });
    expect(s3.ok).toBe(true);
    if (!s3.ok) return;
    expect(force(s3.state, 1).points).toBe(0);
    expect(s3.state.currentSeat).toBe(2);
    expect(s3.state.phase).toBe('ACTION'); // seat2 进入其行动阶段
    expect(chainKinds(s3)).toContain('END_TURN');
  });

  it('一次性加完所有点数：直接自动结束回合', () => {
    const map = makeMap({ tiles: { 6: [CITY, 1, 1], 7: [PLAIN, 1, 2], 12: [CITY, 2, 2] } });
    const { state } = startGame(map, ASG);
    const s1 = act(state, 1, { intentType: 'SWITCH_PHASE' });
    const r = act(s1.state, 1, { intentType: 'ADD_POINT', coordinate: 7, amount: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.currentSeat).toBe(2);
    expect(chainKinds(r)).toContain('END_TURN');
  });
});
