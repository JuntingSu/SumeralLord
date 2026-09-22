// train-v2.ts — 训练主循环（决策定稿 §6/§8）
//
// 每轮：自对弈 gamesPerRound 局（worker 并行，双方从对手池随机抽模型，每步随机模拟数 5~200 + 温度采样）
// → Python 拟合（训练子采样样本）→ 导出 ONNX → 门限对局（新 vs 当前，argmax，独立验收图池，≥55% 接受）
// → 更新对手池 / 胜率曲线 / 状态。
//
// 用法：npx tsx v2/scripts/train-v2.ts [--workers N] [--games-per-round N] [--gate-games N]
//   [--gate-sims N] [--epochs N] [--max-samples N] [--max-rounds N] ...
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MapFullData } from '@dl/shared';
import { acceptVersion, drawOpponents, loadPool, savePool } from '../lib/pool.js';
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
  workers: num('workers', os.cpus().length),
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

/** 运行 TS 脚本（cwd = v2 根；node --import tsx） */
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

/** 批量派发任务到 worker 池（每 worker 完成后领取下一任务；队列空则退出） */
// 实现移至 lib/workerpool.ts（train-v2 与验收脚本共用）
import { runWorkerJobs } from '../lib/workerpool.js';

function appendCurve(line: string): void {
  mkdirSync(path.dirname(CURVE_FILE), { recursive: true });
  if (!existsSync(CURVE_FILE)) writeFileSync(CURVE_FILE, 'round,games_done,version,gate_wins,gate_games,gate_winrate,accepted\n');
  writeFileSync(CURVE_FILE, line + '\n', { flag: 'a' });
}

function pruneOldRounds(keep: number): void {
  for (const sub of ['samples']) {
    const dir = path.join(SAMPLES_DIR); // samples 已含 round-xxx
    if (!existsSync(dir)) continue;
    const rounds = readdirSync(dir)
      .filter((f) => f.startsWith('round-'))
      .sort();
    for (const r of rounds.slice(0, -keep)) rmSync(path.join(dir, r), { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log(
    `[train-v2] 启动：workers=${args.workers} gamesPerRound=${args.gamesPerRound} gate=${args.gateGames}局/${args.gateSims}模拟 ` +
      `dataSims=[${args.dataSimsMin},${args.dataSimsMax}] τ=${args.tauStart}→${args.tauEnd}/${args.tauGames} epochs=${args.epochs} maxSamples=${args.maxSamples}`,
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
  console.log(`[train-v2] 对手池 [${pool.pool.join(',')}] current=${pool.current} 图池=${maps.length} 验收图池=${evalMaps.length} 从 round ${state.round} 继续`);

  const tauAt = (gamesDone: number): number =>
    gamesDone >= args.tauGames
      ? args.tauEnd
      : args.tauStart - ((args.tauStart - args.tauEnd) * gamesDone) / args.tauGames;

  while (state.round < args.maxRounds) {
    const round = state.round;
    const roundTag = String(round).padStart(5, '0');
    const roundSamples = path.join(SAMPLES_DIR, `round-${roundTag}`);
    const roundLogs = path.join(LOGS_DIR, `round-${roundTag}`);
    // 中断后重启会重跑当前轮次：先清掉该轮残留的半成品样本/日志，避免混入训练
    rmSync(roundSamples, { recursive: true, force: true });
    rmSync(roundLogs, { recursive: true, force: true });
    mkdirSync(roundSamples, { recursive: true });
    mkdirSync(roundLogs, { recursive: true });

    // a. 自对弈
    console.log(`\n[train-v2] === round ${round} === 自对弈 ${args.gamesPerRound} 局（${args.workers} workers）…`);
    const jobs: WorkerJob[] = [];
    for (let i = 0; i < args.gamesPerRound; i++) {
      const gi = state.gamesDone + i;
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
    const t0 = Date.now();
    const results = await runWorkerJobs(jobs, args.workers);
    let sampleCount = 0;
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
    console.log(`[train-v2] 自对弈完成：${results.length} 局，样本 ${sampleCount}，原因 ${JSON.stringify(reasons)}，耗时 ${((Date.now() - t0) / 60000).toFixed(1)} min`);

    // b. 拟合 + 导出（人类指导：先抽样偏好题 + 转换标注 → 训练损失带 λ_bc/λ_pref）
    const version = `v${round + 1}`;
    const pt = path.join(WEIGHTS_DIR, `checkpoint-${version}.pt`);
    const onnx = path.join(WEIGHTS_DIR, `model-${version}.onnx`);
    console.log(`[train-v2] 人类指导数据：抽样偏好题 + 转换标注…`);
    try {
      await runTsx('scripts/sample-questions.ts', ['--model', modelPath(pool.current)]);
    } catch (e) {
      console.warn(`[train-v2] 偏好题抽样失败（继续）：${String(e)}`);
    }
    try {
      await runTsx('scripts/annotations-to-samples.ts', []);
    } catch (e) {
      console.warn(`[train-v2] 标注转换失败（继续）：${String(e)}`);
    }
    const lambdaBc = args.lambdaBcInit * Math.pow(args.lambdaBcDecay, round);
    console.log(`[train-v2] 拟合 ${version}（λ_bc = ${lambdaBc.toFixed(3)}）…`);
    await runPython('train.py', [
      '--samples-dir',
      `../runs/samples/round-${roundTag}`,
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
    pruneOldRounds(2);
  }
  console.log('[train-v2] 达到 max-rounds，结束。');
}

main().catch((e) => {
  console.error('[train-v2] 主循环异常：', e);
  process.exit(1);
});
