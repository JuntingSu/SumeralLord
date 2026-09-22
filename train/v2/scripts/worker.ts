// worker.ts — 训练 worker 子进程：领任务（自对弈出样本 / 门限对局 / 验收对局），回传结果
// 由主脚本以 `node --import tsx worker.ts` 派生，IPC 通信（structured clone）。
import { readFileSync } from 'node:fs';
import { initMctsWeights, planMctsTurn } from '@dl/train'; // v1 基准引擎（main → v1/lib/online.ts）
import type { MapFullData, PlayerIntent } from '@dl/shared';
import { actionToIntent } from '../lib/actions.js';
import { playGame } from '../lib/driver.js';
import type { GameStats, Policy } from '../lib/driver.js';
import { mctsDecide } from '../lib/mcts.js';
import { NeuralNet } from '../lib/nn.js';
import { writeGameLog, writeSamplesBinary } from '../lib/sampleio.js';

export interface SelfplayJob {
  type: 'selfplay';
  jobId: number;
  map: MapFullData;
  /** seatA 方模型（onnx 路径） */
  modelA: string;
  /** seatB 方模型（onnx 路径） */
  modelB: string;
  seatA: number;
  seatB: number;
  /** 每步随机模拟数范围（playout cap randomization，决策定稿 §6） */
  simsMin: number;
  simsMax: number;
  /** 根温度采样 */
  temperature: number;
  seed: string;
  samplesDir: string;
  logsDir: string;
  maxTurns?: number;
  maxSteps?: number;
}

export interface GateJob {
  type: 'gate';
  jobId: number;
  map: MapFullData;
  /** 待评估新权重模型 */
  modelNew: string;
  /** 当前生效权重模型 */
  modelCurrent: string;
  /** 新权重一方座次（1/2，交替公平） */
  trainedSeat: number;
  /** 固定模拟数（argmax） */
  simulations: number;
  seed: string;
  maxTurns?: number;
  maxSteps?: number;
}

export interface AcceptJob {
  type: 'accept';
  jobId: number;
  map: MapFullData;
  /** v2 训练 AI 模型（onnx） */
  modelV2: string;
  /** v2 一方座次（交替公平） */
  v2Seat: number;
  /** v2 每步模拟数（部署配置，缺省 200） */
  v2Sims?: number;
  /** v1 基准权重文件（{weights:{mid,late}} 或裸 {mid,late}） */
  baselineWeightsPath: string;
  /** v1 基准每回合模拟数（缺省 300） */
  baselineSims?: number;
  seed: string;
  maxTurns?: number;
  maxSteps?: number;
}

export type WorkerJob = SelfplayJob | GateJob | AcceptJob;

export type WorkerResult =
  | { type: 'result'; jobId: number; kind: 'selfplay'; stats: GameStats; sampleCount: number }
  | { type: 'result'; jobId: number; kind: 'gate'; outcome: number }
  | { type: 'result'; jobId: number; kind: 'accept'; outcome: number; steps: number; reason: string; rejects: number };

const randInt = (min: number, max: number): number => min + Math.floor(Math.random() * (max - min + 1));

/** 自对弈：双方各自模型 + 每步随机模拟数 + 温度采样；落盘样本/日志 */
async function runSelfplay(job: SelfplayJob): Promise<WorkerResult> {
  const netA = await NeuralNet.load(job.modelA);
  const netB = await NeuralNet.load(job.modelB);
  const nets: Record<number, NeuralNet> = { [job.seatA]: netA, [job.seatB]: netB };
  const policy: Policy = async (state) => {
    const net = nets[state.currentSeat];
    const r = await mctsDecide(state, net, {
      simulations: randInt(job.simsMin, job.simsMax),
      temperature: job.temperature,
    });
    return { intent: actionToIntent(state, r.action), pi: r.pi };
  };
  const result = await playGame(job.map, {
    policy,
    seed: job.seed,
    maxTurns: job.maxTurns,
    maxSteps: job.maxSteps,
  });
  writeSamplesBinary(job.samplesDir, result.stats.gameId, result.samples);
  writeGameLog(job.logsDir, result.stats.gameId, result.log);
  return { type: 'result', jobId: job.jobId, kind: 'selfplay', stats: result.stats, sampleCount: result.samples.length };
}

/** 门限对局：新 vs 当前，双方 argmax 固定模拟数；返回新权重一方胜负（1/−1/0） */
async function runGate(job: GateJob): Promise<WorkerResult> {
  const netNew = await NeuralNet.load(job.modelNew);
  const netCur = await NeuralNet.load(job.modelCurrent);
  const otherSeat = job.trainedSeat === 1 ? 2 : 1;
  const nets: Record<number, NeuralNet> = { [job.trainedSeat]: netNew, [otherSeat]: netCur };
  const policy: Policy = async (state) => {
    const net = nets[state.currentSeat];
    const r = await mctsDecide(state, net, { simulations: job.simulations }); // τ=0 argmax
    return { intent: actionToIntent(state, r.action) };
  };
  const result = await playGame(job.map, {
    policy,
    seed: job.seed,
    maxTurns: job.maxTurns,
    maxSteps: job.maxSteps,
  });
  const wt = result.stats.winningTeam;
  let outcome = 0;
  if (wt !== null && wt >= 0) {
    const team = result.finalState.forces.find((f) => f.seat === job.trainedSeat)?.team ?? -1;
    outcome = team === wt ? 1 : -1;
  }
  return { type: 'result', jobId: job.jobId, kind: 'gate', outcome };
}

/** 验收对局：v2 训练 AI（原子 MCTS，部署配置）vs v1 基准（v45 权重回合级 MCTS）；
 *  返回 v2 一方胜负（1/−1/0）。v1 引擎经 @dl/train（main → v1/lib/online.ts）调用。 */
async function runAccept(job: AcceptJob): Promise<WorkerResult> {
  const netV2 = await NeuralNet.load(job.modelV2);
  const raw = JSON.parse(readFileSync(job.baselineWeightsPath, 'utf8')) as unknown;
  const rec = raw as { weights?: { mid: number[]; late: number[] } };
  const w = (rec.weights ?? rec) as { mid: number[]; late: number[] };
  if (!Array.isArray(w.mid) || !Array.isArray(w.late)) {
    throw new Error(`基准权重格式异常：${job.baselineWeightsPath}`);
  }
  initMctsWeights(w);

  const v1Seat = job.v2Seat === 1 ? 2 : 1;
  let v1Plan: PlayerIntent[] = [];
  let planTurn = -1;
  const policy: Policy = async (state) => {
    if (state.currentSeat === v1Seat) {
      // v1 线上 bot 语义：计划含偶尔非法意图 → 丢弃被拒意图继续下一条；跨回合/计划耗尽 → 重新规划
      if (v1Plan.length === 0 || state.turn !== planTurn) {
        v1Plan = planMctsTurn(state, v1Seat, {
          simulations: job.baselineSims ?? 300,
          timeBudgetMs: 5000,
        });
        planTurn = state.turn;
      }
      return { intent: v1Plan.shift()! };
    }
    const r = await mctsDecide(state, netV2, { simulations: job.v2Sims ?? 200 });
    return { intent: actionToIntent(state, r.action) };
  };
  const result = await playGame(job.map, {
    policy,
    seed: job.seed,
    maxTurns: job.maxTurns,
    maxSteps: job.maxSteps,
  });
  const wt = result.stats.winningTeam;
  let outcome = 0;
  if (wt !== null && wt >= 0) {
    const team = result.finalState.forces.find((f) => f.seat === job.v2Seat)?.team ?? -1;
    outcome = team === wt ? 1 : -1;
  }
  return {
    type: 'result',
    jobId: job.jobId,
    kind: 'accept',
    outcome,
    steps: result.stats.steps,
    reason: result.stats.reason,
    rejects: result.stats.rejects,
  };
}

process.on('message', (job: WorkerJob) => {
  if (!job) return;
  const work =
    job.type === 'selfplay' ? runSelfplay(job) : job.type === 'gate' ? runGate(job) : runAccept(job);
  work
    .then((reply) => process.send!(reply))
    .catch((e) => {
      console.error(`[worker] 任务失败（jobId=${job.jobId} type=${job.type}）：${String(e)}`);
      process.exit(1);
    });
});
