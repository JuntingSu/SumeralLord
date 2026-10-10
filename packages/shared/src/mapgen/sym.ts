// mapgen/sym.ts — 对称地图生成器（中心对称 / 轴对称），以及「随机 1v1 对称地图」便捷封装。
//
// 迁移自 train/mapgen-sym/lib/mapgen-sym.ts（feat/ai-mcts-training 分支；算法与权重保持一致），
// 移入 @dl/shared 以便游戏服务器与训练工具共用同一份实现（单一事实来源）。
//
// 生成规则：
//   0) 对称方案二选一：center=中心对称（180° 旋转）/ axis=轴对称（左右镜像）
//   1) 地形权重：平原0.68 据点0.02 海洋0.2 山地0.05 虚空0.05；只对"有对称映像"的格随机采样，
//      采样值同步到其对称格，保证全图地形对称
//   2) 长宽均为奇数（row∈{9,11,13}、column∈{9,11,13,15,17}）；奇数行最右格
//      （index = 2n*column-1，n=1..(row-1)/2）在 odd-r 错排下无对称映像，恒为虚空、不参与对称
//   3) 若图中不存在互为对称的据点对（无据点 / 据点仅落在轴心固定格），随机补一对对称据点
//   4) 随机取一对对称据点：先手 seat1 兵力3、后手 seat2 兵力4（pair 内朝向随机，消除方位偏差）
//   5) 校验：两出生据点必须能经 可接/全接 地形（平原/据点）连通，且 BFS 最短路径距离 ≥ 4，
//      不满足则整体重新生成（重试上限 300 次）
import { TERRAIN, TILE_OWNER, type BattlefieldTile, type MapFullData, type MapPlayer } from '../types.js';
import { neighborsOf, type BoardGeometry } from '../game/coord.js';

/** 对称方案：center=中心对称（180° 旋转），axis=轴对称（左右镜像） */
export type SymmetryMode = 'center' | 'axis';

/** 先手（seat1）据点兵力（后手补偿，与 v1 图池约定一致） */
const FIRST_SEAT_STRENGTH = 3;
/** 后手（seat2）据点兵力（后手补偿） */
const SECOND_SEAT_STRENGTH = 4;

/** 地形权重 [0平原, 1据点, 3海洋, 4山地, 5虚空]，总和 1.0 */
const WEIGHTS_SYM = [0.68, 0.02, 0.2, 0.05, 0.05];
const CODE_ORDER = [TERRAIN.PLAIN, TERRAIN.CITY, TERRAIN.OCEAN, TERRAIN.MOUNTAIN, TERRAIN.VOID];

/** 可接/全接地形（连通性 NORMAL/FULL_LINK）：平原、据点（海洋为半断、山地/虚空为全断，不计入） */
const LINKABLE = new Set<number>([TERRAIN.PLAIN, TERRAIN.CITY]);

/** 两出生据点允许的最短路径距离下限（距离 < 4 重新生成） */
export const MIN_SPAWN_DISTANCE = 4;

/** 支持的奇数行数（长）范围 */
export const SYM_ROW_RANGE = { min: 9, max: 13 } as const;
/** 支持的奇数列数（宽）范围 */
export const SYM_COLUMN_RANGE = { min: 9, max: 17 } as const;

/** 单张生成重试上限 */
const MAX_GEN_ATTEMPTS = 300;

const SYMMETRY_LABEL: Record<SymmetryMode, string> = {
  center: '中心对称',
  axis: '轴对称',
};

/** 随机 1v1 模式固定两个势力：先手 seat1 / 后手 seat2（房间势力与生成地图 player_list 同源） */
export const SYM_1V1_FORCES: ReadonlyArray<{ seat: number; team: number; name: string; flag: number }> = [
  { seat: 1, team: 1, name: '先手', flag: 1 },
  { seat: 2, team: 2, name: '后手', flag: 2 },
];

export interface SymMapOptions {
  /** 行数（长），奇数，9..13 */
  row: number;
  /** 列数（宽），奇数，9..17 */
  column: number;
  /** 对称方案 */
  symmetry: SymmetryMode;
  /** 地图 id（缺省 'sym-map'） */
  id?: string;
}

export interface SymMapResult {
  id: string;
  symmetry: SymmetryMode;
  map: MapFullData;
  /** 两出生据点经平原/据点的 BFS 最短路径距离 */
  spawnDistance: number;
}

/** "YYYY-MM-DD HH:mm:ss.f" 格式（与既有地图 timestamp 形式一致） */
function nowTimestamp(): string {
  const d = new Date();
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function geoOf(row: number, column: number): BoardGeometry {
  return { rows: row, columns: column, cylindrical: false };
}

/**
 * 格 index 的对称映像（-1 = 无映像）。
 * odd-r 错排（奇数行右移半格）下，奇数行最右格（index=2n*column-1）无对称映像。
 * center（180° 旋转）：偶数行 (r,c)→(R-1-r, C-1-c)，奇数行 (r,c)→(R-1-r, C-2-c)
 * axis（左右镜像）：  偶数行 (r,c)→(r, C-1-c)，奇数行 (r,c)→(r, C-2-c)
 * 两个映射均为对合（二次应用回到自身）。
 */
export function symmetryImageOf(index: number, row: number, column: number, symmetry: SymmetryMode): number {
  const r = Math.floor(index / column);
  const c = index % column;
  if (r % 2 === 1 && c === column - 1) return -1; // 奇数行最右格：虚空格，无对称映像
  const rr = symmetry === 'center' ? row - 1 - r : r;
  const cc = r % 2 === 0 ? column - 1 - c : column - 2 - c;
  return rr * column + cc;
}

/** 恒为虚空的奇数行最右格：index = 2n*column - 1（n = 1..(row-1)/2） */
export function voidIndexes(row: number, column: number): number[] {
  const out: number[] = [];
  for (let n = 1; n <= (row - 1) / 2; n++) out.push(2 * n * column - 1);
  return out;
}

/** 尺寸校验：长宽必须为奇数且在支持范围内 */
export function validateSymMapOptions(row: number, column: number, symmetry: SymmetryMode): void {
  if (row % 2 === 0 || column % 2 === 0) {
    throw new Error(`对称地图要求长宽均为奇数，收到 row=${row} column=${column}`);
  }
  if (
    row < SYM_ROW_RANGE.min ||
    row > SYM_ROW_RANGE.max ||
    column < SYM_COLUMN_RANGE.min ||
    column > SYM_COLUMN_RANGE.max
  ) {
    throw new Error(
      `地图尺寸超出支持范围：row(长)∈[${SYM_ROW_RANGE.min},${SYM_ROW_RANGE.max}] 奇数、column(宽)∈[${SYM_COLUMN_RANGE.min},${SYM_COLUMN_RANGE.max}] 奇数，收到 ${row}x${column}`,
    );
  }
  if (symmetry !== 'center' && symmetry !== 'axis') {
    throw new Error(`对称方案必须是 center（中心对称）或 axis（轴对称），收到 "${symmetry}"`);
  }
}

function weightedChoice(weights: number[]): number {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r < 0) return i;
  }
  return weights.length - 1;
}

/** 图中互为对称映像的据点对（[a, b]，去重） */
export function strongholdSymPairs(
  battlefield: BattlefieldTile[],
  row: number,
  column: number,
  symmetry: SymmetryMode,
): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  const seen = new Set<number>();
  for (let i = 0; i < battlefield.length; i++) {
    if (battlefield[i][0] !== TERRAIN.CITY) continue;
    const img = symmetryImageOf(i, row, column, symmetry);
    if (img < 0 || img === i || battlefield[img][0] !== TERRAIN.CITY) continue;
    const key = Math.min(i, img) * battlefield.length + Math.max(i, img);
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([i, img]);
  }
  return pairs;
}

/** 随机补一对对称据点：取非虚空、非轴心固定格及其对称映像（两格可能原本已是据点，覆盖无害） */
function placeRandomSymPair(battlefield: BattlefieldTile[], row: number, column: number, symmetry: SymmetryMode): void {
  const candidates: number[] = [];
  for (let i = 0; i < battlefield.length; i++) {
    const img = symmetryImageOf(i, row, column, symmetry);
    if (img >= 0 && img !== i) candidates.push(i);
  }
  if (candidates.length === 0) {
    throw new Error('对称地图无可放置据点的非固定格');
  }
  const i = candidates[Math.floor(Math.random() * candidates.length)];
  const img = symmetryImageOf(i, row, column, symmetry);
  battlefield[i] = [TERRAIN.CITY, TILE_OWNER.EMPTY, 0];
  battlefield[img] = [TERRAIN.CITY, TILE_OWNER.EMPTY, 0];
}

/** 两格经可接/全接地形（平原/据点）的 BFS 最短距离；不可达返回 -1 */
export function linkableDistance(
  battlefield: BattlefieldTile[],
  a: number,
  b: number,
  row: number,
  column: number,
): number {
  if (a === b) return 0;
  const geo = geoOf(row, column);
  const dist = new Int32Array(battlefield.length).fill(-1);
  const queue: number[] = [a];
  dist[a] = 0;
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    for (const nb of neighborsOf(cur, geo)) {
      if (dist[nb] >= 0 || !LINKABLE.has(battlefield[nb][0])) continue;
      dist[nb] = dist[cur] + 1;
      if (nb === b) return dist[nb];
      queue.push(nb);
    }
  }
  return -1;
}

/** 单次生成尝试：对称地形 + 保证至少一对对称据点；出生点归属在 generateSymMap 内分配 */
function generateOnce(row: number, column: number, symmetry: SymmetryMode): BattlefieldTile[] {
  const size = row * column;
  const terrain = new Array<number>(size).fill(TERRAIN.VOID);
  const filled = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    if (filled[i]) continue;
    const img = symmetryImageOf(i, row, column, symmetry);
    if (img < 0) {
      filled[i] = 1; // 奇数行最右格：虚空
      continue;
    }
    const t = CODE_ORDER[weightedChoice(WEIGHTS_SYM)];
    terrain[i] = t;
    filled[i] = 1;
    if (img !== i) {
      terrain[img] = t;
      filled[img] = 1;
    }
  }
  const battlefield: BattlefieldTile[] = terrain.map((t) => [t, TILE_OWNER.EMPTY, 0]);
  // 无对称据点对（无据点，或据点全落在轴心固定格）时随机补一对
  if (strongholdSymPairs(battlefield, row, column, symmetry).length === 0) {
    placeRandomSymPair(battlefield, row, column, symmetry);
  }
  return battlefield;
}

function buildMap(
  id: string,
  row: number,
  column: number,
  symmetry: SymmetryMode,
  battlefield: BattlefieldTile[],
): MapFullData {
  const playerList: MapPlayer[] = SYM_1V1_FORCES.map((f) => ({
    name: f.name,
    team: f.team,
    computer: 2,
    seat: f.seat,
    flag: f.flag,
  }));
  return {
    id,
    version: 1,
    title: `对称地图-${id}`,
    description: `对称地图（${SYMMETRY_LABEL[symmetry]}，先手据点3/后手据点4，两据点经平原/据点连通且最短路径距离≥${MIN_SPAWN_DISTANCE}，奇数行最右格虚空）`,
    author: 'system',
    timestamp: nowTimestamp(),
    row,
    column,
    random_spawn: false,
    cylindrical_map: false,
    fog_mode: false,
    online_time_settings: { total_time: 600, round_time: 60, time_bonus: 0 },
    tags: ['sym', '1v1'],
    player_num: 2,
    player_list: playerList,
    battlefield,
  };
}

/**
 * 生成一张对称地图：按权重生成对称地形 → 保证至少一对对称据点 → 随机一对分配
 * 先手3/后手4兵力 → 校验平原/据点连通且 BFS 距离 ≥ 4（失败整体重生成）。
 */
export function generateSymMap(opts: SymMapOptions): SymMapResult {
  const { row, column, symmetry } = opts;
  validateSymMapOptions(row, column, symmetry);
  const id = opts.id ?? 'sym-map';
  for (let attempt = 0; attempt < MAX_GEN_ATTEMPTS; attempt++) {
    const battlefield = generateOnce(row, column, symmetry);
    const pairs = strongholdSymPairs(battlefield, row, column, symmetry);
    const pair = pairs[Math.floor(Math.random() * pairs.length)];
    const [a, b] = Math.random() < 0.5 ? pair : [pair[1], pair[0]];
    battlefield[a] = [TERRAIN.CITY, 1, FIRST_SEAT_STRENGTH];
    battlefield[b] = [TERRAIN.CITY, 2, SECOND_SEAT_STRENGTH];
    const dist = linkableDistance(battlefield, a, b, row, column);
    if (dist < 0) continue; // 未连通 → 重新执行第 1 步
    if (dist < MIN_SPAWN_DISTANCE) continue; // 距离 < 4 → 重新执行第 1 步
    return { id, symmetry, spawnDistance: dist, map: buildMap(id, row, column, symmetry, battlefield) };
  }
  throw new Error(
    `无法生成满足约束的对称地图 ${row}x${column}（${SYMMETRY_LABEL[symmetry]}，已重试 ${MAX_GEN_ATTEMPTS} 次）`,
  );
}

/** [min, max] 内均匀取奇数（min/max 均为奇数） */
function oddIn(min: number, max: number): number {
  return min + 2 * Math.floor(Math.random() * ((max - min) / 2 + 1));
}

/**
 * 随机 1v1 对称地图：随机尺寸（长 9/11/13、宽 9..17 奇数）+ 随机对称方案，
 * 势力固定为先手（seat1）/后手（seat2）。供「使用随机的 1v1 地图」房间在开局时调用。
 */
export function randomSym1v1Map(id: string): MapFullData {
  const row = oddIn(SYM_ROW_RANGE.min, SYM_ROW_RANGE.max);
  const column = oddIn(SYM_COLUMN_RANGE.min, SYM_COLUMN_RANGE.max);
  const symmetry: SymmetryMode = Math.random() < 0.5 ? 'center' : 'axis';
  return generateSymMap({ row, column, symmetry, id }).map;
}
