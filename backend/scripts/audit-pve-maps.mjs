/**
 * PVE 地图库体检：扫描 backend/static/pve_maps，统计有效/可玩/被过滤原因。
 * 用法：node backend/scripts/audit-pve-maps.mjs [目录]
 * 校验规则与 packages/shared/src/maps/validate.ts（后端 MapCatalog 使用）保持一致。
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dir = process.argv[2] ?? path.join(__dirname, '../static/pve_maps');
const MAX = 255;

function stripJsonComments(raw) {
  let out = '';
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (ch === '"') inString = false;
      else if (ch === '\\') {
        out += raw[i + 1] ?? '';
        i++;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
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
  ) {
    return false;
  }
  const seats = new Set();
  for (const p of m.player_list) {
    if (
      typeof p.name !== 'string' ||
      typeof p.team !== 'number' ||
      typeof p.computer !== 'number' ||
      typeof p.seat !== 'number' ||
      typeof p.flag !== 'number' ||
      p.seat < 1 ||
      p.seat > 127
    ) {
      return false;
    }
    seats.add(p.seat);
  }
  if (seats.size !== m.player_list.length) return false;
  const terrains = new Set([0, 1, 3, 4, 5]);
  for (const tile of m.battlefield) {
    if (!Array.isArray(tile) || tile.length !== 3 || !tile.every((v) => typeof v === 'number' && Number.isInteger(v))) {
      return false;
    }
    const [t, o, s] = tile;
    if (!terrains.has(t) || !(o === 128 || o === 255 || o === 0 || (o >= 1 && o <= 127)) || s < 0) return false;
  }
  return true;
}

let files = [];
try {
  files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
} catch (err) {
  console.error(`❌ 无法读取目录 ${dir}: ${err.message}`);
  process.exit(1);
}

let valid = 0;
let playable = 0;
let solo = 0;
let oversized = 0;
const invalid = [];

for (const file of files) {
  let raw;
  try {
    raw = JSON.parse(stripJsonComments(readFileSync(path.join(dir, file), 'utf8')));
  } catch {
    invalid.push(file);
    continue;
  }
  if (!validateMapData(raw)) {
    invalid.push(file);
    continue;
  }
  valid += 1;
  if (raw.row > MAX || raw.column > MAX) {
    oversized += 1;
    continue;
  }
  if (raw.player_num < 2) {
    solo += 1;
    continue;
  }
  playable += 1;
}

console.log(`目录: ${dir}`);
console.log(`文件总数: ${files.length}`);
console.log(`结构有效: ${valid}`);
console.log(`PVE 可玩（≥2 势力且 ≤${MAX}×${MAX}）: ${playable}`);
console.log(`仅 1 势力（过滤）: ${solo}`);
console.log(`超过 ${MAX}×${MAX}（过滤）: ${oversized}`);
console.log(`结构非法/解析失败（跳过）: ${invalid.length}`);
if (invalid.length > 0) {
  console.log(`非法文件示例（最多 20 个）:`);
  for (const f of invalid.slice(0, 20)) console.log(`  - ${f}`);
}
