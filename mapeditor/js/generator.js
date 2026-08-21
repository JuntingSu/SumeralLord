/**
 * generator.js — 随机地图生成器
 * 移植自 mapeditor-release/mapeditor/generator.py（BetterRandomMap），地形编码映射到当前项目：
 * 旧 0虚空/1平原/2据点/3山地/4海洋 → 新 0平原/1据点/3海洋/4山地/5虚空。
 * 权重表 [0平原, 1据点, 3海洋, 4山地, 5虚空]（由 weight.py 换算）。
 */
const Generator = (() => {
  const { TERRAIN, TILE_OWNER, DEFAULT_STRENGTH } = MapConst;

  const WEIGHTS = {
    random: [1, 1, 1, 1, 1],
    plain: [0.58, 0.02, 0.16, 0.24, 0],
    river: [0.33, 0.02, 0.65, 0, 0],
    pvp: [0.35, 0, 0.5, 0.15, 0],
  };
  const MODE_TITLES = {
    random: '随机地图-破碎',
    plain: '随机地图-均衡',
    river: '随机地图-河谷',
    pvp: '随机地图-对局',
  };
  const CODE_ORDER = [TERRAIN.PLAIN, TERRAIN.CITY, TERRAIN.OCEAN, TERRAIN.MOUNTAIN, TERRAIN.VOID];
  // 可连通地形：全断（山地/虚空）除外。当前游戏中海洋可通行（半断），故计入。
  const WALKABLE = new Set([TERRAIN.PLAIN, TERRAIN.CITY, TERRAIN.OCEAN]);

  // 邻接表（对齐 coord.ts：奇数行右移半格）
  const NEIGHBORS = [
    [[1, 0], [-1, 0], [0, -1], [-1, -1], [0, 1], [-1, 1]],
    [[1, 0], [-1, 0], [1, -1], [0, -1], [1, 1], [0, 1]],
  ];

  function neighborsOf(r, c, row, column) {
    const out = [];
    for (const [dr, dc] of NEIGHBORS[r % 2]) {
      const nr = r + dr;
      const nc = c + dc;
      if (nr >= 0 && nr < row && nc >= 0 && nc < column) out.push(nr * column + nc);
    }
    return out;
  }

  /** 所有可走格是否全连通（BFS） */
  function connected(terrain, row, column) {
    let start = -1;
    for (let i = 0; i < terrain.length; i++) {
      if (WALKABLE.has(terrain[i])) { start = i; break; }
    }
    if (start < 0) return false;
    const visited = new Uint8Array(terrain.length);
    const stack = [start];
    visited[start] = 1;
    while (stack.length) {
      const idx = stack.pop();
      const r = Math.floor(idx / column);
      const c = idx % column;
      for (const n of neighborsOf(r, c, row, column)) {
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

  function weightedChoice(weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /**
   * 生成随机地图。opts: {row, column, playerNum, mode}
   * 返回 MapFullData；每势力一座出生据点。
   */
  function generate({ row, column, playerNum, mode }) {
    const weights = WEIGHTS[mode] || WEIGHTS.random;
    const size = row * column;
    const map = MapData.createDefaultMap(row, column, Math.max(1, playerNum));
    map.title = MODE_TITLES[mode] || '随机地图';

    let terrain = [];
    for (let attempt = 0; attempt < 500; attempt++) {
      terrain = Array.from({ length: size }, () => CODE_ORDER[weightedChoice(weights)]);
      if (connected(terrain, row, column)) break;
    }

    // 覆盖地形并清空归属/兵力（避免残留默认出生点）
    for (let i = 0; i < size; i++) {
      map.battlefield[i] = [terrain[i], TILE_OWNER.EMPTY, 0];
    }

    // 从可走格中随机取每势力的出生点
    const candidates = [];
    for (let i = 0; i < size; i++) if (WALKABLE.has(terrain[i])) candidates.push(i);
    shuffle(candidates);
    const picked = candidates.slice(0, playerNum);
    const used = new Set(picked);
    let extra = playerNum - picked.length;
    while (extra > 0) {
      const idx = Math.floor(Math.random() * size);
      if (!used.has(idx)) { picked.push(idx); used.add(idx); extra--; }
    }
    for (let i = 0; i < playerNum; i++) {
      map.battlefield[picked[i]] = [TERRAIN.CITY, i + 1, DEFAULT_STRENGTH];
    }
    return map;
  }

  return { generate };
})();
