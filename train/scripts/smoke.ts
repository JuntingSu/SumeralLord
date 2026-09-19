// smoke.ts — 阶段4/5 冒烟：种子权重自对弈 1 局（可人工观棋：日志与线上格式一致）
// 用法：npm run smoke -w @dl/train [-- --simulations 30 --mode sample|argmax --turns 60]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { playSelfPlayGame } from '../lib/driver.js';
import { SEED_TE_WEIGHTS } from '../lib/eval.js';
import { MapPool } from '../lib/pool.js';
import { MAPS_DIR, LOGS_DIR, RUNS_DIR } from '../lib/paths.js';

function get(key: string): string | undefined {
  const i = process.argv.indexOf(`--${key}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const simulations = Number(get('simulations') ?? 30);
const mode = (get('mode') as 'argmax' | 'sample') ?? 'sample';
const maxTurns = Number(get('turns') ?? 60);

const pool = new MapPool(MAPS_DIR);
const map = pool.rotate(Math.floor(Math.random() * pool.size));
console.log(`[smoke] 地图 ${map.id}（${map.row}x${map.column}），simulations=${simulations}，mode=${mode}`);

const t0 = Date.now();
const result = playSelfPlayGame(map, {
  weights: SEED_TE_WEIGHTS,
  mode,
  temperature: 1,
  simulations,
  maxTurns,
  onTurn: (seat, state) => {
    console.log(`[smoke] turn=${state.turn} seat=${seat} steps=${state.turn}`);
  },
});
const elapsed = Date.now() - t0;

mkdirSync(LOGS_DIR, { recursive: true });
const logFile = path.join(LOGS_DIR, `smoke-${Date.now()}.jsonl`);
writeFileSync(logFile, result.log.map((l) => JSON.stringify(l)).join('\n') + '\n');

console.log('---- 冒烟结果 ----');
console.log(`结果: ${result.stats.reason}，胜方队伍=${result.stats.winningTeam ?? '平'}`);
console.log(`回合数=${result.stats.turns}，意图总数=${result.stats.steps}（seat1=${result.stats.stepsBySeat['1']}, seat2=${result.stats.stepsBySeat['2']}）`);
console.log(`样本数=${result.samples.length}，耗时=${(elapsed / 1000).toFixed(1)}s`);
console.log(`对局日志: ${logFile}`);
console.log(`人工观棋: 将日志复制到 backend/data/game_logs/<id>.jsonl 后可在回放页查看（GAME_START/INTENT_BROADCAST/GAME_OVER 与线上一致）`);
void RUNS_DIR;
