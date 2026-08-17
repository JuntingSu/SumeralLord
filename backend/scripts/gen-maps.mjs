// 生成示例地图 JSON（确定性 LCG，可重复生成同一结果）。
// 地形值：0 平原 1 据点 3 海洋 4 山地 5 虚空（编码 2 原王城已废弃，并入据点）；battlefield 三元组 [地形, 归属, 兵力]，归属 128 无主
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'static', 'maps');

const TERRAIN = { PLAIN: 0, CITY: 1, OCEAN: 3, MOUNTAIN: 4, VOID: 5 };
const OWNER_EMPTY = 128;

function hashString(str) {
  let h = 2166136261;
  for (const ch of str) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/** even-r（偶数行右移）邻居表，row 0 在最下 */
function neighbors(col, row, columns, rows) {
  const deltas =
    row % 2 === 0
      ? [[1, 0], [-1, 0], [0, -1], [-1, -1], [0, 1], [-1, 1]]
      : [[1, 0], [-1, 0], [1, -1], [0, -1], [1, 1], [0, 1]];
  return deltas
    .map(([dc, dr]) => [col + dc, row + dr])
    .filter(([c, r]) => c >= 0 && c < columns && r >= 0 && r < rows);
}

function buildMap(cfg) {
  const {
    id, title, description, author, tags,
    columns, rows, spawns, teams, forceNames, flags,
    lakeRadius, mountainRate, randomSpawn, cycleMap, fogMode,
  } = cfg;
  const rnd = lcg(hashString(id));
  const idx = (col, row) => row * columns + col;
  const terrain = new Array(columns * rows).fill(TERRAIN.PLAIN);

  if (lakeRadius > 0) {
    const cx = (columns - 1) / 2;
    const cy = (rows - 1) / 2;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++) {
        if (Math.hypot(col - cx, row - cy) < lakeRadius) terrain[idx(col, row)] = TERRAIN.OCEAN;
      }
    }
  }
  for (let i = 0; i < terrain.length; i++) {
    if (terrain[i] === TERRAIN.PLAIN && rnd() < mountainRate) terrain[i] = TERRAIN.MOUNTAIN;
  }

  // 出生点设为据点（原王城，2026-08-16 迁移 2→1），周边强制平原（保证开局可动）
  const spawnIdx = spawns.map((s) => idx(s.col, s.row));
  for (const i of spawnIdx) {
    terrain[i] = TERRAIN.CITY;
    const col = i % columns;
    const row = Math.floor(i / columns);
    for (const [c, r] of neighbors(col, row, columns, rows)) {
      if (terrain[idx(c, r)] !== TERRAIN.CITY) terrain[idx(c, r)] = TERRAIN.PLAIN;
    }
  }

  // 由种子确定性派生时间戳，保证重复生成结果一致
  const t = rnd();
  const stamp = (n, w = 2) => String(n).padStart(w, '0');
  const timestamp = `2026-${stamp(1 + Math.floor(t * 12))}-${stamp(1 + Math.floor(t * 27))} ${stamp(Math.floor(t * 23))}:${stamp(Math.floor(t * 59))}:${stamp(Math.floor((t * 100) % 59))}.${String(Math.floor(t * 1e7)).padStart(7, '0')}`;

  const battlefield = terrain.map((tr) => [tr, OWNER_EMPTY, 0]);
  spawnIdx.forEach((i, seatIdx) => {
    battlefield[i] = [TERRAIN.CITY, seatIdx + 1, 1]; // 据点归属该座次，初始兵力 1
  });

  return {
    version: 1,
    title,
    description,
    author,
    timestamp,
    row: rows,
    column: columns,
    random_spawn: randomSpawn,
    cylindrical_map: cycleMap,
    fog_mode: fogMode,
    online_time_settings: { total_time: 600, round_time: 60, time_bonus: 0 },
    tags,
    player_num: spawns.length,
    player_list: spawns.map((s, i) => ({
      name: forceNames[i],
      team: teams[i],
      computer: 255,
      seat: i + 1,
      flag: flags[i],
    })),
    battlefield,
  };
}

const MAPS = [
  {
    id: 'map_duo_plain',
    title: '平原双雄',
    description: '小型 1v1 对抗图，中央浅湖，出生点位于对角。',
    author: '官方示例',
    tags: ['2人', '1v1', '平原'],
    columns: 10,
    rows: 7,
    spawns: [{ col: 1, row: 1 }, { col: 8, row: 5 }],
    teams: [1, 2],
    forceNames: ['红方', '蓝方'],
    flags: [1, 2],
    lakeRadius: 1.6,
    mountainRate: 0.08,
    randomSpawn: false,
    cycleMap: false,
    fogMode: false,
  },
  {
    id: 'map_trio_tripod',
    title: '三足鼎立',
    description: '三方混战图，山地密布，三家分踞。',
    author: '官方示例',
    tags: ['3人', '混战', '山地'],
    columns: 11,
    rows: 8,
    spawns: [{ col: 1, row: 6 }, { col: 9, row: 6 }, { col: 5, row: 1 }],
    teams: [1, 2, 3],
    forceNames: ['红方', '蓝方', '绿方'],
    flags: [1, 2, 3],
    lakeRadius: 0,
    mountainRate: 0.1,
    randomSpawn: false,
    cycleMap: false,
    fogMode: false,
  },
  {
    id: 'map_quad_ocean',
    title: '四海争霸',
    description: '2v2 组队图，中央大湖分割战场，开启迷雾。',
    author: '官方示例',
    tags: ['4人', '2v2', '海洋', '迷雾'],
    columns: 12,
    rows: 9,
    spawns: [{ col: 1, row: 1 }, { col: 10, row: 1 }, { col: 1, row: 7 }, { col: 10, row: 7 }],
    teams: [1, 1, 2, 2],
    forceNames: ['红方', '黄方', '蓝方', '紫方'],
    flags: [1, 4, 2, 5],
    lakeRadius: 2.2,
    mountainRate: 0.07,
    randomSpawn: true,
    cycleMap: false,
    fogMode: true,
  },
];

mkdirSync(outDir, { recursive: true });
for (const cfg of MAPS) {
  const map = buildMap(cfg);
  const file = path.join(outDir, `${cfg.id}.json`);
  writeFileSync(file, JSON.stringify(map, null, 2) + '\n');
  const spawns = map.battlefield.map((t, i) => (t[1] >= 1 && t[1] <= 127 ? i : -1)).filter((i) => i >= 0);
  console.log(`written ${file} (${map.player_num}P, ${map.column}x${map.row}, 出生据点 ${spawns.join('/')})`);
}
