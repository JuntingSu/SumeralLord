// §8.1.1 移动事件 / §3.3 失活性 / §8.1.2 进攻事件
import { describe, it, expect } from 'vitest';
import { makeMap, startGame, assignments, act, force, soldierAt, chainKinds, CITY, PLAIN, OCEAN, MOUNTAIN, WILD, BLOCKER } from './helpers.js';

describe('§8.1.1 移动事件：前置判定', () => {
  const base = makeMap({ tiles: { 6: [CITY, 1, 3], 7: [PLAIN, 128, 0] } });

  it('非行动阶段 → WRONG_PHASE', () => {
    const { state } = startGame(base);
    const s1 = act(state, 1, { intentType: 'SWITCH_PHASE' });
    const r = act(s1.state, 1, { intentType: 'MOVE', from: 6, to: 7 });
    expect(r).toMatchObject({ ok: false, reason: 'WRONG_PHASE' });
  });

  it('兵无移动力 → ILLEGAL_MOVE（兵力1连兵始终无移动力；空地无兵）', () => {
    // 17=己方据点（str1 连兵无移动力）；4=远离据点的孤立断兵 str1
    const map = makeMap({ tiles: { 17: [CITY, 1, 1], 18: [OCEAN, 1, 2], 4: [PLAIN, 1, 1], 19: [PLAIN, 128, 0] } });
    const { state } = startGame(map);
    expect(soldierAt(state, 17)!.isLinked).toBe(true);
    expect(soldierAt(state, 17)!.hasMovement).toBe(false);
    expect(soldierAt(state, 4)!.hasMovement).toBe(true); // 断兵 str1 有移动力（每回合一次）
    expect(act(state, 1, { intentType: 'MOVE', from: 17, to: 18 })).toMatchObject({ ok: false, reason: 'ILLEGAL_MOVE' });
    expect(act(state, 1, { intentType: 'MOVE', from: 2, to: 19 })).toMatchObject({ ok: false, reason: 'ILLEGAL_MOVE' }); // 无兵地块
  });

  it('目标全断地形（山地）→ ILLEGAL_MOVE', () => {
    const map = makeMap({ tiles: { 6: [CITY, 1, 3], 7: [MOUNTAIN, 128, 0] } });
    const { state } = startGame(map);
    const r = act(state, 1, { intentType: 'MOVE', from: 6, to: 7 });
    expect(r).toMatchObject({ ok: false, reason: 'ILLEGAL_MOVE' });
  });

  it('目标有同队伍兵 → ILLEGAL_MOVE', () => {
    const map = makeMap({ tiles: { 6: [CITY, 1, 3], 7: [PLAIN, 1, 1] } });
    const { state } = startGame(map);
    const r = act(state, 1, { intentType: 'MOVE', from: 6, to: 7 });
    expect(r).toMatchObject({ ok: false, reason: 'ILLEGAL_MOVE' });
  });

  it('目标有非同队兵 → 转为进攻事件（链首为 ATTACK）', () => {
    const map = makeMap({ tiles: { 6: [CITY, 1, 5], 7: [PLAIN, 2, 1] } });
    const { state } = startGame(map, assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: 102 }));
    const r = act(state, 1, { intentType: 'MOVE', from: 6, to: 7 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chain[0]).toMatchObject({ level: 1, kind: 'ATTACK', from: 6, to: 7 });
    // 意图层不再记录独立 MOVE 一级事件（进占移动是进攻的子事件）
    const moveRoots = r.chain.filter((e) => e.kind === 'MOVE');
    expect(moveRoots.length).toBeLessThanOrEqual(1);
  });

  it('距离超过目标地形移动距离（非邻格）→ ILLEGAL_MOVE', () => {
    const map = makeMap({ tiles: { 6: [CITY, 1, 3], 8: [PLAIN, 128, 0] } });
    const { state } = startGame(map);
    const r = act(state, 1, { intentType: 'MOVE', from: 6, to: 8 });
    expect(r).toMatchObject({ ok: false, reason: 'ILLEGAL_MOVE' });
  });

  it('移动他人/中立兵 → ILLEGAL_MOVE；非本回合 → NOT_YOUR_TURN；越界 → OUT_OF_BOUNDS', () => {
    const map = makeMap({ tiles: { 6: [CITY, 1, 3], 7: [PLAIN, 2, 1], 12: [CITY, 2, 3] } });
    const asg = assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: 102 });
    const { state } = startGame(map, asg);
    expect(act(state, 1, { intentType: 'MOVE', from: 7, to: 2 })).toMatchObject({ ok: false, reason: 'ILLEGAL_MOVE' });
    expect(act(state, 2, { intentType: 'MOVE', from: 12, to: 13 })).toMatchObject({ ok: false, reason: 'NOT_YOUR_TURN' });
    expect(act(state, 1, { intentType: 'MOVE', from: 6, to: 999 })).toMatchObject({ ok: false, reason: 'OUT_OF_BOUNDS' });
  });
});

describe('§8.1.1 移动事件：三分支生成序列', () => {
  it('连兵：生成复制 → 复制-1 → 原兵变 1（原地留 1）', () => {
    const map = makeMap({ tiles: { 6: [CITY, 1, 3], 7: [PLAIN, 128, 0] } });
    const { state } = startGame(map);
    const r = act(state, 1, { intentType: 'MOVE', from: 6, to: 7 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chain[0]).toMatchObject({ kind: 'MOVE' });
    // 序列：MOVE → SPAWN → (REJOIN) → UPDATE(str) → UPDATE(原地变1)
    expect(chainKinds(r).join(',')).toMatch(/^MOVE,SPAWN,REJOIN,UPDATE,UPDATE$/);
    const s7 = soldierAt(r.state, 7)!;
    expect(s7.strength).toBe(2);
    expect(s7.isLinked).toBe(true);
    expect(soldierAt(r.state, 6)!.strength).toBe(1);
  });

  it('断兵兵力≠1：生成复制 → 复制-1 → 原兵消失（远离据点保持断兵）', () => {
    // 17=据点（提供回合资源）；18=海洋断兵 str3；19=孤立平原（邻接不含据点）
    const map = makeMap({ tiles: { 17: [CITY, 1, 1], 18: [OCEAN, 1, 3], 19: [PLAIN, 128, 0] } });
    const { state } = startGame(map);
    expect(soldierAt(state, 18)!.isLinked).toBe(false);
    const r = act(state, 1, { intentType: 'MOVE', from: 18, to: 19 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chain[0]).toMatchObject({ kind: 'MOVE' });
    const s19 = soldierAt(r.state, 19)!;
    expect(s19.strength).toBe(2);
    expect(s19.isLinked).toBe(false);
    expect(s19.hasMovement).toBe(false); // 海洋-进入失活
    expect(soldierAt(r.state, 18)).toBeNull();
  });

  it('断兵兵力=1：生成兵力1断兵 → 失去移动力 → 原兵消失', () => {
    const map = makeMap({ tiles: { 17: [CITY, 1, 1], 18: [OCEAN, 1, 1], 19: [PLAIN, 128, 0] } });
    const { state } = startGame(map);
    const r = act(state, 1, { intentType: 'MOVE', from: 18, to: 19 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s19 = soldierAt(r.state, 19)!;
    expect(s19.strength).toBe(1);
    expect(s19.isLinked).toBe(false);
    expect(s19.hasMovement).toBe(false);
    expect(soldierAt(r.state, 18)).toBeNull();
  });

  it('断兵移动到己方连兵邻格 → 重连变连兵（§4.2 断→连兵力不变）', () => {
    const map = makeMap({ tiles: { 6: [CITY, 1, 2], 7: [OCEAN, 1, 3] } });
    const { state } = startGame(map);
    expect(soldierAt(state, 7)!.isLinked).toBe(false);
    // 7 断兵移到 2（平原，与据点 6 相邻）
    const r = act(state, 1, { intentType: 'MOVE', from: 7, to: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s2 = soldierAt(r.state, 2)!;
    expect(s2.strength).toBe(2); // 3-1
    expect(s2.isLinked).toBe(true); // 邻接己方连兵 → 重连
    expect(s2.hasMovement).toBe(false); // 海洋-进入失活
  });
});

describe('§3.3 移动力判断（失活）', () => {
  it('接触失活：非同队兵占据点邻格 → 失去移动力', () => {
    const map = makeMap({
      tiles: {
        6: [CITY, 1, 3],
        11: [PLAIN, 128, 0], // 11 与 6 相邻，且与 12 相邻
        12: [CITY, 2, 1],
      },
    });
    const { state } = startGame(map, assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: 102 }));
    const r = act(state, 1, { intentType: 'MOVE', from: 6, to: 11 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(soldierAt(r.state, 11)!.hasMovement).toBe(false);
    expect(chainKinds(r)).toContain('UPDATE');
  });

  it('接触失活：同队不触发', () => {
    const map = makeMap({
      players: [
        { seat: 1, team: 1 },
        { seat: 2, team: 1 },
      ],
      tiles: { 6: [CITY, 1, 3], 11: [PLAIN, 128, 0], 12: [CITY, 2, 1] },
    });
    const { state } = startGame(map, assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: 102 }));
    const r = act(state, 1, { intentType: 'MOVE', from: 6, to: 11 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(soldierAt(r.state, 11)!.hasMovement).toBe(true);
  });

  it('接触失活：中立兵占据点对全部势力触发；空据点不触发', () => {
    const wild = makeMap({ tiles: { 6: [CITY, 1, 3], 11: [PLAIN, 128, 0], 12: [CITY, WILD, 1] } });
    const g1 = startGame(wild);
    const r1 = act(g1.state, 1, { intentType: 'MOVE', from: 6, to: 11 });
    expect(r1.ok && soldierAt(r1.state, 11)!.hasMovement).toBe(false);

    const empty = makeMap({ tiles: { 6: [CITY, 1, 3], 11: [PLAIN, 128, 0], 12: [CITY, 128, 0] } });
    const g2 = startGame(empty);
    const r2 = act(g2.state, 1, { intentType: 'MOVE', from: 6, to: 11 });
    expect(r2.ok && soldierAt(r2.state, 11)!.hasMovement).toBe(true);
  });

  it('海洋-进入失活：从海洋进入据点/平原失去移动力；非海洋出发不触发', () => {
    // 从海洋 7 进入平原 2（上面分支已覆盖）；此处验证进入据点
    const map = makeMap({ tiles: { 6: [CITY, 1, 1], 7: [OCEAN, 1, 2], 2: [CITY, 128, 0] } });
    const { state } = startGame(map);
    const r = act(state, 1, { intentType: 'MOVE', from: 7, to: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = soldierAt(r.state, 2)!;
    expect(s.hasMovement).toBe(false);
    expect(s.isLinked).toBe(true); // 全接地块强制连兵
  });
});

describe('§8.1.2 进攻事件', () => {
  const setup = (defenderStrength: number, attackerStrength: number, defenderTile = 7, attackerTile = 6) =>
    startGame(makeMap({ tiles: { [attackerTile]: [CITY, 1, attackerStrength], [defenderTile]: [PLAIN, 2, defenderStrength] } }),
      assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: 102 }));

  it('进攻力公式：连兵=兵力-1；成功有反击 → 受反击伤害、防守灭、进占', () => {
    // 连兵 str4 → 进攻力 3 vs 防守 2（反击1，平原）：成功，进攻兵 4-2=2，进占后 1，原地 1
    const { state } = setup(2, 4);
    const r = act(state, 1, { intentType: 'ATTACK', from: 6, to: 7 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chain[0]).toMatchObject({ kind: 'ATTACK' });
    expect(soldierAt(r.state, 7)).toMatchObject({ owner: 1, strength: 1 });
    expect(soldierAt(r.state, 6)).toMatchObject({ owner: 1, strength: 1 });
  });

  it('断兵进攻力=兵力；成功无反击（阻挡兵）→ 不受伤害、进占不扣兵力、仍是断兵失去移动力', () => {
    const map = makeMap({ tiles: { 17: [CITY, 1, 1], 18: [OCEAN, 1, 4], 19: [PLAIN, BLOCKER, 3] } });
    const { state } = startGame(map);
    // 断兵 str4 -> 力 4 ≥ 3：成功；阻挡兵反击恒 0 -> 无反击伤害且进占不扣兵力；19 邻接无己方连兵 -> 保持断兵
    const r = act(state, 1, { intentType: 'ATTACK', from: 18, to: 19 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.chain[0]).toMatchObject({ kind: 'ATTACK' });
    expect(soldierAt(r.state, 19)).toMatchObject({ owner: 1, strength: 4, isLinked: false, hasMovement: false });
    expect(soldierAt(r.state, 18)).toBeNull();
    expect(soldierAt(r.state, 19)!.counter).toBe(1); // 承袭进攻兵反击（海洋地形值）
  });

  it('断兵进攻无反击次数的兵成功 → 进占移动不扣兵力（完整进占）', () => {
    const map = makeMap({ tiles: { 17: [CITY, 1, 1], 18: [OCEAN, 1, 10], 19: [PLAIN, 2, 2] } });
    const asg = assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: 102 });
    const { state } = startGame(map, asg);
    // 构造防守兵 counter=0（本回合已无反击次数）
    soldierAt(state, 19)!.counter = 0;
    // 断兵 str10 -> 力 10 ≥ 2：成功；防守无反击 -> 不受伤害；进占移动不扣兵力 -> str10
    const r = act(state, 1, { intentType: 'ATTACK', from: 18, to: 19 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(soldierAt(r.state, 19)).toMatchObject({ owner: 1, strength: 10, isLinked: false, hasMovement: false });
    expect(soldierAt(r.state, 18)).toBeNull();
  });

  it('断兵进攻有反击次数的兵成功 → 进占移动不再重复扣兵力（3断兵攻1兵 → 应剩2）', () => {
    const map = makeMap({ tiles: { 17: [CITY, 1, 1], 18: [OCEAN, 1, 3], 19: [PLAIN, 2, 1] } });
    const asg = assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: 102 });
    const { state } = startGame(map, asg);
    // 断兵 str3 → 力 3 ≥ 1：成功；防守反击 1 → 3-1=2；进占移动不得再复制 -1（bug：再 -1 只剩 1）
    const r = act(state, 1, { intentType: 'ATTACK', from: 18, to: 19 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(soldierAt(r.state, 19)).toMatchObject({ owner: 1, strength: 2, isLinked: false, hasMovement: false });
    expect(soldierAt(r.state, 18)).toBeNull();
  });

  it('进攻失败且防守无反击 → 进攻兵失去移动力', () => {
    const map = makeMap({ tiles: { 6: [CITY, 1, 3], 7: [PLAIN, 2, 9], 8: [PLAIN, 1, 1] } });
    // 构造 counter=0：先让 seat2 回合内防守方... 简化：直接用阻挡兵（永不反击）
    const map2 = makeMap({ tiles: { 6: [CITY, 1, 3], 7: [PLAIN, BLOCKER, 9] } });
    const { state } = startGame(map2);
    // 连兵 str3 → 力 2 < 9：失败；阻挡兵 counter 0 → 进攻兵失去移动力
    const r = act(state, 1, { intentType: 'ATTACK', from: 6, to: 7 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(soldierAt(r.state, 7)).toMatchObject({ owner: BLOCKER, strength: 7 });
    expect(soldierAt(r.state, 6)!.hasMovement).toBe(false);
  });

  it('进攻失败且防守有反击 → 进攻兵消失、防守反击-1', () => {
    const { state } = setup(5, 3); // 连兵力 2 < 5
    const r = act(state, 1, { intentType: 'ATTACK', from: 6, to: 7 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(soldierAt(r.state, 6)).toBeNull();
    expect(soldierAt(r.state, 7)).toMatchObject({ owner: 2, strength: 3, counter: 0 });
  });

  it('恰好等力：防守灭、进攻方原地保留兵力 1（反击后无法进占）', () => {
    const { state } = setup(2, 3); // 连兵力 2 === 防守 2，反击 1
    const r = act(state, 1, { intentType: 'ATTACK', from: 6, to: 7 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(soldierAt(r.state, 7)).toBeNull(); // 防守灭、未进占
    expect(soldierAt(r.state, 6)).toMatchObject({ owner: 1, strength: 1 });
  });

  it('同归于尽：反击使进攻兵归 0，双方灭亡、无进占', () => {
    const map = makeMap({ tiles: { 7: [OCEAN, 1, 1], 2: [PLAIN, 2, 1] } });
    const asg = assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: 102 });
    const { state } = startGame(map, asg);
    // 断兵 str1 → 力 1 === 防守 1：成功；防守反击 1 → 进攻兵 1-1=0 死
    const r = act(state, 1, { intentType: 'ATTACK', from: 7, to: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(soldierAt(r.state, 7)).toBeNull();
    expect(soldierAt(r.state, 2)).toBeNull();
  });

  it('断兵进攻成功进占后仍是断兵 → 失去移动力', () => {
    const map = makeMap({ tiles: { 17: [CITY, 1, 1], 18: [OCEAN, 1, 4], 19: [PLAIN, 2, 3] } });
    const asg = assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: 102 });
    const { state } = startGame(map, asg);
    // 断兵 str4 → 力 4 ≥ 3：成功；反击 1 → 4-3=1；移动：断兵=1 → 生成 str1 失去移动力
    const r = act(state, 1, { intentType: 'ATTACK', from: 18, to: 19 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(soldierAt(r.state, 19)).toMatchObject({ owner: 1, strength: 1, isLinked: false, hasMovement: false });
    expect(soldierAt(r.state, 18)).toBeNull();
  });

  it('进攻判定：非邻格/无防守兵/同队目标 → ILLEGAL_ATTACK', () => {
    const map = makeMap({ tiles: { 6: [CITY, 1, 5], 7: [PLAIN, 2, 1], 8: [PLAIN, 2, 1] } });
    const asg = assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: 102, },);
    const { state } = startGame(map, asg);
    const sameTeamMap = makeMap({
      players: [
        { seat: 1, team: 7 },
        { seat: 2, team: 7 },
      ],
      tiles: { 6: [CITY, 1, 5], 7: [PLAIN, 2, 1] },
    });
    const g2 = startGame(sameTeamMap, asg);
    expect(act(state, 1, { intentType: 'ATTACK', from: 6, to: 2 })).toMatchObject({ ok: false, reason: 'ILLEGAL_ATTACK' }); // 空地
    expect(act(g2.state, 1, { intentType: 'ATTACK', from: 6, to: 7 })).toMatchObject({ ok: false, reason: 'ILLEGAL_ATTACK' }); // 同队
  });
});
