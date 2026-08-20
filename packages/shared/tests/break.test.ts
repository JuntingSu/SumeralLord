// §8.3.2 断连事件 / §8.4.1 断连判定 / §8.4.3 胜利判定 / §8.1.3 投降
import { describe, it, expect } from 'vitest';
import { makeMap, startGame, assignments, act, actServer, force, soldierAt, chainKinds, CITY, PLAIN, OCEAN, WILD } from './helpers.js';

const ASG = assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: 102 });

describe('§8.3.2 断连事件（环图）', () => {
  it('删除连兵使网络分裂：两分支各发断连判定，断侧全域变断兵、兵力-1', () => {
    // seat1 网络：6(据点) - 7 - 13 链；seat2 击杀 7 → 13 失连
    const map = makeMap({
      tiles: {
        6: [CITY, 1, 2],
        7: [PLAIN, 1, 2],
        13: [PLAIN, 1, 2],
        2: [CITY, 2, 6], // seat2 据点，与 7 相邻
      },
    });
    const { state } = startGame(map, ASG);
    expect(soldierAt(state, 13)!.isLinked).toBe(true);
    // 轮到 seat2：seat1 结束回合
    const a = act(state, 1, { intentType: 'SWITCH_PHASE' });
    const b = act(a.state, 1, { intentType: 'SWITCH_PHASE' });
    expect(b.state.currentSeat).toBe(2);
    // seat2 连兵 str6 -> 力 5 >= 2：击杀 7（反击 1：6-2=4）
    const r = act(b.state, 2, { intentType: 'ATTACK', from: 2, to: 7 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 13 不再连到据点：断连判定 → 断兵、兵力 2-1=1
    expect(soldierAt(r.state, 13)).toMatchObject({ isLinked: false, strength: 1 });
    // 6 仍连（自身据点）
    expect(soldierAt(r.state, 6)!.isLinked).toBe(true);
    // 链中包含 BREAK 与 BREAK_JUDGE
    expect(chainKinds(r)).toContain('BREAK');
    expect(chainKinds(r)).toContain('BREAK_JUDGE');
  });

  it('连通不分裂：旁路存在时删除中间兵不改变连断', () => {
    // seat1 网络环：6(据点) - 7 - 13 - 12，12 与 6 相邻成环
    const map = makeMap({
      tiles: {
        6: [CITY, 1, 2],
        7: [PLAIN, 1, 2],
        13: [PLAIN, 1, 2],
        12: [PLAIN, 1, 2],
        2: [CITY, 2, 6],
      },
    });
    const { state } = startGame(map, ASG);
    const a = act(state, 1, { intentType: 'SWITCH_PHASE' });
    const b = act(a.state, 1, { intentType: 'SWITCH_PHASE' });
    const r = act(b.state, 2, { intentType: 'ATTACK', from: 2, to: 7 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 13 仍可通过 12 连到 6
    expect(soldierAt(r.state, 13)!.isLinked).toBe(true);
    expect(soldierAt(r.state, 13)!.strength).toBe(2); // 未受断连判定影响
  });

  it('断连判定归零删兵：断侧兵力 1 的兵被判删', () => {
    const map = makeMap({
      tiles: {
        6: [CITY, 1, 2],
        7: [PLAIN, 1, 2],
        13: [PLAIN, 1, 1], // 断后 1-1=0 删除
        2: [CITY, 2, 6],
      },
    });
    const { state } = startGame(map, ASG);
    const a = act(state, 1, { intentType: 'SWITCH_PHASE' });
    const b = act(a.state, 1, { intentType: 'SWITCH_PHASE' });
    const r = act(b.state, 2, { intentType: 'ATTACK', from: 2, to: 7 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 7 被击杀后由 seat2 进占（str4）；13 断连判定 1-1=0 归零删除
    expect(soldierAt(r.state, 7)).toMatchObject({ owner: 2 });
    expect(soldierAt(r.state, 13)).toBeNull();
  });

  it('BFS 连到据点即终止：断连判定不改变仍连通的区域', () => {
    // 删除锚点兵（据点上的兵）但该势力另有据点兵维持连通
    const map = makeMap({
      tiles: {
        6: [CITY, 1, 1],
        5: [CITY, 1, 2], // 第二据点，与 6/11 相邻
        11: [PLAIN, 1, 2], // 11 与 6、5 相邻
        2: [CITY, 2, 6],
      },
    });
    const { state } = startGame(map, ASG);
    const a = act(state, 1, { intentType: 'SWITCH_PHASE' });
    const b = act(a.state, 1, { intentType: 'SWITCH_PHASE' });
    // seat2 攻 6（据点兵，str1，反击1）：力 5 >= 1 击杀；反击 6-1=5
    const r = act(b.state, 2, { intentType: 'ATTACK', from: 2, to: 6 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 11 仍通过 5 连到据点：保持连兵
    expect(soldierAt(r.state, 11)!.isLinked).toBe(true);
  });
});

describe('§8.4.3 胜利判定 / §8.1.3 投降', () => {
  it('投降无条件清除：删全部兵、清空点数、产出共识 FORCE_CLEAR(surrender)', () => {
    const map = makeMap({ tiles: { 6: [CITY, 1, 2], 7: [PLAIN, 1, 3], 12: [CITY, 2, 2] } });
    const { state } = startGame(map, ASG);
    const r = act(state, 1, { intentType: 'SURRENDER', seat: 1, reason: 'voluntary' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(force(r.state, 1).alive).toBe(false);
    expect(force(r.state, 1).points).toBe(0);
    expect(soldierAt(r.state, 6)).toBeNull();
    expect(soldierAt(r.state, 7)).toBeNull();
    // 当前行动势力投降 -> 结束回合到 seat2
    expect(r.state.currentSeat).toBe(2);
    expect(r.consensus).toContainEqual({
      payload: { kind: 'FORCE_CLEAR', seat: 1, reason: 'surrender' },
      nodeSeat: 1,
    });
  });

  it('玩家只能投降自己；已清除 seat 重复投降 -> SEAT_CLEARED；SERVER 只能代发 timeout', () => {
    const map = makeMap({
      players: [
        { seat: 1, team: 1 },
        { seat: 2, team: 2 },
        { seat: 3, team: 3 },
      ],
      tiles: { 6: [CITY, 1, 2], 12: [CITY, 2, 2], 16: [CITY, 3, 2] },
    });
    const asg = assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: 102 }, { seat: 3, playerId: 103 });
    const { state } = startGame(map, asg);
    expect(act(state, 1, { intentType: 'SURRENDER', seat: 2 })).toMatchObject({ ok: false, reason: 'NOT_YOUR_TURN' });
    expect(actServer(state, { intentType: 'SURRENDER', seat: 1, reason: 'voluntary' })).toMatchObject({ ok: false, reason: 'NOT_YOUR_TURN' });
    const r = actServer(state, { intentType: 'SURRENDER', seat: 1, reason: 'timeout' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.finished).toBe(false); // 三队局：seat2/3 仍存活，对局未结束
    expect(r.consensus).toContainEqual({
      payload: { kind: 'FORCE_CLEAR', seat: 1, reason: 'timeout' },
      nodeSeat: 1,
    });
    // 重复投降 -> SEAT_CLEARED
    expect(act(r.state, 1, { intentType: 'SURRENDER', seat: 1 })).toMatchObject({ ok: false, reason: 'SEAT_CLEARED' });
  });

  it('胜负按全部势力（含已灭）的队伍归属玩家判定', () => {
    const map = makeMap({
      players: [
        { seat: 1, team: 1 },
        { seat: 2, team: 2 },
        { seat: 3, team: 1 },
      ],
      tiles: { 6: [CITY, 1, 2], 12: [CITY, 2, 2], 16: [CITY, 3, 2] },
    });
    const asg = assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: 102 }, { seat: 3, playerId: 103 });
    const { state } = startGame(map, asg);
    // seat3 已灭（投降）后再让 seat2 灭：存活队 = {1}，胜者含已灭 seat3 的玩家
    const r3 = act(state, 3, { intentType: 'SURRENDER', seat: 3 });
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    expect(r3.state.finished).toBe(false); // 两队仍存活
    const r2 = act(r3.state, 2, { intentType: 'SURRENDER', seat: 2 });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.state.finished).toBe(true);
    expect(r2.state.winners).toEqual(['101', '103']); // 含已灭 seat3 的玩家
    expect(r2.state.winningTeam).toBe(1);
    const victory = r2.consensus.find((c) => c.payload.kind === 'VICTORY');
    expect(victory?.payload).toMatchObject({ winningTeam: 1 });
  });

  it('对局结束后新事件被拒绝（NO_GAME）', () => {
    const map = makeMap({ tiles: { 6: [CITY, 1, 2], 12: [CITY, 2, 2] } });
    const { state } = startGame(map, ASG);
    const r = act(state, 2, { intentType: 'SURRENDER', seat: 2 });
    expect(r.state.finished).toBe(true);
    expect(act(r.state, 1, { intentType: 'SWITCH_PHASE' })).toMatchObject({ ok: false, reason: 'NO_GAME' });
  });
});

describe('§9 中立兵', () => {
  it('野生兵按"非当前势力"参与准备阶段反击刷新；参与连断级联（owner 相等即同网络）', () => {
    const map = makeMap({
      tiles: {
        6: [CITY, 1, 2],
        12: [CITY, WILD, 2], // 野生据点
        13: [PLAIN, WILD, 3], // 与 12 相邻的野生平原
        17: [CITY, 2, 6], // seat2 据点，与 12 相邻
      },
    });
    const { state } = startGame(map, ASG);
    // 野生网络经据点 12 重连：13 为连兵（owner 相等）
    expect(soldierAt(state, 12)!.isLinked).toBe(true);
    expect(soldierAt(state, 13)!.isLinked).toBe(true);
    // seat1 结束回合 -> seat2：野生兵反击刷新为地形值（平原 1）
    const a = act(state, 1, { intentType: 'SWITCH_PHASE' });
    const b = act(a.state, 1, { intentType: 'SWITCH_PHASE' });
    expect(b.state.currentSeat).toBe(2);
    expect(soldierAt(b.state, 13)!.counter).toBe(1);
    // seat2 击杀野生据点兵：连兵 str6 -> 力 5 >= 2；反击（据点 ∞>0）：6-2=4
    const r = act(b.state, 2, { intentType: 'ATTACK', from: 17, to: 12 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(soldierAt(r.state, 12)!.owner).toBe(2); // 进占
    expect(soldierAt(r.state, 12)!.strength).toBe(3); // 4-1 进占
    // 野生 13 失去锚点：锚点删除扩展 -> 断连判定 -> 断兵、3-1=2
    expect(soldierAt(r.state, 13)).toMatchObject({ isLinked: false, strength: 2 });
  });
});
