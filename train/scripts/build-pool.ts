// M4 图池构建：100 图 → m vs m 估 b（N=200, CI 过滤）→ 3× 补齐 → 池满 100 停止
// 用法：POOL_SIZE=100 GAMES=200 CONC=6 npx tsx train/scripts/build-pool.ts
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makePoolMap, saveMap, isDegenerate, passesBand, mapIdOf } from '../lib/pool.js';
import type { BRecord } from '../lib/pool.js';
import type { MapFullData } from '@dl/shared';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POOL_SIZE = parseInt(process.env.POOL_SIZE ?? '100', 10);
const GAMES = parseInt(process.env.GAMES ?? '200', 10);
const CONC = parseInt(process.env.CONC ?? '6', 10);
const B_SIMS = parseInt(process.env.B_SIMS ?? '15', 10);
const B_C = parseFloat(process.env.B_C ?? '1.5');
const B_ROUNDS = parseInt(process.env.B_ROUNDS ?? '6', 10);
const B_DIR = path.join(__dirname, '..', 'data', 'b');
const POOL_FILE = path.join(__dirname, '..', 'data', 'pool.json');

/** 估算一张图 b（子进程，隔离 CPU 并行） */
function estimateMap(map: MapFullData): Promise<BRecord> {
  return new Promise((resolve, reject) => {
    const outPath = path.join(B_DIR, `${map.id}.json`);
    if (existsSync(outPath)) {
      resolve(JSON.parse(readFileSync(outPath, 'utf8')) as BRecord);
      return;
    }
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', path.join(__dirname, 'estimate-map.ts'), map.id, String(GAMES), String(B_SIMS), String(B_C), String(B_ROUNDS)],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`estimate-map ${map.id} 退出码 ${code}: ${stderr.slice(0, 300)}`));
      try {
        resolve(JSON.parse(stdout) as BRecord);
      } catch (e) {
        reject(new Error(`estimate-map ${map.id} 输出非 JSON: ${stdout.slice(0, 300)}`));
      }
    });
  });
}

async function main(): Promise<void> {
  mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
  mkdirSync(B_DIR, { recursive: true });

  // 阶段1：初始 100 张
  const initial: MapFullData[] = [];
  for (let i = 0; i < POOL_SIZE; i++) {
    const seed = `pool-v1-${i}`;
    initial.push(makePoolMap(seed, i));
  }
  console.log(`[1] 生成初始 ${initial.length} 张`);

  // 阶段2：逐图估 b（并行 CONC）
  const t0 = Date.now();
  const records: BRecord[] = [];
  let next = 0;
  const run = async (map: MapFullData) => {
    saveMap(map);
    const r = await estimateMap(map);
    records.push(r);
    console.log(`[2] ${r.mapId} b̂=${r.bHat.toFixed(3)} ±${r.se.toFixed(3)} 终局=${r.finished}/${r.games} 截断=${r.truncated} 耗时=${((Date.now() - t0) / 1000 / 60).toFixed(1)}min`);
  };
  const workers = Array.from({ length: CONC }, async () => {
    while (next < initial.length) await run(initial[next++]);
  });
  await Promise.all(workers);

  // 阶段3：CI 过滤
  const accepted = records.filter((r) => !isDegenerate(r.bHat, r.games));
  const extreme = records.filter((r) => isDegenerate(r.bHat, r.games));
  const rejected: BRecord[] = [...extreme];
  console.log(`[3] 接受 ${accepted.length} 剔除 ${extreme.length}`);
  writeFileSync(path.join(__dirname, '..', 'data', 'extreme.json'), JSON.stringify(extreme, null, 2));
  writeFileSync(path.join(__dirname, '..', 'data', 'rejected-round1.json'), JSON.stringify(extreme, null, 2));

  // 阶段4：3× 补齐（逐图测，满足 0.2<b̂<0.8 入池；池满停止；最多 5 轮）
  let genIndex = POOL_SIZE;
  const inPool = new Set(accepted.map((r) => r.mapId));
  for (let round = 1; round <= 5 && inPool.size < POOL_SIZE; round++) {
    const need = POOL_SIZE - inPool.size;
    const supply = Math.max(1, Math.round(need * 3));
    console.log(`[4] 第${round}轮补齐：缺 ${need}，生成 ${supply} 张`);
    const candidates: MapFullData[] = [];
    for (let k = 0; k < supply; k++) {
      const seed = `pool-v1-r${round}-${genIndex++}`;
      candidates.push(makePoolMap(seed, genIndex));
    }
    next = 0;
    const roundWorkers = Array.from({ length: CONC }, async () => {
      while (next < candidates.length && inPool.size < POOL_SIZE) {
        const map = candidates[next++];
        saveMap(map);
        const r = await estimateMap(map);
        console.log(`[4] ${r.mapId} b̂=${r.bHat.toFixed(3)} ${passesBand(r.bHat) ? '入池' : '剔除'}`);
        if (passesBand(r.bHat)) {
          inPool.add(r.mapId);
          accepted.push(r);
        } else {
          rejected.push(r);
        }
      }
    });
    await Promise.all(roundWorkers);
  }

  if (inPool.size < POOL_SIZE) {
    console.error(`[!] 5 轮后池未满（${inPool.size}/${POOL_SIZE}）——生成器公平性有问题，需调整后重跑`);
    process.exitCode = 1;
  }

  const pool = accepted.filter((r) => inPool.has(r.mapId)).sort((a, b) => a.mapId.localeCompare(b.mapId));
  writeFileSync(POOL_FILE, JSON.stringify(pool, null, 2));
  writeFileSync(path.join(__dirname, '..', 'data', 'rejected.json'), JSON.stringify(rejected, null, 2));
  const bDist = pool.map((r) => r.bHat);
  const mean = bDist.reduce((a, b) => a + b, 0) / bDist.length;
  console.log(`[5] 池完成：${pool.length} 张；b̂ 均值=${mean.toFixed(3)} 范围=[${Math.min(...bDist).toFixed(3)}, ${Math.max(...bDist).toFixed(3)}] 总耗时=${((Date.now() - t0) / 1000 / 60).toFixed(1)}min`);
}

void main();
