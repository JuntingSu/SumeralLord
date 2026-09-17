// 均衡随机地图生成器（1v1）
// 移植自 mapeditor/js/generator.js 的 plain（随机地图-均衡）模式：
//   权重 [0.58 平原, 0.02 据点, 0.16 海洋, 0.24 山地, 0 虚空]，全连通约束，随机出生点。
// 差异（训练需求）：
//   1. 种子化 PRNG（零 Math.random，同 seed 同图）；
//   2. 公平性约束：双方出生点距离下限、出生点周围可走地形数量下限；
//   3. 每方据点数参数（1 或 2，双方相等）——让叶评估的 c·据点数 项在训练中生效。
import type { MapFullData, BattlefieldTile } from '@dl/shared';
import { hexDistance } from '@dl/shared';
import { createRng, pick, shuffle, randInt } from './rng.js';

export const TERRAIN = { PLAIN: 0, CITY: 1, OCEAN: 3, MOUNTAIN: 4, VOID: 5 } as const;
export const OWNER_EMPTY = 128;

/** plain（均衡）权重表，索引序 = CODE_ORDER：平原/据点/海洋/山地/虚空 */
const WEIGHTS_PLAIN = [0.58, 0.02, 0.16, 0.24, 0];
const CODE_ORDER = [TERRAIN.PLAIN, TERRAIN.CITY, TERRAIN.OCEAN, TERRAIN.MOUNTAIN, TERRAIN.VOID];
/** 可连通地形：全断（山地/虚空）除外；海洋半断可通行，计入 */
const WALKABLE = new Set<number>([TERRAIN.PLAIN, TERRAIN.CITY, TERRAIN.OCEAN]);

/** even-r 邻居表（对齐 coord.ts：偶数行右移半格） */
const NEIGHBORS = [
  [[1, 0], [-1, 0], [0, -1], [-1, -1], [0, 1], [-1, 1]],
  [[1, 0], [-1, 0], [1, -1], [0, -1], [1, 1], [0, 1]],
];

function neighborsOf(idx: number, rows: number, columns: number): number[] {
  const r = Math.floor(idx / columns);
  const c = idx % columns;
  const out: number[] = [];
  for (const [dc, dr] of NEIGHBORS[r % 2]) {
    const nr = r + dr;
    const nc = c + dc;
    if (nr >= 0 && nr < rows && nc >= 0 && nc < columns) out.push(nr * columns + nc);
  }
  return out;
}

/** 所有可走格是否全连通（BFS） */
function isConnected(terrain: number[], rows: number, columns: number): boolean {
  let start = -1;
  for (let i = 0; i < terrain.length; i++) {
    if (WALKABLE.has(terrain[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return false;
  const visited = new Uint8Array(terrain.length);
  const stack = [start];
  visited[start] = 1;
  while (stack.length) {
    const idx = stack.pop()!;
    for (const n of neighborsOf(idx, rows, columns)) {
      if (!visited[n] && WALKABLE.has(terrain[n])) {
        visited[n] = 1;
        stack.push(n);
      }
    }
  }
  for (let i = 0; i < terrain.length; i++) {
    if (WALKABLE.has(terrain[i]) && !visited[i]) return false;
  }
  return true;
}

function weightedChoice(rng: () => number, weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = (rng() % 100000) / 100000 * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}

/** 距 idx 曼哈顿半径 ≤ radius 的可走格数（出生点平衡度量） */
function walkableAround(terrain: number[], idx: number, rows: number, columns: number, radius: number): number {
  let count = 0;
  const visited = new Set<number>([idx]);
  const queue: Array<[number, number]> = [[idx, 0]];
  while (queue.length) {
    const [cur, d] = queue.shift()!;
    if (d > 0 && WALKABLE.has(terrain[cur])) count++;
    if (d >= radius) continue;
    for (const n of neighborsOf(cur, rows, columns)) {
      if (!visited.has(n)) {
        visited.add(n);
        queue.push([n, d + 1]);
      }
    }
  }
  return count;
}

export interface GenOptions {
  seed: string;
  rows: number;
  columns: number;
  /** 每方据点数（1 或 2，双方相等；默认 1） */
  strongholdsPerSide?: 1 | 2;
  /** 双方出生点中心最小距离（默认 6） */
  minSpawnDistance?: number;
  /** 出生点周围(距离≤2)可走格数下限（默认 6，防出生点被山地/海洋围死） */
  minSpawnSurrounding?: number;
  /** 据点初始兵力（默认 5，与 mapeditor 生成器一致） */
  strongholdStrength?: number;
}

/** 生成一张均衡随机 1v1 图（确定性：同 seed 同图） */
export function generateBalancedMap(opts: GenOptions): MapFullData {
  const rows = opts.rows;
  const columns = opts.columns;
  const strongholdsPerSide = opts.strongholdsPerSide ?? 1;
  const minSpawnDistance = opts.minSpawnDistance ?? 6;
  const minSpawnSurrounding = opts.minSpawnSurrounding ?? 6;
  const strength = opts.strongholdStrength ?? 5;
  const size = rows * columns;
  const geo = { rows, columns, cylindrical: false };

  // 地形：加权随机 + 全连通（最多 500 次尝试）
  let terrain: number[] = [];
  for (let attempt = 0; attempt < 500; attempt++) {
    const rng = createRng(`${opts.seed}:terrain:${attempt}`);
    terrain = Array.from({ length: size }, () => CODE_ORDER[weightedChoice(rng, WEIGHTS_PLAIN)]);
    if (isConnected(terrain, rows, columns)) break;
  }

  // 出生点中心：两个势力各选一个可走格，满足距离与周围平衡约束
  const walkable: number[] = [];
  for (let i = 0; i < size; i++) if (WALKABLE.has(terrain[i])) walkable.push(i);

  let spawns: [number, number] | null = null;
  for (let attempt = 0; attempt < 200 && !spawns; attempt++) {
    const rng = createRng(`${opts.seed}:spawn:${attempt}`);
    const candidates = shuffle(rng, walkable).filter((i) => walkableAround(terrain, i, rows, columns, 2) >= minSpawnSurrounding);
    if (candidates.length < 2) continue;
    const c1 = candidates[0];
    // 与 c1 距离达标的候选
    const far = candidates.filter((i) => hexDistance(c1, i, geo) >= minSpawnDistance);
    if (far.length === 0) continue;
    const c2 = far[randInt(rng, far.length)];
    spawns = [c1, c2];
  }
  if (!spawns) throw new Error(`生成失败：无法满足出生点约束（seed=${opts.seed} ${rows}x${columns}）`);

  // 据点簇：中心 + 额外据点（距离≤2 的可走格，双方簇自动不重叠）
  const clusters: number[][] = [[], []];
  for (let side = 0; side < 2; side++) {
    const rng = createRng(`${opts.seed}:cluster:${side}`);
    const center = spawns[side];
    const cluster = [center];
    if (strongholdsPerSide === 2) {
      const near: number[] = [];
      const visited = new Set<number>([center]);
      const queue: Array<[number, number]> = [[center, 0]];
      while (queue.length) {
        const [cur, d] = queue.shift()!;
        if (d >= 2) continue;
        for (const n of neighborsOf(cur, rows, columns)) {
          if (!visited.has(n)) {
            visited.add(n);
            if (WALKABLE.has(terrain[n])) near.push(n);
            queue.push([n, d + 1]);
          }
        }
      }
      const others = new Set(clusters.flat());
      // 跨队据点间距约束：额外据点距对方中心 ≥ minSpawnDistance（簇内半径 2 → 跨队据点 ≥ 4）
      const minCross = minSpawnDistance;
      const free = near.filter((i) => !others.has(i) && hexDistance(i, spawns[1 - side], geo) >= minCross);
      if (free.length === 0) {
        // 兜底：放宽到任意可走格（仍避开对方簇）
        cluster.push(pick(rng, walkable.filter((i) => !others.has(i) && hexDistance(i, spawns[1 - side], geo) >= minCross)));
      } else {
        cluster.push(pick(rng, free));
      }
    }
    clusters[side] = cluster;
  }

  // 落盘 MapFullData
  const battlefield: BattlefieldTile[] = terrain.map((t) => [t, OWNER_EMPTY, 0]);
  for (let side = 0; side < 2; side++) {
    for (const idx of clusters[side]) {
      battlefield[idx] = [TERRAIN.CITY, side + 1, strength];
    }
  }
  const map: MapFullData = {
    id: `gen_${opts.seed}`,
    version: 1,
    title: '随机地图-均衡',
    description: `训练用均衡随机图 ${rows}x${columns}（${strongholdsPerSide} 据点/方）`,
    author: 'ai-train',
    timestamp: '2026-09-17 00:00:00.0',
    row: rows,
    column: columns,
    random_spawn: false,
    cylindrical_map: false,
    fog_mode: false,
    online_time_settings: { total_time: 600, round_time: 60, time_bonus: 0 },
    tags: ['1v1', '训练'],
    player_num: 2,
    player_list: [
      { name: '红方', team: 1, computer: 1, seat: 1, flag: 1 },
      { name: '蓝方', team: 2, computer: 1, seat: 2, flag: 2 },
    ],
    battlefield,
  };
  return map;
}

/** 1v1 训练用尺寸池（行×列） */
export const TRAIN_SIZES: Array<[number, number]> = [
  [7, 10],
  [8, 9],
  [8, 11],
  [9, 9],
  [9, 10],
  [9, 12],
];

/** 从尺寸池均匀采样一张图 */
export function generateTrainMap(seed: string, sizes: Array<[number, number]> = TRAIN_SIZES, strongholdsPerSide: 1 | 2 = 1): MapFullData {
  const rng = createRng(seed);
  const [rows, columns] = sizes[randInt(rng, sizes.length)];
  return generateBalancedMap({
    seed,
    rows,
    columns,
    strongholdsPerSide,
  });
}
