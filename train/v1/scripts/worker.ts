// worker.ts — 训练 worker 子进程：领任务（自对弈出样本 / 验收对局），回传结果
// 由 scripts/train.ts 以 `node --import tsx worker.ts` 派生，IPC 通信（structured clone）。
import { applyIntent, initState } from '@dl/shared';
import type { GameState, MapFullData } from '@dl/shared';
import { playSelfPlayGame, TIME_SETTINGS, MAX_TURNS, MAX_STEPS } from '../lib/driver.js';
import type { GameStats, TrainSample } from '../lib/driver.js';
import { mctsDecide } from '../lib/mcts.js';
import type { TeWeights } from '../lib/eval.js';

export interface WorkerJob {
  type: 'play';
  gameIndex: number;
  kind: 'train' | 'eval';
  map: MapFullData;
  weights: TeWeights;
  /** eval 对局的基准权重（对手使用） */
  baselineWeights?: TeWeights;
  /** eval 中训练权重一方的 seat（1/2，轮换公平） */
  trainedSeat?: number;
  temperature: number;
  simulations: number;
  maxTurns?: number;
  maxSteps?: number;
}

export interface WorkerResult {
  type: 'result';
  gameIndex: number;
  kind: 'train' | 'eval';
  stats: GameStats;
  samples: TrainSample[];
  log: object[];
  /** eval 对局：训练权重一方的胜负（1 胜 / −1 负 / 0 平） */
  evalOutcome?: number;
}

process.on('message', (job: WorkerJob) => {
  if (!job || job.type !== 'play') return;
  if (job.kind === 'eval') {
    // 验收：训练权重 vs 种子权重（双方 argmax）
    const trainedSeat = job.trainedSeat ?? 1;
    const result = playEvalGame(job.map, trainedSeat, job.weights, job.baselineWeights!, {
      simulations: job.simulations,
      maxTurns: job.maxTurns,
      maxSteps: job.maxSteps,
    });
    const reply: WorkerResult = {
      type: 'result',
      gameIndex: job.gameIndex,
      kind: 'eval',
      stats: result.stats,
      samples: [],
      log: [],
      evalOutcome: result.outcome,
    };
    process.send!(reply);
    return;
  }
  // 训练自对弈（温度采样）
  const result = playSelfPlayGame(job.map, {
    weights: job.weights,
    mode: 'sample',
    temperature: job.temperature,
    simulations: job.simulations,
    maxTurns: job.maxTurns,
    maxSteps: job.maxSteps,
    seed: 'w' + job.gameIndex,
  });
  const reply: WorkerResult = {
    type: 'result',
    gameIndex: job.gameIndex,
    kind: 'train',
    stats: result.stats,
    samples: result.samples,
    log: result.log,
  };
  process.send!(reply);
});

// ---- 验收对局（双方 argmax；可双权重不同） ----

function playEvalGame(
  map: MapFullData,
  trainedSeat: number,
  trainedWeights: TeWeights,
  baselineWeights: TeWeights,
  opts: { simulations: number; maxTurns?: number; maxSteps?: number },
): { outcome: number; stats: GameStats } {
  const seatAssignments = [
    { seat: 1, playerId: 900001, isAI: false },
    { seat: 2, playerId: 900002, isAI: false },
  ];
  let state: GameState = initState({ map, seatAssignments, seed: 'e' + Math.random().toString(36).slice(2, 10), timeSettings: TIME_SETTINGS }).state;
  const gameId = 'e' + Math.random().toString(36).slice(2, 10);
  let steps = 0;
  let reason: GameStats['reason'] = 'victory';
  const maxTurns = opts.maxTurns ?? MAX_TURNS;
  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  while (!state.finished) {
    if (state.turn > maxTurns) {
      reason = 'turn_cap';
      break;
    }
    if (steps >= maxSteps) {
      reason = 'step_cap';
      break;
    }
    const seat = state.currentSeat;
    const weights = seat === trainedSeat ? trainedWeights : baselineWeights;
    const decision = mctsDecide(state, seat, weights, { simulations: opts.simulations, mode: 'argmax' });
    const intents = [...decision.plan.actionIntents, ...decision.plan.addPointIntents];
    for (const intent of intents) {
      const r = applyIntent(state, { actor: { kind: 'PLAYER', seat }, intent });
      if (!r.ok) continue;
      state = r.state;
      steps++;
      if (state.finished) break;
    }
  }
  const teamOf = (s: number) => state.forces.find((f) => f.seat === s)?.team ?? -1;
  const trainedTeam = teamOf(trainedSeat);
  let outcome = 0;
  if (state.finished && state.winningTeam !== null && state.winningTeam >= 0) {
    outcome = state.winningTeam === trainedTeam ? 1 : -1;
  }
  return {
    outcome,
    stats: {
      gameId,
      mapId: map.id,
      reason,
      winningTeam: state.finished ? state.winningTeam : null,
      winnerSeats: state.finished && state.winningTeam !== null && state.winningTeam >= 0 ? [1, 2].filter((s) => teamOf(s) === state.winningTeam) : [],
      turns: state.turn,
      steps,
      rejects: 0,
      stepsBySeat: {},
    },
  };
}
