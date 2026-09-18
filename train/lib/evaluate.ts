// M6 评估核心：一组 n 参数 → 多对手混合胜率（m 主 + 规则AI + 低/高预算 m）
// 指标：加权均分（终端按 b 中心化、截断 −0.9），同时记录各对手明细与截断率
import type { MapFullData, SeatAssignment } from '@dl/shared';
import { playGame, rulePolicy, scoreFor } from './game.js';
import { chooseMove } from './mcts.js';
import type { MctsConfig } from './mcts.js';
import type { Policy } from './game.js';
import type { BRecord } from './pool.js';
import { loadMap } from './pool.js';

export interface NParams {
  cStronghold: number;
  damageCoeff: number;
  linkedGainBonus: number;
  noCounterBonus: number;
  stuckPenalty: number;
  explorationC: number;
  simsPerMove: number;
  rolloutRounds: number;
}

export interface OpponentSpec {
  key: string;
  weight: number;
  games: number;
  /** 构造对手策略（m 相关配置在此构造） */
  makePolicy: (b: number, turnCap: number) => Policy;
}

export interface EvalResult {
  params: NParams;
  weightedScore: number;
  perOpponent: Array<{
    key: string;
    score: number;
    wins: number;
    losses: number;
    truncated: number;
    games: number;
  }>;
  truncationRate: number;
}

export function nConfigOf(params: NParams, b: number, turnCap: number): MctsConfig {
  return {
    simsPerMove: params.simsPerMove,
    explorationC: params.explorationC,
    cStronghold: params.cStronghold,
    damageCoeff: params.damageCoeff,
    linkedGainBonus: params.linkedGainBonus,
    noCounterBonus: params.noCounterBonus,
    stuckPenalty: params.stuckPenalty,
    terminalScale: 5,
    rolloutRounds: params.rolloutRounds,
    turnCap,
    b,
  };
}

/**
 * 评估一组 n 参数：从池中采样 maps 张图，对每个对手打 games 局（n 座位交替）。
 * aiSeed 每局派生（gameSeed + seat + runId，D10）。
 */
export async function evaluateParams(
  params: NParams,
  pool: BRecord[],
  opponents: OpponentSpec[],
  mapsCount: number,
  seedBase: string,
  capOf: (record: BRecord) => number,
  onProgress?: (msg: string) => void,
): Promise<EvalResult> {
  // 采样地图（确定性：seedBase 决定）
  const maps: Array<{ map: MapFullData; b: number; cap: number }> = [];
  for (let i = 0; i < mapsCount; i++) {
    const rec = pool[i % pool.length];
    maps.push({ map: loadMap(rec.mapId), b: rec.bHat, cap: capOf(rec) });
  }

  const perOpponent: EvalResult['perOpponent'] = [];
  let totalGames = 0;
  let totalTrunc = 0;
  for (const opp of opponents) {
    let scoreSum = 0;
    let wins = 0;
    let losses = 0;
    let truncated = 0;
    let played = 0;
    for (let g = 0; g < opp.games; g++) {
      const { map, b, cap } = maps[(g + opp.games * perOpponent.length) % maps.length];
      const asg: SeatAssignment[] = map.player_list.map((p) => ({ seat: p.seat, playerId: null, isAI: true, computer: 1, name: p.name }));
      // n 座位交替（D12 座次随机化）
      const nSeat = g % 2 === 0 ? 1 : 2;
      const nPolicy: Policy = (state, seat, aiSeed) => chooseMove(state, nConfigOf(params, b, cap), aiSeed);
      const oppPolicy = opp.makePolicy(b, cap);
      const gameSeed = `${seedBase}:${opp.key}:${g}`;
      const result = playGame(map, asg, { 1: nSeat === 1 ? nPolicy : oppPolicy, 2: nSeat === 2 ? nPolicy : oppPolicy }, {
        turnCap: cap,
        aiSeeds: { 1: `${gameSeed}:s1`, 2: `${gameSeed}:s2` },
      });
      played++;
      const score = scoreFor(result, nSeat, b);
      scoreSum += score;
      if (result.truncated || !result.finished) truncated++;
      else if (result.winningTeam === nSeat) wins++;
      else losses++;
      onProgress?.(`[${opp.key}] 局${g}: ${result.finished ? `胜队=${result.winningTeam}` : '截断'} score=${score.toFixed(2)}`);
    }
    totalGames += played;
    totalTrunc += truncated;
    perOpponent.push({
      key: opp.key,
      score: scoreSum / Math.max(1, played),
      wins,
      losses,
      truncated,
      games: played,
    });
  }

  const totalWeight = opponents.reduce((a, o) => a + o.weight, 0);
  const weightedScore = perOpponent.reduce((a, p, i) => a + p.score * opponents[i].weight, 0) / totalWeight;
  return {
    params,
    weightedScore,
    perOpponent,
    truncationRate: totalTrunc / Math.max(1, totalGames),
  };
}

/** 标准 m 对手工厂（m 固定参数） */
export function makeMctsOpponent(cfg: Partial<MctsConfig>): (b: number, turnCap: number) => Policy {
  return (b, turnCap) => {
    const full: MctsConfig = {
      simsPerMove: 100,
      explorationC: 1.0,
      cStronghold: 0.1,
      damageCoeff: 0.001,
      linkedGainBonus: 0.05,
      noCounterBonus: 0.3,
      stuckPenalty: 0.002,
      terminalScale: 5,
      rolloutRounds: 8,
      turnCap,
      b,
      ...cfg,
    };
    return (state, seat, aiSeed) => chooseMove(state, full, aiSeed);
  };
}
