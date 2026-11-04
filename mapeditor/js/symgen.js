/**
 * symgen.js — 对称 1v1 地图生成器
 * 移植自 packages/shared/src/mapgen/sym.ts（多人模式「随机 1v1 对称地图」所用算法）：
 *   1) 中心对称（center，180° 旋转）或轴对称（axis，左右镜像）二选一
 *   2) 地形权重 平原0.68/据点0.02/海洋0.2/山地0.05/虚空0.05，采样值同步到对称格
 *   3) 长宽均为奇数（行 9..13、列 9..17），奇数行最右格无对称映像，恒为虚空
 *   4) 保证至少一对对称据点；随机取一对：先手 seat1 兵力3、后手 seat2 兵力4
 *   5) 两出生据点须经平原/据点连通且 BFS 最短距离 ≥ 4，否则整图重生成（上限 300 次）
 */
const SymGen = (() => {
  const { TERRAIN, TILE_OWNER } = MapConst;

  const FIRST_SEAT_STRENGTH = 3;
  const SECOND_SEAT_STRENGTH = 4;
  /** 地形权重，顺序对应 CODE_ORDER */
  const WEIGHTS_SYM = [0.68, 0.02, 0.2, 0.05, 0.05];
  const CODE_ORDER = [TERRAIN.PLAIN, TERRAIN.CITY, TERRAIN.OCEAN, TERRAIN.MOUNTAIN, TERRAIN.VOID];
  /** 可接/全接地形（平原、据点） */
  const LINKABLE = new Set([TERRAIN.PLAIN, TERRAIN.CITY]);
  const MIN_SPAWN_DISTANCE = 4;
  const ROW_RANGE = { min: 9, max: 13 };
  const COLUMN_RANGE = { min: 9, max: 17 };
  const MAX_GEN_ATTEMPTS = 300;
  const SYMMETRY_LABEL = { center: '中心对称', axis: '轴对称' };

  // 邻接表（对齐 coord.ts：奇数行右移半格），元素为 [dc, dr]
  const EVEN_ROW_DELTAS = [[1, 0], [-1, 0], [0, -1], [-1, -1], [0, 1], [-1, 1]];
  const ODD_ROW_DELTAS = [[1, 0], [-1, 0], [1, -1], [0, -1], [1, 1], [0, 1]];

  function neighborsOf(index, row, column) {
    const r = Math.floor(index / column);
    const c = index % column;
    const deltas = r % 2 === 0 ? EVEN_ROW_DELTAS : ODD_ROW_DELTAS;
    const out = [];
    for (const [dc, dr] of deltas) {
      const nr = r + dr;
      if (nr < 0 || nr >= row) continue;
      const nc = c + dc;
      if (nc < 0 || nc >= column) continue;
      out.push(nr * column + nc);
    }
    return out;
  }

  /** 格 index 的对称映像（-1 = 无映像；奇数行最右格恒为虚空、不参与对称） */
  function symmetryImageOf(index, row, column, symmetry) {
    const r = Math.floor(index / column);
    const c = index % column;
    if (r % 2 === 1 && c === column - 1) return -1;
    const rr = symmetry === 'center' ? row - 1 - r : r;
    const cc = r % 2 === 0 ? column - 1 - c : column - 2 - c;
    return rr * column + cc;
  }

  function validateOptions(row, column, symmetry) {
    if (row % 2 === 0 || column % 2 === 0) {
      throw new Error(`对称地图要求长宽均为奇数，收到 ${row}×${column}`);
    }
    if (row < ROW_RANGE.min || row > ROW_RANGE.max || column < COLUMN_RANGE.min || column > COLUMN_RANGE.max) {
      throw new Error(
        `地图尺寸超出对称算法支持范围：行(长) ${ROW_RANGE.min}..${ROW_RANGE.max} 奇数、列(宽) ${COLUMN_RANGE.min}..${COLUMN_RANGE.max} 奇数，收到 ${row}×${column}`,
      );
    }
    if (symmetry !== 'center' && symmetry !== 'axis') {
      throw new Error(`对称方案必须是 center 或 axis，收到 "${symmetry}"`);
    }
  }

  function weightedChoice(weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  /** 互为对称映像的据点对 */
  function strongholdSymPairs(battlefield, row, column, symmetry) {
    const pairs = [];
    const seen = new Set();
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

  /** 无对称据点对时随机补一对（覆盖无害） */
  function placeRandomSymPair(battlefield, row, column, symmetry) {
    const candidates = [];
    for (let i = 0; i < battlefield.length; i++) {
      const img = symmetryImageOf(i, row, column, symmetry);
      if (img >= 0 && img !== i) candidates.push(i);
    }
    if (candidates.length === 0) throw new Error('对称地图无可放置据点的非固定格');
    const i = candidates[Math.floor(Math.random() * candidates.length)];
    const img = symmetryImageOf(i, row, column, symmetry);
    battlefield[i] = [TERRAIN.CITY, TILE_OWNER.EMPTY, 0];
    battlefield[img] = [TERRAIN.CITY, TILE_OWNER.EMPTY, 0];
  }

  /** 两格经平原/据点的 BFS 最短距离；不可达返回 -1 */
  function linkableDistance(battlefield, a, b, row, column) {
    if (a === b) return 0;
    const dist = new Int32Array(battlefield.length).fill(-1);
    const queue = [a];
    dist[a] = 0;
    for (let head = 0; head < queue.length; head++) {
      const cur = queue[head];
      for (const nb of neighborsOf(cur, row, column)) {
        if (dist[nb] >= 0 || !LINKABLE.has(battlefield[nb][0])) continue;
        dist[nb] = dist[cur] + 1;
        if (nb === b) return dist[nb];
        queue.push(nb);
      }
    }
    return -1;
  }

  /** 单次生成：对称地形 + 保证至少一对对称据点 */
  function generateOnce(row, column, symmetry) {
    const size = row * column;
    const terrain = new Array(size).fill(TERRAIN.VOID);
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
    const battlefield = terrain.map((t) => [t, TILE_OWNER.EMPTY, 0]);
    if (strongholdSymPairs(battlefield, row, column, symmetry).length === 0) {
      placeRandomSymPair(battlefield, row, column, symmetry);
    }
    return battlefield;
  }

  function buildMap(id, row, column, symmetry, battlefield) {
    return {
      id,
      version: 1,
      title: `对称地图-${id}`,
      description: `对称地图（${SYMMETRY_LABEL[symmetry]}，先手据点3/后手据点4，两据点经平原/据点连通且最短路径距离≥${MIN_SPAWN_DISTANCE}，奇数行最右格虚空）`,
      author: 'system',
      timestamp: MapData.nowTimestamp(),
      row,
      column,
      random_spawn: false,
      cylindrical_map: false,
      fog_mode: false,
      online_time_settings: { total_time: 600, round_time: 60, time_bonus: 0 },
      tags: ['sym', '1v1'],
      player_num: 2,
      player_list: [
        { name: '先手', team: 1, computer: 2, seat: 1, flag: 1 },
        { name: '后手', team: 2, computer: 2, seat: 2, flag: 2 },
      ],
      battlefield,
    };
  }

  /**
   * 生成一张对称 1v1 地图。
   * opts: { row, column, symmetry: 'center'|'axis', id? }
   * 返回 { id, symmetry, map, spawnDistance }
   */
  function generate(opts) {
    const { row, column, symmetry } = opts;
    validateOptions(row, column, symmetry);
    const id = opts.id || 'sym-map';
    for (let attempt = 0; attempt < MAX_GEN_ATTEMPTS; attempt++) {
      const battlefield = generateOnce(row, column, symmetry);
      const pairs = strongholdSymPairs(battlefield, row, column, symmetry);
      const pair = pairs[Math.floor(Math.random() * pairs.length)];
      const [a, b] = Math.random() < 0.5 ? pair : [pair[1], pair[0]];
      battlefield[a] = [TERRAIN.CITY, 1, FIRST_SEAT_STRENGTH];
      battlefield[b] = [TERRAIN.CITY, 2, SECOND_SEAT_STRENGTH];
      const dist = linkableDistance(battlefield, a, b, row, column);
      if (dist < 0) continue;
      if (dist < MIN_SPAWN_DISTANCE) continue;
      return { id, symmetry, spawnDistance: dist, map: buildMap(id, row, column, symmetry, battlefield) };
    }
    throw new Error(
      `无法生成满足约束的对称地图 ${row}×${column}（${SYMMETRY_LABEL[symmetry]}，已重试 ${MAX_GEN_ATTEMPTS} 次）`,
    );
  }

  return { generate, symmetryImageOf, ROW_RANGE, COLUMN_RANGE };
})();
