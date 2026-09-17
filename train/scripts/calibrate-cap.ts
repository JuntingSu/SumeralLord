// M5 回合上限标定：读 pool.json 的 b 估计记录（含终局回合分布与截断率），
// 输出建议 c_cap：cap(M) = c_cap × 地块数，使池内截断率 < 10%
// 用法：npx tsx train/scripts/calibrate-cap.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BRecord } from '../lib/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pool: BRecord[] = JSON.parse(readFileSync(path.join(__dirname, '..', 'data', 'pool.json'), 'utf8'));

const TARGET_TRUNCATION = 0.1;

const totalGames = pool.reduce((a, r) => a + r.games, 0);
const totalTrunc = pool.reduce((a, r) => a + r.truncated, 0);
const truncRate = totalTrunc / totalGames;
console.log(`池 ${pool.length} 图，总对局 ${totalGames}，截断 ${totalTrunc}（${(truncRate * 100).toFixed(1)}%）`);

// 终局回合 vs 地块数的关系（每张图的中位/P90 终局回合）
const points: Array<{ tiles: number; median: number; p90: number }> = pool
  .filter((r) => r.resolvedMedianTurns !== null)
  .map((r) => ({ tiles: r.rows * r.columns, median: r.resolvedMedianTurns!, p90: r.resolvedP90Turns ?? r.resolvedMedianTurns! }));

if (points.length === 0) {
  console.log('无终局样本（截断率过高，需先降低回合上限或检查 m 配置）');
  process.exit(1);
}

const medians = points.map((p) => p.median);
const p90s = points.map((p) => p.p90);
medians.sort((a, b) => a - b);
p90s.sort((a, b) => a - b);
const gMedian = medians[Math.floor(medians.length / 2)];
const gP90 = p90s[Math.floor(p90s.length * 0.9)];
console.log(`终局回合：中位=${gMedian} p90=${gP90}`);

// 线性拟合：turns ≈ slope × tiles（过原点）
const sumXY = points.reduce((a, p) => a + p.tiles * p.p90, 0);
const sumXX = points.reduce((a, p) => a + p.tiles * p.tiles, 0);
const slope = sumXY / sumXX;
console.log(`p90 回合 ~ ${slope.toFixed(2)} × 地块数`);

// 建议 c_cap：覆盖 p90 且留余量（截断率目标 <10%）
const suggested = Math.ceil(slope * 1.5 * 10) / 10;
console.log(`建议 c_cap = ${suggested}（cap(M) = ${suggested} × 地块数）`);
console.log(`当前池实际截断率 ${(truncRate * 100).toFixed(1)}% ${truncRate < TARGET_TRUNCATION ? '（达标）' : '（超标，需按建议上调）'}`);
