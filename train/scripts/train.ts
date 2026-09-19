// train.ts — 训练主进程（设计方案 §5/§6）
// 主进程维护权重与训练进度；worker 并行自对弈；每 100 局拟合并下发新权重；
// 每 500 局验收（argmax vs 种子基准；eval-maps 为空则提示并跳过，训练不中断）；
// 验收达标（≥60%）自动停止；runs/ 断点续训。
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, unlinkSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEED_TE_WEIGHTS } from '../lib/eval.js';
import { fitWeights } from '../lib/fitter.js';
import type { TrainSample } from '../lib/driver.js';
import { MapPool, loadEvalMaps } from '../lib/pool.js';
import {
  MAPS_DIR,
  EVAL_MAPS_DIR,
  RUNS_DIR,
  WEIGHTS_DIR,
  SAMPLES_DIR,
  LOGS_DIR,
  STATE_FILE,
  CURVE_FILE,
  ACCEPTANCE_FILE,
} from '../lib/paths.js';
import { WeightStore, loadTrainState, saveTrainState, type TrainState } from '../lib/weights.js';
import type { WorkerJob, WorkerResult } from './worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- CLI ----------
interface Args {
  workers: number;
  simulations: number;
  fitEvery: number;
  acceptEvery: number;
  evalGames: number;
  maxGames?: number;
  saveLogs: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (key: string): string | undefined => {
    const i = argv.indexOf(`--${key}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    workers: Number(get('workers') ?? os.cpus().length),
    simulations: Number(get('simulations') ?? 300),
    fitEvery: Number(get('fit-every') ?? 100),
    acceptEvery: Number(get('accept-every') ?? 500),
    evalGames: Number(get('eval-games') ?? 100),
    maxGames: get('max-games') ? Number(get('max-games')) : undefined,
    saveLogs: get('save-logs') !== '0',
  };
}

// ---------- τ 调度（§5：0→500 局线性 1.0→0.1，之后恒 0.1） ----------
function temperatureAt(gamesDone: number): number {
  if (gamesDone >= 500) return 0.1;
  return 1.0 - 0.9 * (gamesDone / 500);
}

// ---------- 主流程 ----------
const args = parseArgs(process.argv.slice(2));
for (const dir of [RUNS_DIR, WEIGHTS_DIR, SAMPLES_DIR, LOGS_DIR]) mkdirSync(dir, { recursive: true });

const pool = new MapPool(MAPS_DIR);
const evalPool = loadEvalMaps(EVAL_MAPS_DIR);
const store = new WeightStore(WEIGHTS_DIR);

// 断点续训
const saved = loadTrainState(STATE_FILE);
const state: TrainState = saved ?? { gamesDone: 0, weightVersion: 0, sampleBatch: 0, updatedAt: new Date().toISOString() };
let currentRecord = store.current();
if (state.weightVersion !== currentRecord.version) {
  const latest = store.latest();
  if (latest) currentRecord = latest;
}

console.log(
  `[train] 启动：workers=${args.workers} simulations=${args.simulations} 图池=${pool.size}张 ` +
    `验收池=${evalPool ? evalPool.size + '张' : '空（验收将跳过并提示）'} ` +
    `已完成=${state.gamesDone} 权重版本=v${currentRecord.version}`,
);
if (!evalPool) {
  console.log('[train] 提示：train/eval-maps/ 为空——请放入自制验收地图，放入后下一次验收自动启用。');
}

// ---------- worker 池 ----------
interface WorkerHandle {
  child: ChildProcess;
  busy: boolean;
  job: WorkerJob | null;
}

const workers: WorkerHandle[] = [];
const evalQueue: number[] = []; // 待跑验收批次（里程碑号）
const evalTally = new Map<number, { wins: number; draws: number; losses: number; results: number }>();
const acceptedMilestones = new Set<number>();
const startGamesDone = state.gamesDone;
let nextGameIndex = state.gamesDone;
let lastFitMilestone = Math.floor(state.gamesDone / args.fitEvery); // 防双拟合（worker 并发完成时）
let stopped = false;

function spawnWorker(): WorkerHandle {
  const child = spawn(process.execPath, ['--max-old-space-size=768', '--import', 'tsx', path.join(__dirname, 'worker.ts')], {
    cwd: path.join(__dirname, '..', '..'),
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    serialization: 'advanced',
  });
  const handle: WorkerHandle = { child, busy: false, job: null };
  child.on('message', (msg: WorkerResult) => onResult(handle, msg));
  child.on('exit', (code) => {
    if (stopped) return;
    console.error(`[train] worker 异常退出（code=${code}），重启并重派任务`);
    const idx = workers.indexOf(handle);
    if (idx >= 0) workers.splice(idx, 1);
    if (handle.job) {
      // 任务重派（对局无状态，安全）
      if (handle.job.kind === 'eval') evalQueue.push(handle.job.gameIndex);
      else nextGameIndex = Math.min(nextGameIndex, handle.job.gameIndex);
    }
    workers.push(spawnWorker());
    dispatch();
  });
  return handle;
}

function nextJob(): WorkerJob | null {
  // 验收任务优先（保持验收节奏）
  if (evalQueue.length > 0) {
    const gameIndex = evalQueue.shift()!;
    const evalMap = evalPool ? evalPool.rotate(gameIndex) : pool.rotate(gameIndex);
    return {
      type: 'play',
      gameIndex,
      kind: 'eval',
      map: evalMap,
      weights: currentRecord.weights,
      baselineWeights: SEED_TE_WEIGHTS,
      trainedSeat: gameIndex % 2 === 0 ? 1 : 2, // 轮换先后手（公平）
      temperature: 0,
      simulations: args.simulations,
    };
  }
  if (args.maxGames !== undefined && nextGameIndex >= startGamesDone + args.maxGames) return null;
  const gameIndex = nextGameIndex++;
  return {
    type: 'play',
    gameIndex,
    kind: 'train',
    map: pool.rotate(gameIndex),
    weights: currentRecord.weights,
    temperature: temperatureAt(gameIndex),
    simulations: args.simulations,
  };
}

function dispatch(): void {
  if (stopped) return;
  for (const w of workers) {
    if (w.busy) continue;
    const job = nextJob();
    if (!job) {
      maybeFinish();
      return;
    }
    w.busy = true;
    w.job = job;
    w.child.send(job);
  }
}

function onResult(handle: WorkerHandle, msg: WorkerResult): void {
  handle.busy = false;
  const job = handle.job;
  handle.job = null;
  if (stopped) return;

  if (msg.kind === 'eval') {
    const milestone = Math.floor(msg.gameIndex / args.evalGames);
    const tally = evalTally.get(milestone) ?? { wins: 0, draws: 0, losses: 0, results: 0 };
    if (msg.evalOutcome === 1) tally.wins++;
    else if (msg.evalOutcome === -1) tally.losses++;
    else tally.draws++;
    tally.results++;
    evalTally.set(milestone, tally);
    if (tally.results === args.evalGames) {
      const rate = tally.wins / tally.results;
      const halfRate = (tally.wins + 0.5 * tally.draws) / tally.results;
      const mapsSource = evalPool ? 'eval-maps' : 'train-maps';
      appendFileSync(
        ACCEPTANCE_FILE,
        `games=${state.gamesDone},version=v${currentRecord.version},maps=${mapsSource},wins=${tally.wins},draws=${tally.draws},losses=${tally.losses},rate=${rate.toFixed(3)},halfRate=${halfRate.toFixed(3)}\n`,
      );
      console.log(
        `[accept] 第 ${milestone} 次验收（v${currentRecord.version} vs 基准，${mapsSource}）：` +
          `胜 ${tally.wins} / 平 ${tally.draws} / 负 ${tally.losses} → 胜率 ${(rate * 100).toFixed(1)}%`,
      );
      if (rate >= 0.6) {
        console.log('[accept] 达标（≥60%）——停止训练并输出报告。');
        writeFileSync(path.join(RUNS_DIR, 'REPORT.md'), reportMd(tally, rate, milestone));
        stopAll();
        return;
      }
    }
  } else {
    // 训练对局落盘
    recordTrainResult(msg);
  }
  dispatch();
  maybeFinish();
}

function recordTrainResult(msg: WorkerResult): void {
  const gameIndex = msg.gameIndex;
  // 样本批次文件（每 100 局一个批次，滑动窗口删除旧批次）
  const batchIndex = Math.floor(gameIndex / 100);
  const batchFile = path.join(SAMPLES_DIR, `batch-${String(batchIndex).padStart(4, '0')}.jsonl`);
  for (const s of msg.samples as TrainSample[]) {
    appendFileSync(batchFile, JSON.stringify(s) + '\n');
  }
  state.sampleBatch = Math.max(state.sampleBatch, batchIndex);
  // 对局日志
  if (args.saveLogs) {
    const logFile = path.join(LOGS_DIR, `game-${String(gameIndex).padStart(6, '0')}.jsonl`);
    writeFileSync(logFile, msg.log.map((line) => JSON.stringify(line)).join('\n') + '\n');
  }
  // 曲线
  appendFileSync(
    CURVE_FILE,
    `${gameIndex},${msg.stats.reason},${msg.stats.winningTeam ?? -1},${msg.stats.turns},${msg.stats.steps},v${currentRecord.version},${Date.now()}\n`,
  );
  state.gamesDone = Math.max(state.gamesDone, gameIndex + 1);
  state.updatedAt = new Date().toISOString();
  saveTrainState(STATE_FILE, state);

  // 拟合里程碑：gamesDone 并发乱序推进可能跳过精确倍数 → 按跨越判定
  const fitMilestone = Math.floor(state.gamesDone / args.fitEvery);
  if (fitMilestone > lastFitMilestone) {
    lastFitMilestone = fitMilestone;
    runFit(state.gamesDone);
  }
  // 验收里程碑
  const milestone = Math.floor(state.gamesDone / args.acceptEvery);
  if (milestone > 0 && !acceptedMilestones.has(milestone)) {
    acceptedMilestones.add(milestone);
    if (!evalPool) {
      console.log(`[accept] 已达 ${state.gamesDone} 局，但 train/eval-maps/ 为空——跳过本次抽检（请放入验收地图后继续）。`);
      appendFileSync(
        ACCEPTANCE_FILE,
        `games=${state.gamesDone},version=v${currentRecord.version},maps=SKIPPED_EMPTY_EVAL_MAPS\n`,
      );
    } else {
      const start = milestone * args.evalGames;
      for (let i = 0; i < args.evalGames; i++) evalQueue.push(start + i);
      console.log(`[accept] 已达 ${state.gamesDone} 局——派发 ${args.evalGames} 局验收（v${currentRecord.version} vs 基准）`);
    }
  }
  // 滑动窗口：保留最近 5 个样本批次（500 局）
  const minBatch = Math.max(0, batchIndex - 4);
  for (const f of readdirSync(SAMPLES_DIR)) {
    const idx = Number(f.match(/batch-(\d+)\.jsonl/)?.[1] ?? -1);
    if (idx >= 0 && idx < minBatch) {
      try {
        unlinkSync(path.join(SAMPLES_DIR, f));
      } catch {
        /* 并发删除忽略 */
      }
    }
  }
  if (state.gamesDone % 10 === 0) {
    console.log(`[train] 进度 ${state.gamesDone} 局（权重 v${currentRecord.version}，τ=${temperatureAt(state.gamesDone).toFixed(3)}）`);
  }
}

/** 每 fitEvery 局：用最近 500 局样本拟合并下发新权重 */
function runFit(gamesDone: number): void {
  const minBatch = Math.max(0, Math.floor((gamesDone - 1) / 100) - 4);
  const samples: TrainSample[] = [];
  for (const f of readdirSync(SAMPLES_DIR).sort()) {
    const idx = Number(f.match(/batch-(\d+)\.jsonl/)?.[1] ?? -1);
    if (idx >= minBatch) {
      const content = readFileSync(path.join(SAMPLES_DIR, f), 'utf8');
      for (const line of content.split('\n')) {
        if (line.trim()) samples.push(JSON.parse(line) as TrainSample);
      }
    }
  }
  if (samples.length === 0) return;
  const { weights, report } = fitWeights(samples, SEED_TE_WEIGHTS);
  currentRecord = store.next(weights, gamesDone, `fit@${gamesDone} samples=${samples.length} pairs=${report.pairsUsed}`);
  state.weightVersion = currentRecord.version;
  saveTrainState(STATE_FILE, state);
  console.log(
    `[fit] ${gamesDone} 局 → v${currentRecord.version}（样本 ${samples.length}，pair 更新 ${report.pairsUsed}/${report.stepsRun}，` +
      `损失 ${report.lossBefore.toFixed(4)} → ${report.lossAfter.toFixed(4)}）`,
  );
}

function reportMd(tally: { wins: number; draws: number; losses: number }, rate: number, milestone: number): string {
  return [
    '# 数字领主 MCTS AI 训练验收报告',
    '',
    `- 完成时间：${new Date().toISOString()}`,
    `- 权重版本：v${currentRecord.version}（games=${state.gamesDone}）`,
    `- 验收批次：第 ${milestone} 次（${args.evalGames} 局）`,
    `- 对手：种子权重基准（argmax，同引擎同预算）`,
    `- 地图：${evalPool ? 'train/eval-maps/（用户设计）' : '训练图池（无泛化检验）'}`,
    `- 结果：胜 ${tally.wins} / 平 ${tally.draws} / 负 ${tally.losses}`,
    `- 胜率：${(rate * 100).toFixed(1)}%（达标线 60%）`,
    '',
    '权重文件：train/runs/weights/；胜率曲线：train/runs/curve.csv；验收记录：train/runs/acceptance.csv',
  ].join('\n');
}

let exitRequested = false;
function stopAll(): void {
  stopped = true;
  exitRequested = true;
  for (const w of workers) {
    try {
      w.child.kill();
    } catch {
      /* 忽略 */
    }
  }
  setTimeout(() => process.exit(0), 500);
}

function maybeFinish(): void {
  if (stopped || exitRequested) return;
  if (args.maxGames === undefined) return;
  if (nextGameIndex < startGamesDone + args.maxGames) return;
  if (evalQueue.length > 0) return;
  if (workers.every((w) => !w.busy)) {
    console.log(`[train] 已达 --max-games ${args.maxGames}，正常退出。`);
    stopAll();
  }
}

// ---------- 启动 ----------
for (let i = 0; i < args.workers; i++) workers.push(spawnWorker());
dispatch();

process.on('SIGINT', () => {
  console.log('\n[train] 收到中断——保存进度后退出（再次启动将断点续训）。');
  saveTrainState(STATE_FILE, state);
  stopAll();
});
