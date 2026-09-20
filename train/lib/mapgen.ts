// mapgen.ts — 训练图池生成器（设计方案 §7）
// 移植 mapeditor/js/generator.js 的 mode='plain' 随机生成器：均衡权重、可走格连通重试。
// 训练约定：row∈[9,15]、column∈[11,17] 每张随机；playerNum=2；不种子化（Math.random）；
// 生成后先手（seat1）据点兵力 3、后手（seat2）据点兵力 4（后手补偿）。
import {
  TERRAIN,
  TILE_OWNER,
  neighborsOf,
  type BattlefieldTile,
  type BoardGeometry,
  type MapFullData,
  type MapPlayer,
} from '@dl/shared';

/** mode='plain' 地形权重：[0平原, 1据点, 3海洋, 4山地, 5虚空] */
const WEIGHTS_PLAIN = [0.58, 0.02, 0.16, 0.24, 0];
const CODE_ORDER = [TERRAIN.PLAIN, TERRAIN.CITY, TERRAIN.OCEAN, TERRAIN.MOUNTAIN, TERRAIN.VOID];
const WALKABLE: Set<number> = new Set([TERRAIN.PLAIN, TERRAIN.CITY, TERRAIN.OCEAN]);

/** 先手（seat1）据点兵力（后手补偿） */
export const FIRST_SEAT_STRENGTH = 3;
/** 后手（seat2）据点兵力（后手补偿） */
export const SECOND_SEAT_STRENGTH = 4;

function weightedChoice(weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function geoOf(row: number, column: number): BoardGeometry {
  return { rows: row, columns: column, cylindrical: false };
}

/** 所有可走格（平原/据点/海洋）是否全连通（BFS，对齐 generator.js） */
export function walkableConnected(battlefield: BattlefieldTile[], row: number, column: number): boolean {
  const geo = geoOf(row, column);
  let start = -1;
  for (let i = 0; i < battlefield.length; i++) {
    if (WALKABLE.has(battlefield[i][0])) {
      start = i;
      break;
    }
  }
  if (start < 0) return false;
  const visited = new Uint8Array(battlefield.length);
  const stack = [start];
  visited[start] = 1;
  while (stack.length) {
    const idx = stack.pop()!;
    for (const n of neighborsOf(idx, geo)) {
      if (!visited[n] && WALKABLE.has(battlefield[n][0])) {
        visited[n] = 1;
        stack.push(n);
      }
    }
  }
  for (let i = 0; i < battlefield.length; i++) {
    if (WALKABLE.has(battlefield[i][0]) && !visited[i]) return false;
  }
  return true;
}

/** "YYYY-MM-DD HH:mm:ss.fffffff"（对齐 mapeditor nowTimestamp 的 7 位小数秒格式） */
function nowTimestamp(): string {
  const d = new Date();
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}0000`;
}

export interface TrainMap {
  id: string;
  map: MapFullData;
}

/**
 * 敌我初始据点必须能通过平原/据点连通（2026-09-20 新增检查）：
 * 两座有主据点之间存在一条仅经 PLAIN/CITY 地形的路径（海洋不参与连通）。
 */
export function strongholdsLandConnected(battlefield: BattlefieldTile[], row: number, column: number): boolean {
  const geo = geoOf(row, column);
  const cities: number[] = [];
  for (let i = 0; i < battlefield.length; i++) {
    const [terrain, owner] = battlefield[i];
    if (terrain === TERRAIN.CITY && (owner === 1 || owner === 2)) cities.push(i);
  }
  if (cities.length !== 2) return false;
  const [a, b] = cities;
  const land = (t: number): boolean => t === TERRAIN.PLAIN || t === TERRAIN.CITY;
  const visited = new Uint8Array(battlefield.length);
  const queue = [a];
  visited[a] = 1;
  while (queue.length > 0) {
    const cur = queue.pop()!;
    if (cur === b) return true;
    for (const nb of neighborsOf(cur, geo)) {
      if (!visited[nb] && land(battlefield[nb][0])) {
        visited[nb] = 1;
        queue.push(nb);
      }
    }
  }
  return false;
}

/** 单张生成尝试：地形（可走格连通重试）+ 随机出生点 */
function generateOnce(id: string): MapFullData {
  const row = 9 + Math.floor(Math.random() * 7); // [9,15]
  const column = 11 + Math.floor(Math.random() * 7); // [11,17]
  const size = row * column;
  const geo = geoOf(row, column);

  let terrain: number[] = [];
  for (let attempt = 0; attempt < 500; attempt++) {
    terrain = Array.from({ length: size }, () => CODE_ORDER[weightedChoice(WEIGHTS_PLAIN)]);
    const trial: BattlefieldTile[] = terrain.map((t) => [t, TILE_OWNER.EMPTY, 0]);
    if (walkableConnected(trial, row, column)) break;
  }

  const battlefield: BattlefieldTile[] = terrain.map((t) => [t, TILE_OWNER.EMPTY, 0]);

  // 从可走格随机取两处出生点（mapeditor 语义：shuffle 后取前 playerNum 个，不足则补随机）
  const candidates: number[] = [];
  for (let i = 0; i < size; i++) if (WALKABLE.has(terrain[i])) candidates.push(i);
  shuffle(candidates);
  const picked = candidates.slice(0, 2);
  const used = new Set(picked);
  let extra = 2 - picked.length;
  while (extra > 0) {
    const idx = Math.floor(Math.random() * size);
    if (!used.has(idx)) {
      picked.push(idx);
      used.add(idx);
      extra--;
    }
  }
  battlefield[picked[0]] = [TERRAIN.CITY, 1, FIRST_SEAT_STRENGTH];
  battlefield[picked[1]] = [TERRAIN.CITY, 2, SECOND_SEAT_STRENGTH];

  const playerList: MapPlayer[] = [
    { name: '训练势力1', team: 1, computer: 2, seat: 1, flag: 1 },
    { name: '训练势力2', team: 2, computer: 2, seat: 2, flag: 2 },
  ];

  return {
    id,
    version: 1,
    title: `训练地图-${id}`,
    description: 'MCTS 自训练图池（mode=plain，先手据点3/后手据点4，敌我据点经平原/据点连通）',
    author: 'train',
    timestamp: nowTimestamp(),
    row,
    column,
    random_spawn: false,
    cylindrical_map: false,
    fog_mode: false,
    online_time_settings: { total_time: 600, round_time: 60, time_bonus: 0 },
    tags: ['train'],
    player_num: 2,
    player_list: playerList,
    battlefield,
  };
}

/** 生成单张训练图的重试上限（强连通校验失败时重新生成） */
const MAX_GEN_ATTEMPTS = 300;

/**
 * 生成一张 1v1 训练地图（不种子化）：
 * mode='plain' 均衡权重 + 可走格连通校验 + 敌我初始据点经平原/据点连通校验（不满足则重生成）。
 */
export function generateTrainMap(id: string): TrainMap {
  for (let attempt = 0; attempt < MAX_GEN_ATTEMPTS; attempt++) {
    const map = generateOnce(id);
    if (strongholdsLandConnected(map.battlefield, map.row, map.column)) return { id, map };
  }
  throw new Error(`无法生成满足"敌我据点经平原/据点连通"的训练地图: ${id}（已重试 ${MAX_GEN_ATTEMPTS} 次）`);
}
