// collectSystemNotices 单测（POV）：回合开始 / 被击败（击杀者归属与投降/超时）/ 大杀四方（击杀数 ≥3 每次击杀都发）
import { describe, it, expect } from 'vitest';
import type { GameEvent } from '@dl/shared';
import { collectSystemNotices } from '../src/stores/game';

const FORCE_CLEAR = (seat: number, reason: 'no_stronghold' | 'surrender' | 'timeout'): GameEvent => ({
  level: 4,
  kind: 'FORCE_CLEAR',
  seat,
  reason,
});
const END_TURN = (fromSeat: number, toSeat: number): GameEvent => ({
  level: 1,
  kind: 'END_TURN',
  fromSeat,
  toSeat,
  turn: 2,
});

describe('collectSystemNotices 系统通知收集', () => {
  it('END_TURN 提取下家回合开始；toSeat === fromSeat（无存活势力）不提示', () => {
    const { notices } = collectSystemNotices([END_TURN(2, 3)], 2, {});
    expect(notices).toEqual([{ kind: 'turnStart', seat: 3 }]);
    const empty = collectSystemNotices([END_TURN(2, 2)], 2, {});
    expect(empty.notices).toEqual([]);
  });

  it('no_stronghold 清除：击杀者 = 意图发起者，计入击杀数', () => {
    const { notices, killCounts } = collectSystemNotices([FORCE_CLEAR(5, 'no_stronghold')], 2, {});
    expect(notices).toEqual([{ kind: 'forceCleared', seat: 5, killerSeat: 2, reason: 'no_stronghold' }]);
    expect(killCounts[2]).toBe(1);
  });

  it('surrender/timeout 清除：无击杀者，不计数', () => {
    for (const reason of ['surrender', 'timeout'] as const) {
      const { notices, killCounts } = collectSystemNotices([FORCE_CLEAR(4, reason)], 4, {});
      expect(notices).toEqual([{ kind: 'forceCleared', seat: 4, killerSeat: null, reason }]);
      expect(killCounts).toEqual({});
    }
  });

  it('击杀数达到 3 起触发「大杀四方」，且 ≥3 后每次击杀都触发', () => {
    // 已有 2 杀 → 第 3 杀触发
    const r1 = collectSystemNotices([FORCE_CLEAR(6, 'no_stronghold')], 2, { 2: 2 });
    expect(r1.notices).toEqual([
      { kind: 'forceCleared', seat: 6, killerSeat: 2, reason: 'no_stronghold' },
      { kind: 'killStreak', seat: 2, kills: 3 },
    ]);
    // 第 4 杀继续触发
    const r2 = collectSystemNotices([FORCE_CLEAR(7, 'no_stronghold')], 2, r1.killCounts);
    expect(r2.notices[1]).toEqual({ kind: 'killStreak', seat: 2, kills: 4 });
    expect(r2.killCounts[2]).toBe(4);
  });

  it('击杀不足 3 时不触发「大杀四方」', () => {
    const { notices } = collectSystemNotices([FORCE_CLEAR(6, 'no_stronghold')], 2, { 2: 1 });
    expect(notices).toEqual([{ kind: 'forceCleared', seat: 6, killerSeat: 2, reason: 'no_stronghold' }]);
  });

  it('同一链多条事件按序收集（击杀 + 回合开始）', () => {
    const chain = [FORCE_CLEAR(5, 'no_stronghold'), END_TURN(2, 3)];
    const { notices } = collectSystemNotices(chain, 2, {});
    expect(notices).toEqual([
      { kind: 'forceCleared', seat: 5, killerSeat: 2, reason: 'no_stronghold' },
      { kind: 'turnStart', seat: 3 },
    ]);
  });
});
