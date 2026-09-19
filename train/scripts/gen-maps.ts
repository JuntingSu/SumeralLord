// gen-maps.ts — 一次性生成 100 张训练图池（设计方案 §7；训练前运行一次）
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateTrainMap } from '../lib/mapgen.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'maps');
const COUNT = 100;

function main(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const sizeCount = new Map<string, number>();
  for (let i = 1; i <= COUNT; i++) {
    const id = `map-${String(i).padStart(3, '0')}`;
    const { map } = generateTrainMap(id);
    writeFileSync(path.join(OUT_DIR, `${id}.json`), JSON.stringify(map));
    const key = `${map.row}x${map.column}`;
    sizeCount.set(key, (sizeCount.get(key) ?? 0) + 1);
  }
  console.log(`已生成 ${COUNT} 张训练地图 → ${OUT_DIR}`);
  console.log('尺寸分布:');
  for (const [k, v] of [...sizeCount.entries()].sort()) {
    console.log(`  ${k}: ${v} 张`);
  }
}

main();
