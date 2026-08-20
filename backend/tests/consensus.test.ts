// BM5 全票共识收集器：全票/分歧/超时/断线剔除/边界表逐条（后端方案 §4.1）
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MapFullData, ConsensusPayload } from '@dl/shared';
import { GameManager } from '../src/game/manager.js';
import { ConsensusManager, type ConsensusFatalCode, type ConsensusHooks } from '../src/game/consensus.js';

function makeMap(playerSeats: number[]): MapFullData {
  return {
    id: 'test',
    version: 1,
    title: 't',
    description: '',
    author: 'test',
    timestamp: '2026-08-16 00:00:00.0',
    row: 3,
    column: 3,
    random_spawn: false,
    cylindrical_map: false,
    fog_mode: false,
    online_time_settings: { total_time: 600, round_time: 60, time_bonus: 0 },
    tags: [],
    player_num: playerSeats.length,
    player_list: playerSeats.map((seat) => ({ name: `f${seat}`, team: seat, computer: 255, seat, flag: 1 })),
    battlefield: Array.from({ length: 9 }, (_, i) => [0, 128, 0]),
  };
}

function setup(seats: number[], timeoutMs = 1000) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dl-consensus-'));
  const games = new GameManager(path.join(dir, 'logs'));
  const { game } = games.create({
    roomId: 'r1',
    map: makeMap(seats),
    seatAssignments: seats.map((seat) => ({ seat, playerId: 100 + seat, isAI: false })),
    aiTakeover: false,
    randomSpawn: false,
    timeSettings: { stepTime: 90, gameTime: 1200, additionalTime: 0 },
    reducerVersion: 'test',
  });
  // 默认全员在线（在线状态由 WS 连接驱动，单元测试直接标记）
  for (const seat of seats) games.setConnected(game, seat, true, Date.now());
  const onConfirmed = vi.fn<ConsensusHooks['onConfirmed']>();
  const onFatal = vi.fn<(gameId: string, code: ConsensusFatalCode) => void>();
  const consensus = new ConsensusManager(
    games,
    { onConfirmed, onFatal },
    timeoutMs,
  );
  return { games, game, consensus, onConfirmed, onFatal, dir };
}

const forceClear = { kind: 'FORCE_CLEAR', seat: 1, reason: 'surrender' } as const;

afterEach(() => {
  vi.useRealTimers();
});

describe('全票共识收集器（BM5）', () => {
  it('全票一致 → onConfirmed（FORCE_CLEAR 只确认一次）', () => {
    const { game, consensus, onConfirmed } = setup([1, 2]);
    // 先让两个 seat 都在线
    consensus.submit(game, 1, '1:force_clear:1', forceClear);
    expect(onConfirmed).not.toHaveBeenCalled();
    consensus.submit(game, 2, '1:force_clear:1', forceClear);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(onConfirmed).toHaveBeenCalledWith(game.id, '1:force_clear:1', forceClear);
  });

  it('同 seat 重复上报取首条：多报不影响判定', () => {
    const { game, consensus, onConfirmed, onFatal } = setup([1, 2]);
    consensus.submit(game, 1, '1:force_clear:1', forceClear);
    consensus.submit(game, 1, '1:force_clear:1', { kind: 'FORCE_CLEAR', seat: 9, reason: 'surrender' }); // 重复 seat 被忽略
    consensus.submit(game, 2, '1:force_clear:1', forceClear);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(onFatal).not.toHaveBeenCalled();
  });

  it('不一致 → onFatal CONSENSUS_MISMATCH（对局不结算）', () => {
    const { game, consensus, onFatal } = setup([1, 2]);
    consensus.submit(game, 1, '1:force_clear:1', forceClear);
    consensus.submit(game, 2, '1:force_clear:1', { kind: 'FORCE_CLEAR', seat: 1, reason: 'timeout' });
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledWith(game.id, 'CONSENSUS_MISMATCH');
  });

  it('5s 超时未收齐 → onFatal CONSENSUS_TIMEOUT', () => {
    vi.useFakeTimers();
    const { game, consensus, onFatal } = setup([1, 2], 5000);
    consensus.submit(game, 1, '1:force_clear:1', forceClear);
    expect(onFatal).not.toHaveBeenCalled();
    vi.advanceTimersByTime(5001);
    expect(onFatal).toHaveBeenCalledTimes(1);
    expect(onFatal).toHaveBeenCalledWith(game.id, 'CONSENSUS_TIMEOUT');
  });

  it('断线剔除：剔除后复检可就此凑齐全票', () => {
    const { game, consensus, onConfirmed, onFatal } = setup([1, 2, 3]);
    consensus.submit(game, 1, '1:force_clear:1', forceClear);
    consensus.submit(game, 3, '1:force_clear:1', forceClear);
    expect(onConfirmed).not.toHaveBeenCalled(); // 缺 seat2
    consensus.removeSeat(game.id, 2); // seat2 断线 → 期望集合 {1,3} 已齐
    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(onFatal).not.toHaveBeenCalled();
  });

  it('迟到上报（对局已结束）→ 丢弃', () => {
    const { games, game, consensus, onConfirmed, onFatal } = setup([1, 2]);
    games.markFinished(game);
    consensus.submit(game, 1, '1:force_clear:1', forceClear);
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(onFatal).not.toHaveBeenCalled();
  });

  it('多个 consensusId 的 tracker 独立收集', () => {
    const { game, consensus, onConfirmed } = setup([1, 2]);
    consensus.submit(game, 1, '1:force_clear:1', forceClear);
    consensus.submit(game, 1, '2:force_clear:2', { kind: 'FORCE_CLEAR', seat: 2, reason: 'surrender' });
    expect(onConfirmed).not.toHaveBeenCalled();
    consensus.submit(game, 2, '1:force_clear:1', forceClear);
    consensus.submit(game, 2, '2:force_clear:2', { kind: 'FORCE_CLEAR', seat: 2, reason: 'surrender' });
    expect(onConfirmed).toHaveBeenCalledTimes(2);
  });

  it('VICTORY 与其他 payload 结构比对同样走全票路径', () => {
    const { game, consensus, onConfirmed } = setup([1, 2]);
    const victory: ConsensusPayload = { kind: 'VICTORY', winningTeam: 1, winners: ['101'], losers: ['102'] };
    consensus.submit(game, 1, '3:victory:0', victory);
    consensus.submit(game, 2, '3:victory:0', victory);
    expect(onConfirmed).toHaveBeenCalledWith(game.id, '3:victory:0', victory);
  });
});
