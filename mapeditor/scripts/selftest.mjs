/**
 * 核心逻辑自测：无 DOM 环境下运行 constants/mapdata/generator，验证产出地图可通过结构校验。
 * 用法：node scripts/selftest.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (f) => readFileSync(join(root, 'js', f), 'utf8');

// 在共享作用域内求值纯逻辑模块
const loaded = new Function(`${load('constants.js')}\n${load('mapdata.js')}\n${load('generator.js')}\n${load('mapcode.js')}\nreturn { MapData, Generator, MapConst, MapCode };`)();

const { MapData, Generator, MapConst, MapCode } = loaded;

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

// 7. 座次调整（movePlayerSeat 战场归属重映射）
const m8 = MapData.createDefaultMap(6, 6, 3);
const city1 = m8.battlefield.findIndex(([t, o]) => t === 1 && o === 1);
const city2 = m8.battlefield.findIndex(([t, o]) => t === 1 && o === 2);
const city3 = m8.battlefield.findIndex(([t, o]) => t === 1 && o === 3);
MapData.movePlayerSeat(m8, 3, 1);
report('moveSeat 3→1 座次重排', JSON.stringify(m8.player_list.map((p) => p.seat)) === '[2,3,1]', JSON.stringify(m8.player_list.map((p) => p.seat)));
report('moveSeat 3→1 战场归属重映射', m8.battlefield[city3][1] === 1 && m8.battlefield[city1][1] === 2 && m8.battlefield[city2][1] === 3, `${m8.battlefield[city3][1]},${m8.battlefield[city1][1]},${m8.battlefield[city2][1]}`);
report('moveSeat 3→1 后仍通过校验', valid(m8) === null, valid(m8) || '');
const m9 = MapData.createDefaultMap(6, 6, 3);
const c1 = m9.battlefield.findIndex(([t, o]) => t === 1 && o === 1);
const c2 = m9.battlefield.findIndex(([t, o]) => t === 1 && o === 2);
const c3 = m9.battlefield.findIndex(([t, o]) => t === 1 && o === 3);
MapData.movePlayerSeat(m9, 1, 3);
report('moveSeat 1→3 座次重排', JSON.stringify(m9.player_list.map((p) => p.seat)) === '[3,1,2]', JSON.stringify(m9.player_list.map((p) => p.seat)));
report('moveSeat 1→3 战场归属重映射', m9.battlefield[c1][1] === 3 && m9.battlefield[c2][1] === 1 && m9.battlefield[c3][1] === 2, `${m9.battlefield[c1][1]},${m9.battlefield[c2][1]},${m9.battlefield[c3][1]}`);
report('moveSeat 1→3 后仍通过校验', valid(m9) === null, valid(m9) || '');

// 8. 随机 id 与作者默认值
report('randomId 格式 map_xxx', /^map_[a-z0-9]{8}$/.test(MapData.randomId()), MapData.randomId());

// 9. 地图码导入：真实示例码（b64coder.py __main__ 内置）解码 + 适配
const SAMPLE = 'eNp1kTsKwkAQhndmQtTKMwheQGuPoIWVgpdRsFGMD7SzsRBEwVIIIngLSys3vgqPoDO7ia/owpfJPzsvdkAp5epeRy/7mdumEQy9oDvTLe/gTw/+Qre3uj0OfP/YnfMtVUplrG13xfU+SZyYCnkdZMoM1V8gAxFExhfZf+CXfuYDMWgt4mcMuOwjG4fAOh2ra/MdBSpp4bhYDKbCuITpZed1vuqg7YViXeX8mPkfQLYmcm+UWeSfIPZe72eyzBor61IFpsovLSsA8UDuzt8zazQyL/LCkmQf7nG0OjUHcnNl3wPX5Ehr';
const sres = await MapCode.decodeMapCode(SAMPLE);
report('地图码示例可解码', sres.ok, sres.ok ? '' : sres.error);
if (sres.ok) {
  const sm = sres.map;
  report('地图码示例 标题/尺寸/势力', sm.title === '双子' && sm.row === 9 && sm.column === 9 && sm.player_num === 3, `${sm.title} ${sm.row}x${sm.column} x${sm.player_num}`);
  report('地图码示例 删除 star、新增空 tags', !('star_mode' in sm) && Array.isArray(sm.tags) && sm.tags.length === 0, JSON.stringify(Object.keys(sm).filter((k) => k.startsWith('star'))));
  report('地图码示例 flag 重编号 1..3', JSON.stringify(sm.player_list.map((p) => p.flag)) === '[1,2,3]', JSON.stringify(sm.player_list.map((p) => p.flag)));
  const tc = {};
  for (const [t] of sm.battlefield) tc[t] = (tc[t] || 0) + 1;
  report('地图码示例 地形映射正确', JSON.stringify(tc) === '{"0":32,"1":7,"3":1,"4":41}', JSON.stringify(tc));
  report('地图码示例 通过结构校验', valid(sm) === null, valid(sm) || '');
  report('地图码示例 保留时间戳/时间设置', sm.timestamp === '2026-05-25 11:00:31.6334850' && sm.online_time_settings.round_time === 60 && sm.online_time_settings.total_time === 600, sm.timestamp);
}

// 10. 地图码往返：Node 端按 b64coder.encode_map 布局构造 → 解码校验（长标题/虚空/星星模式）
const u8 = (n) => Buffer.from([n & 0xff]);
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n), 0); return b; };
const strBytes = (s) => {
  const b = Buffer.from(s, 'utf8');
  const len = b.length;
  const prefix = len < 128 ? Buffer.from([len]) : len < 256 ? Buffer.from([len, 1]) : Buffer.from([128, 2]);
  return Buffer.concat([prefix, b]);
};
const encodeLegacy = (map) => {
  const parts = [];
  parts.push(u32(map.version), strBytes(map.title), strBytes(map.description), strBytes(map.author));
  parts.push(u64(map.timestamp));
  parts.push(u32(map.player_num), u32(map.row), u32(map.column), u32(0));
  parts.push(u8(map.cylindrical_map ? 1 : 0), u8(map.random_spawn ? 1 : 0), u8(0));
  parts.push(u8(map.star_mode.triple_star_turn), u8(map.star_mode.double_star_turn), u8(map.star_mode.star ? 1 : 0));
  parts.push(u32(2));
  const area = map.row * map.column;
  parts.push(u32(area));
  const tiles = Buffer.alloc(area * 4);
  for (let i = 0; i < area; i++) {
    tiles[i * 4] = map.battlefield[i][0];
    tiles[i * 4 + 1] = map.battlefield[i][1];
    tiles[i * 4 + 2] = map.battlefield[i][2];
  }
  parts.push(tiles, Buffer.alloc(24));
  parts.push(u8(map.fog_mode ? 1 : 0), u32(map.online_time_settings.round_time), u32(map.online_time_settings.total_time));
  parts.push(u32(map.player_num));
  for (const p of map.player_list) {
    parts.push(u8(p.seat), u32(1 << (p.team - 1)), strBytes(p.name), u32(p.computer), u32(p.flag));
  }
  return Buffer.from(deflateSync(Buffer.concat(parts))).toString('base64');
};
const longTitle = '长'.repeat(80); // 80 汉字 = 240 字节，落在字符串长度 [128,256) 分支（上限 256 字节）
const synth = {
  version: 1, title: longTitle, description: '合成地图', author: 'selftest', timestamp: 10_000_000,
  player_num: 2, row: 2, column: 3, cylindrical_map: true, random_spawn: true, fog_mode: true,
  star_mode: { star: true, triple_star_turn: 3, double_star_turn: 2 },
  online_time_settings: { round_time: 45, total_time: 900, time_bonus: 0 },
  player_list: [
    { name: '玩家一', team: 1, computer: 255, seat: 1, flag: 1001 },
    { name: '玩家二', team: 2, computer: 1, seat: 2, flag: 2002 },
  ],
  // 旧地形：0虚空/1平原/2据点/3山地/4海洋
  battlefield: [[0, 128, 0], [1, 128, 0], [2, 128, 0], [3, 128, 0], [4, 128, 0], [1, 1, 5]],
};
const rres = await MapCode.decodeMapCode(encodeLegacy(synth));
report('地图码往返 可解码', rres.ok, rres.ok ? '' : rres.error);
if (rres.ok) {
  const rm = rres.map;
  report('地图码往返 长标题(80 汉字/240 字节)保留', rm.title === longTitle, `len=${Buffer.byteLength(rm.title)}`);
  report('地图码往返 地形映射(→5,0,1,4,3,0)', JSON.stringify(rm.battlefield.map((t) => t[0])) === '[5,0,1,4,3,0]', JSON.stringify(rm.battlefield.map((t) => t[0])));
  report('地图码往返 归属保留(128/1)', JSON.stringify(rm.battlefield.map((t) => t[1])) === '[128,128,128,128,128,1]', JSON.stringify(rm.battlefield.map((t) => t[1])));
  report('地图码往返 玩家 flag 重编号 1,2', JSON.stringify(rm.player_list.map((p) => p.flag)) === '[1,2]', JSON.stringify(rm.player_list.map((p) => p.flag)));
  report('地图码往返 队伍/电脑/座次保留', rm.player_list.map((p) => `${p.team}/${p.computer}/${p.seat}`).join(',') === '1/255/1,2/1/2', rm.player_list.map((p) => `${p.team}/${p.computer}/${p.seat}`).join(','));
  report('地图码往返 开关保留(fog/cyl/random)', rm.fog_mode && rm.cylindrical_map && rm.random_spawn === true, `fog=${rm.fog_mode} cyl=${rm.cylindrical_map} rand=${rm.random_spawn}`);
  report('地图码往返 时间设置保留', rm.online_time_settings.round_time === 45 && rm.online_time_settings.total_time === 900, JSON.stringify(rm.online_time_settings));
  report('地图码往返 时间戳格式', rm.timestamp === '0001-01-01 00:00:01.0000000', rm.timestamp);
  report('地图码往返 通过结构校验', valid(rm) === null, valid(rm) || '');
}
report('地图码为空 → 失败', (await MapCode.decodeMapCode('')).ok === false);
report('地图码乱码 → 失败', (await MapCode.decodeMapCode('not-a-base64!!')).ok === false);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
