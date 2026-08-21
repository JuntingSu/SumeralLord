/**
 * 独立校验脚本：按 backend/src/maps/catalog.ts 的 validateMapData + maps.test.ts 软性规则
 * 校验地图 JSON 文件。用法：node scripts/check-map.mjs <file.json...>
 */
import { readFileSync } from 'node:fs';

const TERRAIN = { PLAIN: 0, CITY: 1, OCEAN: 3, MOUNTAIN: 4, VOID: 5 };
const TILE_OWNER = { EMPTY: 128, BLOCKER: 255, WILD: 0 };

function stripJsonComments(raw) {
  let out = '';
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (ch === '"') inString = false;
      else if (ch === '\\') { out += raw[i + 1] ?? ''; i++; }
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

function validateMapData(raw) {
  if (raw === null || typeof raw !== 'object') return false;
  const m = raw;
  if (
    typeof m.title !== 'string' ||
    typeof m.row !== 'number' ||
    typeof m.column !== 'number' ||
    typeof m.player_num !== 'number' ||
    !Array.isArray(m.player_list) ||
    m.player_list.length === 0 ||
    m.player_num !== m.player_list.length ||
    !Array.isArray(m.battlefield) ||
    m.battlefield.length !== m.row * m.column
  ) return false;
  const seats = new Set();
  for (const p of m.player_list) {
    if (typeof p.name !== 'string' || typeof p.team !== 'number' || typeof p.computer !== 'number' ||
        typeof p.seat !== 'number' || typeof p.flag !== 'number' || p.seat < 1 || p.seat > 127) return false;
    seats.add(p.seat);
  }
  if (seats.size !== m.player_list.length) return false;
  const terrainValues = new Set([TERRAIN.PLAIN, TERRAIN.CITY, TERRAIN.OCEAN, TERRAIN.MOUNTAIN, TERRAIN.VOID]);
  for (const tile of m.battlefield) {
    if (!Array.isArray(tile) || tile.length !== 3 || !tile.every((v) => typeof v === 'number' && Number.isInteger(v))) return false;
    const [t, o, s] = tile;
    if (!terrainValues.has(t) ||
        !(o === TILE_OWNER.EMPTY || o === TILE_OWNER.BLOCKER || o === TILE_OWNER.WILD || (o >= 1 && o <= 127)) ||
        s < 0) return false;
  }
  return true;
}

/** 软性规则（maps.test.ts 断言官方图应满足） */
function softChecks(m) {
  const warns = [];
  let terrain2 = 0;
  const births = new Map();
  for (const [t, o, s] of m.battlefield) {
    if (t === 2) terrain2++;
    if (t === TERRAIN.CITY && o >= 1 && o <= 127 && s > 0) births.set(o, (births.get(o) || 0) + 1);
  }
  if (terrain2) warns.push(`存在 ${terrain2} 个废弃地形编码 2`);
  for (const p of m.player_list) {
    const n = births.get(p.seat) || 0;
    if (n !== 1) warns.push(`势力「${p.name}」(seat=${p.seat}) 出生据点数量 = ${n}（应恰为 1）`);
  }
  return warns;
}

let fail = 0;
for (const file of process.argv.slice(2)) {
  let raw;
  try {
    raw = JSON.parse(stripJsonComments(readFileSync(file, 'utf8')));
  } catch (e) {
    console.log(`❌ ${file}: JSON 解析失败 ${e.message}`);
    fail++;
    continue;
  }
  if (!validateMapData(raw)) {
    console.log(`❌ ${file}: 结构校验不通过（catalog.isValid）`);
    fail++;
    continue;
  }
  const warns = softChecks(raw);
  console.log(`✅ ${file}: 结构通过${warns.length ? ' | 警告: ' + warns.join('; ') : ''}`);
}
console.log(fail ? `\n共 ${fail} 个文件未通过` : '\n全部通过');
process.exit(fail ? 1 : 0);
