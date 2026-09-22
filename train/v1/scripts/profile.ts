// profile.ts — 阶段6 性能 profile：候选生成 / E_te / 规则3 探测 的耗时分解
// 用法：npm run profile -w @dl/train [-- --turns 20 --simulations 300]
import { initState } from '@dl/shared';
import type { GameState } from '@dl/shared';
import { playSelfPlayGame } from '../lib/driver.js';
import { SEED_TE_WEIGHTS } from '../lib/eval.js';
import { evalTe } from '../lib/eval.js';
import { planTurnCandidates } from '../lib/turnplan.js';
import { planAddPoints } from '../lib/addpoint.js';
import { teFeatures } from '../lib/features.js';
import { MapPool } from '../lib/pool.js';
import { MAPS_DIR } from '../lib/paths.js';

function get(key: string): string | undefined {
  const i = process.argv.indexOf(`--${key}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const warmTurns = Number(get('turns') ?? 12);
const simulations = Number(get('simulations') ?? 300);

// ---- 1) 生成一个中盘局面（低预算快跑 warmTurns 回合） ----
console.log(`[profile] 用 ${warmTurns} 回合低预算对局生成中盘局面...`);
const pool = new MapPool(MAPS_DIR);
const map = pool.rotate(0);
let state: GameState = initState({
  map,
  seatAssignments: [
    { seat: 1, playerId: 900001, isAI: false },
    { seat: 2, playerId: 900002, isAI: false },
  ],
  seed: 'profile',
  timeSettings: { stepTime: 30, gameTime: 600, additionalTime: 10 },
}).state;
{
  const result = playSelfPlayGame(map, {
    weights: SEED_TE_WEIGHTS,
    mode: 'sample',
    temperature: 1,
    simulations: 8,
    maxTurns: warmTurns,
    seed: 'profile',
    onTurn: (_seat, s) => {
      state = s;
    },
  });
  state = result.finalState;
}
console.log(`[profile] 中盘局面：turn=${state.turn}，我方连兵=${state.tiles.filter((t) => t.soldier?.owner === 1 && t.soldier.isLinked).length}`);

// ---- 2) 分项计时 ----
const bench = (name: string, fn: () => void, times: number): number => {
  const t0 = performance.now();
  for (let i = 0; i < times; i++) fn();
  const per = (performance.now() - t0) / times;
  console.log(`  ${name}: ${per.toFixed(2)} ms/次 ×${times}`);
  return per;
};

console.log('\n分项基准（中盘局面，seat=1）：');
const tPlan = bench('planTurnCandidates（行动搜索+加点，4 候选）', () => {
  planTurnCandidates(state, 1, SEED_TE_WEIGHTS);
}, 3);

const tAdd = bench('planAddPoints（单独）', () => {
  planAddPoints(state, state, 1, SEED_TE_WEIGHTS);
}, 5);

const tEte = bench('evalTe（单次叶评估）', () => {
  evalTe(state, state, 1, SEED_TE_WEIGHTS);
}, 20);

const tFeat = bench('teFeatures（特征计算）', () => {
  teFeatures(state, state, 1);
}, 20);

// ---- 3) 每决策成本外推（300 模拟） ----
console.log('\n每决策成本外推（300 模拟、树 ≤21 次候选生成 + ≤64 次叶评估）：');
const genCost = (tPlan + tAdd) * 21;
const leafCost = tEte * 64;
console.log(`  候选生成 ≈ ${(genCost / 1000).toFixed(2)} s + 叶评估 ≈ ${(leafCost / 1000).toFixed(2)} s ≈ ${((genCost + leafCost) / 1000).toFixed(2)} s/决策（上界）`);
console.log(`  一局（120 决策）≈ ${(((genCost + leafCost) * 120) / 60000).toFixed(1)} 分钟（上界）`);

console.log('\n预案判断：');
if (tEte > 5) {
  console.log('  evalTe 较慢：规则3 探测（每节点 |连兵| 次 E_te）为主要瓶颈 → 建议实现轻量 E_te（去特征3/4）用于规则3 排序。');
} else {
  console.log('  evalTe 可接受：暂不实现轻量 E_te（按文档：profile 实测后再决策）。');
}
if (tPlan > 1000) {
  console.log('  行动搜索较慢：检查原点/链枚举上限（maxChainsPerOrigin/maxLeaves/maxApplies）与补刀 BFS 预算。');
} else {
  console.log('  行动搜索可接受。');
}
