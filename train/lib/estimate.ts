// b 估计（M4）：给定地图，m vs m 打 N 局，估计先手（seat1）胜率
// - 固定座次↔出生点（生成器 seat1↔spawnA）；seat1 恒为先手
// - 每局独立 (gameSeed, aiSeeds)：m 随机流独立于局内种子（D10）
// - 截断局按 0.5 计（平局语义），截断率单独记录
import type { MapFullData, SeatAssignment } from '@dl/shared';
import { playGame } from './game.js';
import { chooseMove } from './mcts.js';
import type { MctsConfig } from './mcts.js';
import type { Policy } from './game.js';
import { seOf } from './pool.js';
import type { BRecord } from './pool.js';

export interface EstimateOptions {
  /** 每图对局数 N */
  games: number;
  /** b 估计用 m 配置（可小于标准配置、探索更强） */
  mctsConfig: MctsConfig;
  /** 对局种子基：第 i 局 gameSeed = `${base}:g${i}`，aiSeed = `${gameSeed}:s${seat}` */
  seedBase: string;
}

export function estimateB(map: MapFullData, opts: EstimateOptions): BRecord {
  const asg: SeatAssignment[] = map.player_list.map((p) => ({ seat: p.seat, playerId: null, isAI: true, computer: 1, name: p.name }));
  const policy: Policy = (state, seat, aiSeed) => chooseMove(state, opts.mctsConfig, aiSeed);
  let wins = 0;
  let finished = 0;
  let truncated = 0;
  const resolvedTurns: number[] = [];
  for (let i = 0; i < opts.games; i++) {
    const gameSeed = `${opts.seedBase}:g${i}`;
    const result = playGame(map, asg, { 1: policy, 2: policy }, {
      turnCap: opts.mctsConfig.turnCap,
      aiSeeds: { 1: `${gameSeed}:s1`, 2: `${gameSeed}:s2` },
    });
    if (result.finished) {
      finished++;
      resolvedTurns.push(result.turns);
      if (result.winningTeam === 1) wins++;
    } else if (result.truncated) {
      truncated++;
    }
  }
  const bHat = (wins + 0.5 * truncated) / opts.games;
  resolvedTurns.sort((a, b) => a - b);
  return {
    mapId: map.id,
    mapSeed: map.id,
    rows: map.row,
    columns: map.column,
    strongholdsPerSide: map.battlefield.filter((t) => t[0] === 1 && t[1] === 1).length,
    bHat,
    wins,
    games: opts.games,
    finished,
    truncated,
    se: seOf(bHat, opts.games),
    resolvedMedianTurns: resolvedTurns.length ? resolvedTurns[Math.floor(resolvedTurns.length / 2)] : null,
    resolvedP90Turns: resolvedTurns.length ? resolvedTurns[Math.floor(resolvedTurns.length * 0.9)] : null,
  };
}
