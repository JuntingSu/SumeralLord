// scripts/acceptance.ts — 验收脚本（决策定稿 §8）
// v2 训练 AI（部署配置：200 模拟 argmax）vs v1 基准（v45 权重回合级 MCTS），验收图池（用户提供），
// 200 局、先后手交替，胜率 > 65% 达标。
// 用法：npx tsx v2/scripts/acceptance.ts [--model <onnx>] [--baseline-weights <v45.json>]
//   [--games N] [--v2-sims N] [--workers N]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MapFullData } from '@dl/shared';
import { EVAL_MAPS_DIR, RUNS_DIR, V2_ROOT, WEIGHTS_DIR } from '../lib/paths.js';
import { runWorkerJobs } from '../lib/workerpool.js';
import type { AcceptJob } from './worker.js';

export const ACCEPT_THRESHOLD = 0.65;

function get(key: string): string | undefined {
  const i = process.argv.indexOf(`--${key}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadMaps(dir: string): MapFullData[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const map = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as MapFullData;
      map.id = map.id ?? path.basename(f, '.json'); // 地图文件本身不含 id，由文件名派生
      return map;
    });
}

function defaultModel(): string {
  const poolFile = path.join(WEIGHTS_DIR, 'pool.json');
  const current = existsSync(poolFile)
    ? ((JSON.parse(readFileSync(poolFile, 'utf8')) as { current?: string }).current ?? 'v0')
    : 'v0';
  return path.join(WEIGHTS_DIR, `model-${current}.onnx`);
}

async function main(): Promise<void> {
  const games = Number(get('games') ?? '200');
  const v2Sims = Number(get('v2-sims') ?? '200');
  const workers = Number(get('workers') ?? os.cpus().length);
  const model = get('model') ?? defaultModel();
  const baseline = get('baseline-weights') ?? path.join(V2_ROOT, '..', 'v1', 'runs', 'weights', 'v45.json');

  if (!existsSync(model)) throw new Error(`v2 模型不存在：${model}`);
  if (!existsSync(baseline)) throw new Error(`基准权重不存在：${baseline}`);

  const maps = loadMaps(EVAL_MAPS_DIR);
  if (maps.length === 0) throw new Error(`验收图池为空：${EVAL_MAPS_DIR}（请放入用户提供的验收图）`);

  console.log(
    `[acceptance] v2(${path.basename(model)}, ${v2Sims} 模拟) vs 基准(${path.basename(baseline)}) ` +
      `${games} 局 × ${maps.length} 图，workers=${workers}，达标线 > ${(ACCEPT_THRESHOLD * 100).toFixed(0)}%`,
  );

  const jobs: AcceptJob[] = [];
  for (let i = 0; i < games; i++) {
    jobs.push({
      type: 'accept',
      jobId: i,
      map: maps[i % maps.length],
      modelV2: model,
      v2Seat: i % 2 === 0 ? 1 : 2, // 先后手交替（公平）
      v2Sims,
      baselineWeightsPath: baseline,
      seed: `acc-${i}`,
    });
  }

  const t0 = Date.now();
  const results = await runWorkerJobs(jobs, workers);
  let wins = 0;
  let draws = 0;
  let rejects = 0;
  const detail: string[] = ['jobId,mapId,v2Seat,outcome,steps,reason,rejects'];
  for (const r of results) {
    if (r.kind === 'accept') {
      if (r.outcome > 0) wins++;
      else if (r.outcome === 0) draws++;
      rejects += r.rejects;
      const job = jobs[r.jobId];
      detail.push(`${r.jobId},${job.map.id},${job.v2Seat},${r.outcome},${r.steps},${r.reason},${r.rejects}`);
    }
  }
  const losses = games - wins - draws;
  const winRate = wins / games;
  const pass = winRate > ACCEPT_THRESHOLD;
  const mins = ((Date.now() - t0) / 60000).toFixed(1);

  console.log(
    `[acceptance] 结果：${wins} 胜 / ${draws} 平 / ${losses} 负，胜率 ${(winRate * 100).toFixed(1)}%，` +
      `耗时 ${mins} min，意图拒绝 ${rejects} → ${pass ? '✅ 达标' : '❌ 未达标'}`,
  );

  // 报告落盘
  mkdirSync(RUNS_DIR, { recursive: true });
  const csv = `timestamp,model,baseline,games,wins,draws,losses,winrate,pass\n${new Date().toISOString()},${path.basename(model)},${path.basename(baseline)},${games},${wins},${draws},${losses},${winRate.toFixed(4)},${pass ? 1 : 0}\n`;
  writeFileSync(path.join(RUNS_DIR, 'acceptance.csv'), csv, { flag: 'a' });
  writeFileSync(path.join(RUNS_DIR, `acceptance-games-${Date.now()}.csv`), detail.join('\n') + '\n');

  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('[acceptance] 失败：', e);
  process.exit(1);
});
