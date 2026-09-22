// dryrun.ts — 阶段6 空转：种子权重跑 N 局，检查意图拒绝率、局长分布、样本合理性
// 用法：npm run dryrun -w @dl/train [-- --games 10 --simulations 300]
import { playSelfPlayGame, type TrainSample } from '../lib/driver.js';
import { SEED_TE_WEIGHTS } from '../lib/eval.js';
import { MapPool } from '../lib/pool.js';
import { MAPS_DIR } from '../lib/paths.js';

function get(key: string): string | undefined {
  const i = process.argv.indexOf(`--${key}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const games = Number(get('games') ?? 10);
const simulations = Number(get('simulations') ?? 300);

const pool = new MapPool(MAPS_DIR);
const allSamples: TrainSample[] = [];
const turnList: number[] = [];
const stepList: number[] = [];
const reasonCount = new Map<string, number>();
const outcomeCount = new Map<string, number>();
let totalTime = 0;

let totalRejects = 0;
console.log(`[dryrun] 种子权重空转 ${games} 局（simulations=${simulations}，τ=1.0）`);
for (let g = 0; g < games; g++) {
  const map = pool.rotate(g);
  const t0 = Date.now();
  const result = playSelfPlayGame(map, {
    weights: SEED_TE_WEIGHTS,
    mode: 'sample',
    temperature: 1,
    simulations,
    seed: 'dry' + g,
  });
  const dt = Date.now() - t0;
  totalTime += dt;
  totalRejects += result.stats.rejects;
  allSamples.push(...result.samples);
  turnList.push(result.stats.turns);
  stepList.push(result.stats.steps);
  reasonCount.set(result.stats.reason, (reasonCount.get(result.stats.reason) ?? 0) + 1);
  const outcome = result.stats.winningTeam === null ? 'draw' : `team${result.stats.winningTeam}win`;
  outcomeCount.set(outcome, (outcomeCount.get(outcome) ?? 0) + 1);
  console.log(
    `[dryrun] 局 ${g + 1}/${games}: map=${map.id} turns=${result.stats.turns} steps=${result.stats.steps} ` +
      `rejects=${result.stats.rejects} reason=${result.stats.reason} outcome=${outcome} ${(dt / 1000).toFixed(1)}s`,
  );
}

// 样本合理性：特征分布（min/mean/max）
console.log('\n---- 空转汇总 ----');
console.log(`意图拒绝: 总计 ${totalRejects} 条 / 意图总数 ${stepList.reduce((a, b) => a + b, 0)} 条（应≈0）`);
console.log(`局长: turns avg=${avg(turnList).toFixed(1)} min=${Math.min(...turnList)} max=${Math.max(...turnList)}`);
console.log(`步数: steps avg=${avg(stepList).toFixed(1)} min=${Math.min(...stepList)} max=${Math.max(...stepList)}`);
console.log(`终局原因: ${[...reasonCount.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
console.log(`胜负分布: ${[...outcomeCount.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);
console.log(`单局平均耗时=${(totalTime / games / 1000).toFixed(1)}s；估计 100 局（单 worker）=${((totalTime / games) * 100 / 3600000).toFixed(2)}h`);

const featureNames = ['f1子力差', 'f2连兵差', 'f3脆弱性', 'f4可靠性', 'f5威胁性', 'f6叫杀'];
console.log('\n样本特征分布（应无明显异常值/全零）：');
for (let i = 0; i < 6; i++) {
  const vals = allSamples.map((s) => s.features[i]);
  console.log(`  ${featureNames[i]}: min=${min(vals).toFixed(3)} mean=${avg(vals).toFixed(3)} max=${max(vals).toFixed(3)}`);
}
console.log(`标签分布: win=${allSamples.filter((s) => s.label === 1).length} loss=${allSamples.filter((s) => s.label === -1).length} draw=${allSamples.filter((s) => s.label === 0).length}`);

function avg(v: number[]): number {
  return v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
}
function min(v: number[]): number {
  return v.reduce((a, b) => Math.min(a, b), Infinity);
}
function max(v: number[]): number {
  return v.reduce((a, b) => Math.max(a, b), -Infinity);
}
