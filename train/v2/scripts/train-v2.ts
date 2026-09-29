// train-v2.ts — 训练主循环（决策定稿 §6/§8）
//
// 每轮：自对弈 gamesPerRound 局（worker 并行，双方从对手池随机抽模型，每步随机模拟数 5~200 + 温度采样）
// → Python 拟合（训练子采样样本）→ 导出 ONNX → 门限对局（新 vs 当前，argmax，独立验收图池，≥55% 接受）
// → 更新对手池 / 胜率曲线 / 状态。
//
// 用法：npx tsx v2/scripts/train-v2.ts [--stage selfplay|extract|fit|warmup] [--workers N] [--games-per-round N]
//   [--gate-games N] [--gate-sims N] [--epochs N] [--max-samples N] [--max-rounds N] [--keep-rounds N] ...
//   --stage 只执行单个阶段（缺省 = 全自动连续循环；round/gamesDone 只由 fit 阶段推进，三步按轮对齐）：
//     selfplay  当前轮自对弈（断点续跑：只补跑缺失局，已完成对局的样本/日志保留）
//     extract   偏好题抽样 + 人类标注转换（demos/prefs → runs/demo-samples、runs/pref-samples）
//     fit       拟合 + 导出 ONNX + 门限对局 + 接受入池 + 推进轮次
//     warmup    用 v1 示范对局样本（runs/v1-samples，由 v1-games-to-samples.ts 生成）拟合种子模型 v0
//   fit 阶段自动并入 runs/v1-samples 作为额外样本（v1 示范对局持续参与训练；无该目录则跳过）。
// 断点续跑：中断重启时保留当前轮已完成对局的样本/日志（worker 按 jobId 命名 game-j<gi>.bin），只补跑缺失局；
// 旧格式样本（随机 gameId 命名）保留不删但不跳过。
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MapFullData } from '@dl/shared';
import { acceptVersion, drawOpponents, loadPool, savePool, type PoolState } from '../lib/pool.js';
import { assignLegacyGi, scanRoundResume, type RoundResume } from '../lib/roundresume.js';
import { runWorkerJobs } from '../lib/workerpool.js';
import { CURVE_FILE, EVAL_MAPS_DIR, LOGS_DIR, MAPS_DIR, SAMPLES_DIR, STATE_FILE, V2_ROOT, WEIGHTS_DIR } from '../lib/paths.js';
import type { WorkerJob, WorkerResult } from './worker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PY = path.join(V2_ROOT, 'python');

interface Args {
  workers: number;
  gamesPerRound: number;
  gateGames: number;
  gateSims: number;
  dataSimsMin: number;
  dataSimsMax: number;
  tauStart: number;
  tauEnd: number;
  tauGames: number;
  epochs: number;
  lr: number;
  maxSamples: number;
  maxRounds: number;
  maxSteps: number | undefined;
  /** 保留最近 N 轮样本（0/负 = 全部保留；磁盘占用约 10GB+/轮，默认 2 轮） */
  keepRounds: number;
  /** warmup（v1 示范拟合种子）轮数（缺省 10：小数据多拟合几轮） */
  warmupEpochs: number;
  /** 示范损失初始权重与每轮衰减（决策定稿 §7：λ_bc 初始 1.0、每轮 ×0.9） */
  lambdaBcInit: number;
  lambdaBcDecay: number;
}

function get(key: string): string | undefined {
  const i = process.argv.indexOf(`--${key}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function num(key: string, dft: number): number {
  const v = get(key);
  return v === undefined ? dft : Number(v);
}

const args: Args = {
  // 钉线程后每 worker ≈ 1 核真算力：默认 = 逻辑核数一半，留余量给 Python 拟合阶段（torch 同样吃满 CPU）
  workers: num('workers', Math.max(1, Math.floor(os.cpus().length / 2))),
  gamesPerRound: num('games-per-round', 1000),
  gateGames: num('gate-games', 100),
  gateSims: num('gate-sims', 100),
  dataSimsMin: num('data-sims-min', 5),
  dataSimsMax: num('data-sims-max', 200),
  tauStart: num('tau-start', 10),
  tauEnd: num('tau-end', 0.5),
  tauGames: num('tau-games', 10000),
  epochs: num('epochs', 3),
  lr: num('lr', 1e-3),
  maxSamples: num('max-samples', 300_000),
  maxRounds: num('max-rounds', Infinity),
  keepRounds: num('keep-rounds', 2),
  warmupEpochs: num('warmup-epochs', 10),
  maxSteps: get('max-steps') === undefined ? undefined : Number(get('max-steps')),
  lambdaBcInit: num('lambda-bc-init', 1.0),
  lambdaBcDecay: num('lambda-bc-decay', 0.9),
};

interface RunState {
  round: number;
  gamesDone: number;
}

function loadState(): RunState {
  if (existsSync(STATE_FILE)) {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as RunState;
    return { round: raw.round ?? 0, gamesDone: raw.gamesDone ?? 0 };
  }
  return { round: 0, gamesDone: 0 };
}
function saveState(s: RunState): void {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function loadMaps(dir: string): MapFullData[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as MapFullData);
}

const modelPath = (version: string) => path.join(WEIGHTS_DIR, `model-${version}.onnx`);

/** 运行 Python 脚本（cwd = v2/python；参数用相对 v2 根的路径） */
function runPython(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('python', [script, ...args], { cwd: PY, stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`python ${script} 退出码 ${code}`))));
    child.on('error', reject);
  });
}

/** 运行 TS 脚本（cwd = v2 根；node --import tsx）。script 为 scripts/ 目录下的文件名（__dirname = scripts） */
function runTsx(script: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', path.join(__dirname, script), ...args],
      { cwd: V2_ROOT, stdio: 'inherit' },
    );
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tsx ${script} 退出码 ${code}`))));
    child.on('error', reject);
  });
}

function appendCurve(line: string): void {
  mkdirSync(path.dirname(CURVE_FILE), { recursive: true });
  if (!existsSync(CURVE_FILE)) writeFileSync(CURVE_FILE, 'round,games_done,version,gate_wins,gate_games,gate_winrate,accepted\n');
  writeFileSync(CURVE_FILE, line + '\n', { flag: 'a' });
}

function pruneOldRounds(keep: number): void {
  if (keep <= 0) return; // 0/负 = 全部保留
  for (const sub of ['samples']) {
    const dir = path.join(SAMPLES_DIR); // samples 已含 round-xxx
    if (!existsSync(dir)) continue;
    const rounds = readdirSync(dir)
      .filter((f) => f.startsWith('round-'))
      .sort();
    for (const r of rounds.slice(0, -keep)) rmSync(path.join(dir, r), { recursive: true, force: true });
  }
}

// ---------- 阶段拆分（--stage 手工分步；全自动循环复用同一批函数） ----------

/** 当前轮上下文：目录 + 断点续跑扫描结果 */
interface RoundCtx {
  round: number;
  roundTag: string;
  roundSamples: string;
  roundLogs: string;
  resume: RoundResume;
  legacyTotal: number;
  leftoverLegacy: number;
}

/** 温度调度（训练中 τ 随已对局数衰减） */
const tauAt = (gamesDone: number): number =>
  gamesDone >= args.tauGames ? args.tauEnd : args.tauStart - ((args.tauStart - args.tauEnd) * gamesDone) / args.tauGames;

/** 当前轮目录准备 + 断点续跑扫描：已有可恢复对局（game-j<gi>.bin 或旧格式）→ 保留只补跑缺失局；
 *  无可恢复数据（全新轮次）→ 清掉残留半成品，避免混入训练 */
function prepareRound(state: RunState): RoundCtx {
  const round = state.round;
  const roundTag = String(round).padStart(5, '0');
  const roundSamples = path.join(SAMPLES_DIR, `round-${roundTag}`);
  const roundLogs = path.join(LOGS_DIR, `round-${roundTag}`);
  const resume = scanRoundResume(roundSamples);
  if (resume.completed.size === 0 && resume.legacyCounts.length === 0) {
    rmSync(roundSamples, { recursive: true, force: true });
    rmSync(roundLogs, { recursive: true, force: true });
  }
  // 旧格式样本（无 jobId 信息）映射到空位 gi：样本内容与 gi 无关，映射后一并跳过重跑
  const legacyTotal = resume.legacyCounts.length;
  const leftoverLegacy = assignLegacyGi(resume, state.gamesDone, state.gamesDone + args.gamesPerRound);
  mkdirSync(roundSamples, { recursive: true });
  mkdirSync(roundLogs, { recursive: true });
  return { round, roundTag, roundSamples, roundLogs, resume, legacyTotal, leftoverLegacy };
}

/** a. 自对弈：跑当前轮（断点续跑只补缺失局；样本/日志按 jobId 命名 game-j<gi>） */
async function runSelfplay(ctx: RoundCtx, state: RunState, pool: PoolState, maps: MapFullData[]): Promise<void> {
  const { round, roundSamples, roundLogs, resume, legacyTotal, leftoverLegacy } = ctx;
  console.log(`\n[train-v2] === round ${round} === 自对弈 ${args.gamesPerRound} 局（${args.workers} workers）…`);
  const jobs: WorkerJob[] = [];
  for (let i = 0; i < args.gamesPerRound; i++) {
    const gi = state.gamesDone + i;
    if (resume.completed.has(gi)) continue; // 上次中断前已完成：跳过不重跑
    const [oppA, oppB] = drawOpponents(pool);
    jobs.push({
      type: 'selfplay',
      jobId: gi,
      map: maps[gi % maps.length],
      modelA: modelPath(oppA),
      modelB: modelPath(oppB),
      seatA: 1,
      seatB: 2,
      simsMin: args.dataSimsMin,
      simsMax: args.dataSimsMax,
      temperature: tauAt(gi),
      seed: `sp-${gi}`,
      samplesDir: roundSamples,
      logsDir: roundLogs,
      maxSteps: args.maxSteps,
    });
  }
  if (resume.completed.size > 0 || legacyTotal > 0) {
    console.log(
      `[train-v2] 断点续跑：已有 ${resume.completed.size} 局可跳过（j<gi>），旧格式 ${legacyTotal} 局（映射跳过 ${legacyTotal - leftoverLegacy}、保留 ${leftoverLegacy}），补跑 ${jobs.length} 局`,
    );
  }
  const t0 = Date.now();
  const results: WorkerResult[] = await runWorkerJobs(jobs, args.workers);
  let sampleCount =
    [...resume.completed.values()].reduce((a, b) => a + b, 0) + resume.legacyCounts.reduce((a, b) => a + b, 0);
  let rejects = 0;
  const reasons: Record<string, number> = {};
  for (const r of results) {
    if (r.kind === 'selfplay') {
      sampleCount += r.sampleCount;
      rejects += r.stats.rejects;
      reasons[r.stats.reason] = (reasons[r.stats.reason] ?? 0) + 1;
    }
  }
  if (rejects > 0) console.warn(`[train-v2] 警告：本轮意图拒绝 ${rejects} 条（应恒为 0）`);
  console.log(
    `[train-v2] 自对弈完成：${results.length} 局，样本 ${sampleCount}，原因 ${JSON.stringify(reasons)}，耗时 ${((Date.now() - t0) / 60000).toFixed(1)} min`,
  );
}

/** b1. 数据提取：偏好题抽样 + 人类标注转换（失败仅警告，不中断；产物供下一阶段 fit 消费） */
async function runExtract(pool: PoolState): Promise<void> {
  console.log(`[train-v2] 人类指导数据：抽样偏好题 + 转换标注…`);
  try {
    await runTsx('sample-questions.ts', ['--model', modelPath(pool.current)]);
  } catch (e) {
    console.warn(`[train-v2] 偏好题抽样失败（继续）：${String(e)}`);
  }
  try {
    await runTsx('annotations-to-samples.ts', []);
  } catch (e) {
    console.warn(`[train-v2] 标注转换失败（继续）：${String(e)}`);
  }
}

/** b2+c+d. 拟合 + 导出 + 门限对局 + 推进轮次（round/gamesDone 仅在此阶段推进） */
async function runFitAndGate(ctx: RoundCtx, state: RunState, pool: PoolState, evalMaps: MapFullData[]): Promise<void> {
  const { round, roundTag, roundSamples } = ctx;
  // 该轮样本必须是已完成自对弈的（拟合前重新扫描，循环模式与 --stage fit 都成立）
  const done = scanRoundResume(roundSamples);
  if (done.completed.size === 0 && done.legacyCounts.length === 0) {
    throw new Error(`round ${round} 无自对弈样本（请先执行 --stage selfplay）`);
  }
  const version = `v${round + 1}`;
  const pt = path.join(WEIGHTS_DIR, `checkpoint-${version}.pt`);
  const onnx = path.join(WEIGHTS_DIR, `model-${version}.onnx`);
  const lambdaBc = args.lambdaBcInit * Math.pow(args.lambdaBcDecay, round);
  // v1 示范对局样本（v1-games-to-samples.ts 产物）：存在则并入本轮训练
  const v1Samples = path.join(V2_ROOT, 'runs', 'v1-samples');
  const v1Extra = existsSync(v1Samples) && readdirSync(v1Samples).some((f) => f.endsWith('.bin'));
  console.log(`[train-v2] 拟合 ${version}（λ_bc = ${lambdaBc.toFixed(3)}${v1Extra ? '，并入 v1 示范样本' : ''}）…`);
  await runPython('train.py', [
    '--samples-dir',
    `../runs/samples/round-${roundTag}`,
    ...(v1Extra ? ['--extra-samples-dir', '../runs/v1-samples'] : []),
    '--demo-dir',
    '../runs/demo-samples',
    '--pref-dir',
    '../runs/pref-samples',
    '--lambda-bc',
    lambdaBc.toFixed(4),
    '--out',
    `../runs/weights/checkpoint-${version}.pt`,
    '--epochs',
    String(args.epochs),
    '--lr',
    String(args.lr),
    '--max-samples',
    String(args.maxSamples),
  ]);
  await runPython('export.py', [
    '--checkpoint',
    `../runs/weights/checkpoint-${version}.pt`,
    '--out',
    `../runs/weights/model-${version}.onnx`,
  ]);

  // c. 门限对局
  let gateOutcome = { wins: 0, draws: 0, games: 0, winRate: 1 };
  if (evalMaps.length === 0) {
    console.warn('[train-v2] 警告：验收图池为空，跳过门限直接接受（请放入 train/eval-maps/）');
  } else {
    console.log(`[train-v2] 门限对局：${version} vs ${pool.current}（${args.gateGames} 局，argmax ${args.gateSims} 模拟）…`);
    const gateJobs: WorkerJob[] = [];
    for (let i = 0; i < args.gateGames; i++) {
      gateJobs.push({
        type: 'gate',
        jobId: 1_000_000 + i,
        map: evalMaps[i % evalMaps.length],
        modelNew: onnx,
        modelCurrent: modelPath(pool.current),
        trainedSeat: i % 2 === 0 ? 1 : 2,
        simulations: args.gateSims,
        seed: `gate-${round}-${i}`,
        maxSteps: args.maxSteps,
      });
    }
    const gResults = await runWorkerJobs(gateJobs, args.workers);
    let wins = 0;
    let draws = 0;
    for (const r of gResults) {
      if (r.kind === 'gate') {
        if (r.outcome > 0) wins++;
        else if (r.outcome === 0) draws++;
      }
    }
    const winRate = wins / gateJobs.length;
    gateOutcome = { wins, draws, games: gateJobs.length, winRate };
  }

  const accepted = gateOutcome.winRate >= 0.55;
  if (accepted) acceptVersion(pool, version);
  console.log(
    `[train-v2] 门限：${gateOutcome.wins} 胜 / ${gateOutcome.draws} 平 / ${gateOutcome.games - gateOutcome.wins - gateOutcome.draws} 负，` +
      `胜率 ${(gateOutcome.winRate * 100).toFixed(1)}% → ${accepted ? `接受，current=${pool.current}` : '丢弃'}`,
  );

  // d. 曲线 + 状态 + 清理
  appendCurve(
    `${round},${state.gamesDone + args.gamesPerRound},${version},${gateOutcome.wins},${gateOutcome.games},${gateOutcome.winRate.toFixed(4)},${accepted ? 1 : 0}`,
  );
  state.round += 1;
  state.gamesDone += args.gamesPerRound;
  savePool(WEIGHTS_DIR, pool);
  saveState(state);
  pruneOldRounds(args.keepRounds);
}

async function main(): Promise<void> {
  const stage = get('stage');
  if (stage !== undefined && stage !== 'selfplay' && stage !== 'extract' && stage !== 'fit' && stage !== 'warmup') {
    throw new Error(`未知 --stage ${stage}（可选 selfplay / extract / fit / warmup；缺省 = 全自动连续循环）`);
  }

  console.log(
    `[train-v2] 启动：workers=${args.workers} gamesPerRound=${args.gamesPerRound} gate=${args.gateGames}局/${args.gateSims}模拟 ` +
      `dataSims=[${args.dataSimsMin},${args.dataSimsMax}] τ=${args.tauStart}→${args.tauEnd}/${args.tauGames} epochs=${args.epochs} maxSamples=${args.maxSamples}` +
      (stage ? ` stage=${stage}` : ''),
  );
  console.log(
    `[train-v2] 提示：推理已钉 1 线程/worker ≈ 1 核，建议 workers 不超过物理核数并留 1~2 核给拟合/门限阶段（本机 ${os.cpus().length} 逻辑核）`,
  );

  // 0. 种子模型
  if (!existsSync(path.join(WEIGHTS_DIR, 'model-v0.onnx'))) {
    console.log('[train-v2] 生成种子模型 v0…');
    await runPython('init_model.py', ['--out-dir', '../runs/weights']);
  }

  const pool = loadPool(WEIGHTS_DIR);
  const state = loadState();
  const maps = loadMaps(MAPS_DIR);
  const evalMaps = loadMaps(EVAL_MAPS_DIR);
  if (maps.length === 0) throw new Error(`训练图池为空：${MAPS_DIR}`);
  console.log(
    `[train-v2] 对手池 [${pool.pool.join(',')}] current=${pool.current} 图池=${maps.length} 验收图池=${evalMaps.length} 从 round ${state.round} 继续`,
  );

  // ---- 手工分步模式：每次只执行一个阶段（--stage） ----
  if (stage === 'warmup') {
    // 用 v1 示范对局样本拟合种子模型 v0（覆盖随机种子；池 current 保持 v0）
    const v1Samples = path.join(V2_ROOT, 'runs', 'v1-samples');
    const hasV1 = existsSync(v1Samples) && readdirSync(v1Samples).some((f) => f.endsWith('.bin'));
    if (!hasV1) {
      throw new Error('runs/v1-samples 为空（请先运行 v1-games-to-samples.ts 转换 v1 对局日志）');
    }
    console.log(`[train-v2] warmup：用 v1 示范对局样本拟合种子模型 v0（${args.warmupEpochs} epochs）…`);
    await runPython('train.py', [
      '--samples-dir',
      '../runs/v1-samples',
      '--demo-dir',
      '../runs/demo-samples',
      '--pref-dir',
      '../runs/pref-samples',
      '--epochs',
      String(args.warmupEpochs),
      '--lr',
      String(args.lr),
      '--max-samples',
      String(args.maxSamples),
      '--out',
      '../runs/weights/checkpoint-v0.pt',
    ]);
    await runPython('export.py', [
      '--checkpoint',
      '../runs/weights/checkpoint-v0.pt',
      '--out',
      '../runs/weights/model-v0.onnx',
    ]);
    console.log('[train-v2] --stage warmup 完成：model-v0.onnx 已更新为 v1 示范拟合种子（池 current 保持 v0）');
    return;
  }
  if (stage === 'selfplay') {
    await runSelfplay(prepareRound(state), state, pool, maps);
    console.log('[train-v2] --stage selfplay 完成（下一步：--stage extract → --stage fit）');
    return;
  }
  if (stage === 'extract') {
    await runExtract(pool);
    console.log('[train-v2] --stage extract 完成（产物：prefs/pairs-*.json、runs/demo-samples、runs/pref-samples；下一步：--stage fit）');
    return;
  }
  if (stage === 'fit') {
    await runFitAndGate(prepareRound(state), state, pool, evalMaps);
    console.log(`[train-v2] --stage fit 完成（已推进至 round ${state.round}；下一步：--stage selfplay）`);
    return;
  }

  // ---- 全自动连续循环（缺省；与旧行为一致） ----
  while (state.round < args.maxRounds) {
    const ctx = prepareRound(state);
    await runSelfplay(ctx, state, pool, maps);
    await runExtract(pool);
    await runFitAndGate(ctx, state, pool, evalMaps);
  }
  console.log('[train-v2] 达到 max-rounds，结束。');
}

main().catch((e) => {
  console.error('[train-v2] 主循环异常：', e);
  process.exit(1);
});
