// 单图 b 估计子进程（build-pool 并行调用）
// 用法：estimate-map.ts <mapId> <games> <sims> <C> <rounds>
// 输出：BRecord JSON 到 stdout；地图从 train/data/maps/{mapId}.json 读取
import { loadMap } from '../lib/pool.js';
import { estimateB } from '../lib/estimate.js';

const [mapId, gamesStr, simsStr, cStr, roundsStr] = process.argv.slice(2);
const games = parseInt(gamesStr ?? '200', 10);
const sims = parseInt(simsStr ?? '15', 10);
const C = parseFloat(cStr ?? '1.5');
const rounds = parseInt(roundsStr ?? '6', 10);

const map = loadMap(mapId);

const rec = estimateB(map, {
  games,
  seedBase: `b-${mapId}`,
  mctsConfig: {
    simsPerMove: sims,
    explorationC: C,
    cStronghold: 0.1,
    damageCoeff: 0.001,
    terminalScale: 5,
    rolloutRounds: rounds,
    turnCap: 5 * map.row * map.column, // 临时 c_cap=5，M5 标定
    b: 0.5, // 估计 b 时终端中心化不需要 b（只统计胜率）
  },
});

process.stdout.write(JSON.stringify(rec));
