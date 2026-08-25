// 复现：海洋（半断）地块上的同势力断兵不应作为连兵链的桥。
// 规则：周围有连兵的处于可接地形上的兵是连兵；连兵链里不能有断兵（海洋兵永远断兵）。
// 场景：A(据点,连) - B(海洋,断) - C(平原)，C 只能经海洋 B 触达 A，C 必须保持断兵。
import { describe, it, expect } from 'vitest';
import { makeMap, startGame, assignments, act, soldierAt, CITY, PLAIN, OCEAN } from './helpers.js';

const ASG = assignments({ seat: 1, playerId: 101 }, { seat: 2, playerId: 102 });

describe('海洋断兵不作为连兵桥（§3.2 半断 / §4.1 连兵性）', () => {
  it('连兵移入海洋时，海洋另一侧经海洋触达的平原兵不被误判为连兵', () => {
    // 邻接：A(6 据点) 与 B(7 海洋) 相邻；C(13 平原) 与 B(7) 相邻但不与 A(6) 相邻。
    // D(2 平原,str2) 同时与 A(6)、海洋(7) 相邻，开局即为连兵，可移动进占海洋 7。
    const map = makeMap({
      tiles: {
        6: [CITY, 1, 2], // A 据点（连兵锚点）
        7: [OCEAN, 1, 0], // B 海洋（空）
        13: [PLAIN, 1, 1], // C 平原（应保持断兵）
        2: [PLAIN, 1, 2], // D 连兵，可移入海洋
        8: [CITY, 2, 6], // 蓝方据点
      },
    });
    const { state } = startGame(map, ASG);
    // 开局后 A 连、D 连（相邻），C 断（仅经海洋触达）
    expect(soldierAt(state, 6)!.isLinked).toBe(true);
    expect(soldierAt(state, 2)!.isLinked).toBe(true);
    expect(soldierAt(state, 13)!.isLinked).toBe(false);
    // seat1 行动阶段：D(2) → 海洋 7
    const r = act(state, 1, { intentType: 'MOVE', from: 2, to: 7 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 海洋 7 上的兵永远断兵
    expect(soldierAt(r.state, 7)).toMatchObject({ owner: 1, isLinked: false });
    // C(13) 仍只能经海洋触达连兵：必须保持断兵
    expect(soldierAt(r.state, 13)!.isLinked).toBe(false);
  });
});
