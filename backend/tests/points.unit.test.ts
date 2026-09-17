// 积分结算纯函数单测（无 DB）：0 和制公式 + 获胜者保底，用例见《积分统计与排行榜设计方案》§6.1
import { describe, it, expect } from 'vitest';
import { computeScoreChanges, type SettlePlayerInput } from '../src/stats/settlement.js';

function changes(players: SettlePlayerInput[]) {
  return new Map(computeScoreChanges(players).map((c) => [c.playerId, c]));
}

describe('computeScoreChanges（0 和制 + 保底）', () => {
  it('双人各 100，甲胜乙败：pay=-10 各，甲 +10 → 110，乙 -10 → 90（0 和）', () => {
    const c = changes([
      { playerId: 1, score: 100, isWinner: true, offline: false },
      { playerId: 2, score: 100, isWinner: false, offline: false },
    ]);
    expect(c.get(1)).toMatchObject({ delta: 10, newScore: 110, result: 'win' });
    expect(c.get(2)).toMatchObject({ delta: -10, newScore: 90, result: 'lose' });
    expect(c.get(1)!.delta + c.get(2)!.delta).toBe(0);
  });

  it('2v1：甲/乙 100 胜、丙 200 败（S=400）：pay=-5/-5/-10，甲/乙各 +5 → 105，丙 -10 → 190', () => {
    const c = changes([
      { playerId: 1, score: 100, isWinner: true, offline: false },
      { playerId: 2, score: 100, isWinner: true, offline: false },
      { playerId: 3, score: 200, isWinner: false, offline: false },
    ]);
    expect(c.get(1)!.delta).toBe(5);
    expect(c.get(2)!.delta).toBe(5);
    expect(c.get(3)!.delta).toBe(-10);
    expect(c.get(1)!.newScore).toBe(105);
    expect(c.get(2)!.newScore).toBe(105);
    expect(c.get(3)!.newScore).toBe(190);
  });

  it('离线获胜者按败方：甲 100 胜（在线）、乙 100 胜（离线）、丙 100 败：剩余池 13.4 全归甲，乙/丙各 -6.7', () => {
    const c = changes([
      { playerId: 1, score: 100, isWinner: true, offline: false },
      { playerId: 2, score: 100, isWinner: true, offline: true },
      { playerId: 3, score: 100, isWinner: false, offline: false },
    ]);
    expect(c.get(1)!.delta).toBe(13.4);
    expect(c.get(1)!.newScore).toBe(113.4);
    expect(c.get(2)).toMatchObject({ delta: -6.7, newScore: 93.3, result: 'lose', offline: true });
    expect(c.get(3)).toMatchObject({ delta: -6.7, newScore: 93.3, result: 'lose', offline: false });
  });

  it('保留一位小数：三人各 100（S=300）pay=round1(-6.666…)=-6.7', () => {
    const c = changes([
      { playerId: 1, score: 100, isWinner: true, offline: false },
      { playerId: 2, score: 100, isWinner: false, offline: false },
      { playerId: 3, score: 100, isWinner: false, offline: false },
    ]);
    expect(c.get(2)!.delta).toBe(-6.7);
    expect(c.get(3)!.delta).toBe(-6.7);
  });

  it('权重比例（反比，低分者分得更多）：甲 100/乙 300 同胜、丙 1200 败：甲 +10、乙 +5、丙 -15（0 和）', () => {
    const c = changes([
      { playerId: 1, score: 100, isWinner: true, offline: false },
      { playerId: 2, score: 300, isWinner: true, offline: false },
      { playerId: 3, score: 1200, isWinner: false, offline: false },
    ]);
    expect(c.get(1)!.delta).toBe(10);
    expect(c.get(2)!.delta).toBe(5);
    expect(c.get(3)!.delta).toBe(-15);
    expect(c.get(1)!.newScore).toBe(110);
    expect(c.get(2)!.newScore).toBe(305);
    expect(c.get(3)!.newScore).toBe(1185);
    expect(c.get(1)!.delta + c.get(2)!.delta + c.get(3)!.delta).toBe(0);
  });

  it('获胜者保底：甲 190（胜）/乙 10（败），剩余池 1 → 甲保底 +5 → 195，乙 -1 → 9（总变动 +4 系统注入，非 0 和）', () => {
    const c = changes([
      { playerId: 1, score: 190, isWinner: true, offline: false },
      { playerId: 2, score: 10, isWinner: false, offline: false },
    ]);
    expect(c.get(1)!.delta).toBe(5);
    expect(c.get(1)!.newScore).toBe(195);
    expect(c.get(2)!.delta).toBe(-1);
    expect(c.get(2)!.newScore).toBe(9);
    expect(c.get(1)!.delta + c.get(2)!.delta).toBe(4);
  });

  it('下限 0：双方各 9（S=18）甲胜：乙 delta=-10 → newScore=0', () => {
    const c = changes([
      { playerId: 1, score: 9, isWinner: true, offline: false },
      { playerId: 2, score: 9, isWinner: false, offline: false },
    ]);
    expect(c.get(2)!.delta).toBe(-10);
    expect(c.get(2)!.newScore).toBe(0);
    expect(c.get(1)!.newScore).toBe(19);
  });

  it('积分和 ≤ 0（全员 0 分）→ 全部 delta=0（防除零）', () => {
    const c = changes([
      { playerId: 1, score: 0, isWinner: true, offline: false },
      { playerId: 2, score: 0, isWinner: false, offline: false },
    ]);
    expect(c.get(1)!.delta).toBe(0);
    expect(c.get(2)!.delta).toBe(0);
    expect(c.get(1)!.newScore).toBe(0);
  });

  it('W 为空（胜者全部离线，防御）→ 视同平局不结算，全部 delta=0', () => {
    const c = changes([
      { playerId: 1, score: 100, isWinner: true, offline: true },
      { playerId: 2, score: 100, isWinner: false, offline: false },
    ]);
    expect(c.get(1)!.delta).toBe(0);
    expect(c.get(2)!.delta).toBe(0);
    expect(c.get(1)!.newScore).toBe(100);
  });
});

describe('D7：AI 胜局人类记败（emptyWinnersAsLoss）', () => {
  it('AI 胜局（无人类胜者）：全员按支付侧扣分（获胜池作废），result=lose', () => {
    const c = computeScoreChanges(
      [
        { playerId: 1, score: 100, isWinner: false, offline: false },
        { playerId: 2, score: 100, isWinner: false, offline: false },
      ],
      { emptyWinnersAsLoss: true },
    );
    const m = new Map(c.map((x) => [x.playerId, x]));
    // S=200 → pay = -10 各；无胜者，支付作废
    expect(m.get(1)).toMatchObject({ delta: -10, newScore: 90, result: 'lose' });
    expect(m.get(2)).toMatchObject({ delta: -10, newScore: 90, result: 'lose' });
  });

  it('AI 胜局与真平局的区分：emptyWinnersAsLoss=false（真平局）→ 全部 delta=0 不结算', () => {
    const c = computeScoreChanges([
      { playerId: 1, score: 100, isWinner: false, offline: false },
      { playerId: 2, score: 100, isWinner: false, offline: false },
    ]);
    expect(c.every((x) => x.delta === 0)).toBe(true);
  });

  it('AI 胜局离线玩家同样记败（离线不豁免支付侧）', () => {
    const c = computeScoreChanges(
      [{ playerId: 1, score: 100, isWinner: false, offline: true }],
      { emptyWinnersAsLoss: true },
    );
    expect(c[0]).toMatchObject({ delta: -20, newScore: 80, result: 'lose', offline: true });
  });
});
