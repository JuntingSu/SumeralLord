/**
 * 核心逻辑自测：无 DOM 环境下运行 constants/mapdata/generator，验证产出地图可通过结构校验。
 * 用法：node scripts/selftest.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => readFileSync(join(root, 'js', f), 'utf8');

// 在共享作用域内求值三个纯逻辑模块
const loaded = new Function(`${load('constants.js')}\n${load('mapdata.js')}\n${load('generator.js')}\nreturn { MapData, Generator, MapConst };`)();

const { MapData, Generator, MapConst } = loaded;

// 复用校验逻辑（与 check-map.mjs 相同规则的精简版）
const TERRAIN = MapConst.TERRAIN;
const OWNER = MapConst.TILE_OWNER;
function valid(m) {
  if (m.player_num !== m.player_list.length) return 'player_num 不符';
  if (m.battlefield.length !== m.row * m.column) return '长度不符';
  const seats = new Set();
  for (const p of m.player_list) {
    if (p.seat < 1 || p.seat > 127 || seats.has(p.seat)) return `seat 非法/重复 ${p.seat}`;
    seats.add(p.seat);
  }
  for (const [t, o, s] of m.battlefield) {
    if (![0, 1, 3, 4, 5].includes(t)) return `地形 ${t} 非法`;
    if (![128, 0, 255].includes(o) && !(o >= 1 && o <= 127)) return `归属 ${o} 非法`;
    if (s < 0) return `兵力 ${s} 非法`;
    if ([4, 5].includes(t) && (o !== 128 || s !== 0)) return `山地/虚空不应有兵 (idx 地形${t} 归属${o} 兵力${s})`;
    if (o === 128 && s !== 0) return `无主格兵力应为 0`;
  }
  return null;
}

let pass = 0;
let fail = 0;
const report = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`✅ ${name}${extra ? ' | ' + extra : ''}`); }
  else { fail++; console.log(`❌ ${name}${extra ? ' | ' + extra : ''}`); }
};

// 1. 默认地图
const m1 = MapData.createDefaultMap(7, 10, 2);
report('createDefaultMap(7,10,2)', valid(m1) === null, valid(m1) || '');

// 2. 生成器各模式
for (const mode of ['plain', 'random', 'river', 'pvp']) {
  const g = Generator.generate({ row: 9, column: 11, playerNum: 2, mode });
  report(`generator(${mode})`, valid(g) === null, valid(g) || '');
}

// 3. 尺寸调整（四边 +1 与 -1）
const m3 = MapData.createDefaultMap(7, 10, 2);
MapData.resizeMap(m3, { top: 1, bottom: 1, left: 1, right: 1 });
report('resize +1 四边 (9×12)', valid(m3) === null && m3.row === 9 && m3.column === 12, `${valid(m3) || ''} ${m3.row}x${m3.column}`);
MapData.resizeMap(m3, { top: -1, bottom: -1, left: -1, right: -1 });
report('resize -1 四边 (7×10)', valid(m3) === null && m3.row === 7 && m3.column === 10, `${valid(m3) || ''} ${m3.row}x${m3.column}`);

// 4. 删除势力级联（seat 压缩）
const m4 = MapData.createDefaultMap(6, 6, 3);
const oldCityIdx = m4.battlefield.findIndex(([t, o]) => t === 1 && o === 2); // 原 seat2 的出生点
const oldSeat3CityIdx = m4.battlefield.findIndex(([t, o]) => t === 1 && o === 3); // 原 seat3 的出生点
MapData.removePlayer(m4, 2);
report('removePlayer(seat=2) → 2 势力', m4.player_num === 2 && valid(m4) === null, `${valid(m4) || ''} player_num=${m4.player_num}`);
const seatsAfter = m4.player_list.map((p) => p.seat).sort((a, b) => a - b);
report('删除后 seat 为 1,2', JSON.stringify(seatsAfter) === '[1,2]', JSON.stringify(seatsAfter));
report('原 seat2 出生点已清空归无主', JSON.stringify(m4.battlefield[oldCityIdx]) === '[1,128,0]', JSON.stringify(m4.battlefield[oldCityIdx]));
report('原 seat3 出生点已重编号为 seat2 且保留兵力', m4.battlefield[oldSeat3CityIdx][1] === 2 && m4.battlefield[oldSeat3CityIdx][2] === 5, JSON.stringify(m4.battlefield[oldSeat3CityIdx]));

// 5. 新增势力
const m5 = MapData.createDefaultMap(5, 5, 2);
MapData.addPlayer(m5);
report('addPlayer → 3 势力', m5.player_num === 3 && valid(m5) === null, `${valid(m5) || ''}`);
MapData.addPlayer(m5);
report('addPlayer 再增 → 4 势力', m5.player_num === 4 && valid(m5) === null);

// 6. 序列化剔除 id
const m6 = MapData.createDefaultMap(7, 10, 2);
const m7 = { ...m6, id: 'should_not_appear' };
report('serialize 剔除 id', !('id' in MapData.serialize(m7)), JSON.stringify(Object.keys(MapData.serialize(m7)).slice(0, 3)));

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
