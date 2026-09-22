// gen-maps.ts — 生成训练图池（设计方案 §7；2026-09-20：敌我据点须经平原/据点连通，不满足则重新生成）
// 用法：npm run gen-maps -w @dl/train [-- --count 100]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateTrainMap } from '../lib/mapgen.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'maps');
const countArg = process.argv.indexOf('--count');
const COUNT = Number(countArg >= 0 ? process.argv[countArg + 1] : undefined) || 100;

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const sizeCount = new Map<string, number>();
  let attempts = 0;
  for (let i = 1; i <= COUNT; i++) {
    const id = `map-${String(i).padStart(3, '0')}`;
    // generateTrainMap 内部对"敌我据点经平原/据点连通"失败自动重生成
    const { map } = generateTrainMap(id);
    attempts += 1;
    writeFileSync(path.join(OUT_DIR, `${id}.json`), JSON.stringify(map));
    const key = `${map.row}x${map.column}`;
    sizeCount.set(key, (sizeCount.get(key) ?? 0) + 1);
  }
  console.log(`已生成 ${COUNT} 张训练地图 → ${OUT_DIR}（敌我据点经平原/据点连通）`);
  console.log('尺寸分布:');
  for (const [k, v] of [...sizeCount.entries()].sort()) {
    console.log(`  ${k}: ${v} 张`);
  }
}

main();
