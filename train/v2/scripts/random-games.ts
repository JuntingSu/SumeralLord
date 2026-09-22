// scripts/random-games.ts — 阶段 0 冒烟：随机策略在训练图池上跑 N 局，落盘日志与样本
// 用法：npx tsx v2/scripts/random-games.ts [局数，缺省 5]
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { MapFullData } from '@dl/shared';
import { playGame, randomPolicy } from '../lib/driver.js';
import { writeGameLog, writeSamples } from '../lib/sampleio.js';
import { LOGS_DIR, MAPS_DIR, SAMPLES_DIR } from '../lib/paths.js';

const N = Number(process.argv[2] ?? '5');
const mapFiles = readdirSync(MAPS_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort();
if (mapFiles.length === 0) {
  console.error(`训练图池为空：${MAPS_DIR}`);
  process.exit(1);
}
const maps: MapFullData[] = mapFiles.map((f) => JSON.parse(readFileSync(path.join(MAPS_DIR, f), 'utf8')));

let totalSamples = 0;
let totalSteps = 0;
let rejects = 0;
const reasons: Record<string, number> = {};
async function main() {
for (let i = 0; i < N; i++) {
  const map = maps[i % maps.length];
  const r = await playGame(map, { policy: randomPolicy(), seed: `smoke-${i}` });
  writeGameLog(LOGS_DIR, r.stats.gameId, r.log);
  writeSamples(SAMPLES_DIR, r.stats.gameId, r.samples);
  totalSamples += r.samples.length;
  totalSteps += r.stats.steps;
  rejects += r.stats.rejects;
  reasons[r.stats.reason] = (reasons[r.stats.reason] ?? 0) + 1;
  console.log(`#${i + 1} map=${map.id} ${r.stats.reason} turns=${r.stats.turns} steps=${r.stats.steps} samples=${r.samples.length}`);
}

console.log('---');
console.log(`局数 ${N}，原因分布 ${JSON.stringify(reasons)}，总步数 ${totalSteps}，总样本 ${totalSamples}，拒绝 ${rejects}`);
console.log(`日志目录 ${LOGS_DIR}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
console.log(`样本目录 ${SAMPLES_DIR}`);
