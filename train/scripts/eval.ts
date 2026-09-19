// eval.ts — 验收：训练权重 argmax vs 种子权重基准（设计方案 §5 验收标准）
// 用法：npm run eval -w @dl/train [-- --weights latest|v3|seed --games 100 --simulations 300 --maps eval|train]
// 验收图池 train/eval-maps/（用户设计，泛化检验）；为空时可用 --maps train 退回训练图池。
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { applyIntent, initState } from '@dl/shared';
import type { GameState } from '@dl/shared';
import { mctsDecide } from '../lib/mcts.js';
import { SEED_TE_WEIGHTS } from '../lib/eval.js';
import type { TeWeights } from '../lib/eval.js';
import { MapPool, loadEvalMaps } from '../lib/pool.js';
import { MAPS_DIR, EVAL_MAPS_DIR, WEIGHTS_DIR, RUNS_DIR, ACCEPTANCE_FILE } from '../lib/paths.js';
import { TIME_SETTINGS, MAX_TURNS, MAX_STEPS } from '../lib/driver.js';
import { WeightStore } from '../lib/weights.js';

function get(key: string): string | undefined {
  const i = process.argv.indexOf(`--${key}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const games = Number(get('games') ?? 100);
const simulations = Number(get('simulations') ?? 300);
const weightsArg = get('weights') ?? 'latest'; // latest | v{n} | seed
const mapsArg = get('maps') ?? 'eval';

let weights: TeWeights = SEED_TE_WEIGHTS;
let weightsLabel = 'seed';
if (weightsArg !== 'seed') {
  const store = new WeightStore(WEIGHTS_DIR);
  if (weightsArg === 'latest') {
    const record = store.latest();
    if (!record) throw new Error('无权重版本文件（train/runs/weights/）——先用 seed 或先跑训练。');
    weights = record.weights;
    weightsLabel = `v${record.version}`;
  } else {
    const version = Number(weightsArg.replace(/^v/, ''));
    const file = path.join(WEIGHTS_DIR, `v${version}.json`);
    if (!existsSync(file)) throw new Error(`权重文件不存在: ${file}`);
    weights = (JSON.parse(readFileSync(file, 'utf8')) as { weights: TeWeights }).weights;
    weightsLabel = `v${version}`;
  }
}

let pool: MapPool;
let mapsSource: string;
if (mapsArg === 'train') {
  pool = new MapPool(MAPS_DIR);
  mapsSource = 'train-maps';
} else {
  const evalPool = loadEvalMaps(EVAL_MAPS_DIR);
  if (!evalPool) {
    console.error('[eval] train/eval-maps/ 为空：请放入自制验收地图（1v1 MapFullData JSON），或用 --maps train 退回训练图池。');
    process.exit(2);
  }
  pool = evalPool;
  mapsSource = 'eval-maps';
}

console.log(`[eval] ${weightsLabel} vs seed | ${games} 局 | ${mapsSource} | simulations=${simulations}`);

let wins = 0;
let draws = 0;
let losses = 0;
for (let g = 0; g < games; g++) {
  const map = pool.rotate(g);
  const trainedSeat = g % 2 === 0 ? 1 : 2; // 轮换先后手（公平）
  let state: GameState = initState({
    map,
    seatAssignments: [
      { seat: 1, playerId: 900001, isAI: false },
      { seat: 2, playerId: 900002, isAI: false },
    ],
    seed: 'eval' + g,
    timeSettings: TIME_SETTINGS,
  }).state;
  let steps = 0;
  while (!state.finished && state.turn <= MAX_TURNS && steps < MAX_STEPS) {
    const seat = state.currentSeat;
    const w = seat === trainedSeat ? weights : SEED_TE_WEIGHTS;
    const decision = mctsDecide(state, seat, w, { simulations, mode: 'argmax' });
    for (const intent of [...decision.plan.actionIntents, ...decision.plan.addPointIntents]) {
      const r = applyIntent(state, { actor: { kind: 'PLAYER', seat }, intent });
      if (!r.ok) continue;
      state = r.state;
      steps++;
      if (state.finished) break;
    }
  }
  const teamOf = (s: number) => state.forces.find((f) => f.seat === s)?.team ?? -1;
  let outcome = 0;
  if (state.finished && state.winningTeam !== null && state.winningTeam >= 0) {
    outcome = state.winningTeam === teamOf(trainedSeat) ? 1 : -1;
  }
  if (outcome === 1) wins++;
  else if (outcome === -1) losses++;
  else draws++;
  if ((g + 1) % 10 === 0) {
    console.log(`[eval] ${g + 1}/${games}: 胜${wins} 平${draws} 负${losses}`);
  }
}

const rate = wins / games;
const halfRate = (wins + 0.5 * draws) / games;
console.log('---- 验收结果 ----');
console.log(`胜 ${wins} / 平 ${draws} / 负 ${losses}`);
console.log(`胜率 = ${(rate * 100).toFixed(1)}%（半分制 ${(halfRate * 100).toFixed(1)}%）——达标线 60%`);
mkdirSync(RUNS_DIR, { recursive: true });
appendFileSync(
  ACCEPTANCE_FILE,
  `standalone,weights=${weightsLabel},maps=${mapsSource},games=${games},wins=${wins},draws=${draws},losses=${losses},rate=${rate.toFixed(3)},halfRate=${halfRate.toFixed(3)}\n`,
);
console.log(`已追加到 ${ACCEPTANCE_FILE}`);
process.exit(rate >= 0.6 ? 0 : 1);
