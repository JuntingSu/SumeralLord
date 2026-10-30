/**
 * xlsx-to-pve-maps.mjs — 批量把 maplist.xlsx C 列的地图码转换为本游戏地图 JSON
 *
 * 用法：node mapeditor/scripts/xlsx-to-pve-maps.mjs [--xlsx <path>] [--out <dir>] [--manifest <csv>] [--limit N]
 *
 * 规则：
 * - 只读第一个工作表；第 1 行为标题，从第 2 行起读 C 列（地图码）
 * - 解码完全复用 js/mapcode.js 的 MapCode.decodeMapCode（未改动，与 scripts/selftest.mjs 相同的加载方式）
 * - 文件名即地图 id：pve_<Excel 行号四位>.json，仅写 [a-zA-Z0-9_-]
 * - 重复地图码（剔除空白后相同）按首次出现保留，其余跳过并记录
 * - 写入前清理目标目录内旧的 pve_*.json；写入后逐文件复跑结构校验
 * - 清单 CSV 写在目标目录之外，避免被后端的目录扫描当成地图
 */
import { readFileSync, writeFileSync, readdirSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..', '..');

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const XLSX = resolve(argOf('--xlsx', join(projectRoot, 'refer', 'maplist.xlsx')));
const OUT = resolve(argOf('--out', join(projectRoot, 'backend', 'static', 'pve_maps')));
const MANIFEST = resolve(argOf('--manifest', join(projectRoot, 'refer', 'pve_maps_manifest.csv')));
const LIMIT = Number(argOf('--limit', '0')) || 0;

/* ---------------- 复用未修改的 mapcode.js ---------------- */
const loadJs = (f) => readFileSync(join(projectRoot, 'mapeditor', 'js', f), 'utf8');
const { MapCode } = new Function(`${loadJs('constants.js')}\n${loadJs('mapcode.js')}\nreturn { MapConst, MapCode };`)();

/* ---------------- xlsx 读取（Node 内置 zlib，无第三方依赖） ---------------- */
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/xlsx 文件');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.set(name, { method, csize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return (name) => {
    const e = entries.get(name);
    if (!e) throw new Error(`xlsx 内缺少 ${name}`);
    const nameLen = buf.readUInt16LE(e.localOffset + 26);
    const extraLen = buf.readUInt16LE(e.localOffset + 28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + e.csize);
    return (e.method === 0 ? data : inflateRawSync(data)).toString('utf8');
  };
}

const XML_ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' };
const unescapeXml = (s) => s.replace(/&(lt|gt|quot|apos|amp);/g, (m) => XML_ENTITIES[m]);

/** 共享字符串表：<si> 内的全部 <t> 文本按顺序拼接（兼容富文本 run） */
function parseSharedStrings(xml) {
  const out = [];
  for (const si of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si\s*\/>/g)) {
    const body = si[1] ?? '';
    const text = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('');
    out.push(unescapeXml(text));
  }
  return out;
}

/** 第一个工作表在 zip 内的路径（经 workbook.xml + rels 解析，不假设 sheet1） */
function firstSheetPath(read) {
  const relsXml = read('xl/_rels/workbook.xml.rels');
  const rels = new Map();
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const attrs = m[1];
    const id = attrs.match(/\bId="([^"]+)"/)?.[1];
    const target = attrs.match(/\bTarget="([^"]+)"/)?.[1];
    if (id && target) rels.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }
  const workbook = read('xl/workbook.xml');
  const first = workbook.match(/<sheet\b([^>]*)\/?>/);
  if (!first) throw new Error('workbook.xml 中没有工作表');
  const rid = first[1].match(/\br:id="([^"]+)"/)?.[1];
  const target = rid && rels.get(rid);
  if (!target) throw new Error('无法解析第一个工作表路径');
  const path = target.startsWith('xl/') ? target : `xl/${target}`;
  if (path.includes('/worksheets/')) return path;
  return path;
}

/** 解析工作表为 { rowNumber: { A: {t,v}, C: ... } }（只取用到的列） */
function parseSheet(xml, sharedStrings) {
  const rows = new Map();
  const cellValue = (attrs, inner) => {
    const type = attrs.match(/\bt="([^"]+)"/)?.[1] ?? '';
    if (type === 'inlineStr') {
      const text = [...(inner ?? '').matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('');
      return unescapeXml(text);
    }
    const v = (inner ?? '').match(/<v>([\s\S]*?)<\/v>/)?.[1];
    if (v === undefined) return '';
    return type === 's' ? sharedStrings[Number(v)] ?? '' : unescapeXml(v);
  };
  for (const row of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNum = Number(row[1].match(/\br="(\d+)"/)?.[1]);
    if (!rowNum) continue;
    const cells = {};
    for (const c of row[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = c[1].match(/\br="([A-Z]+)\d+"/)?.[1];
      if (!ref) continue;
      if (!['A', 'B', 'C', 'D'].includes(ref)) continue;
      cells[ref] = cellValue(c[1], c[2]);
    }
    rows.set(rowNum, cells);
  }
  return rows;
}

/* ---------------- 结构校验（对齐 backend/src/maps/catalog.ts 的 validateMapData） ---------------- */
const TERRAIN_OK = new Set([0, 1, 3, 4, 5]);
function hardError(m) {
  if (m.title === undefined || typeof m.title !== 'string') return 'title 非字符串';
  if (typeof m.row !== 'number' || typeof m.column !== 'number' || typeof m.player_num !== 'number') return '尺寸/势力数非数字';
  if (!Array.isArray(m.player_list) || m.player_list.length === 0) return 'player_list 为空';
  if (m.player_num !== m.player_list.length) return `player_num=${m.player_num} 与 player_list=${m.player_list.length} 不符`;
  if (!Array.isArray(m.battlefield) || m.battlefield.length !== m.row * m.column) return `地块数 ${m.battlefield?.length} != ${m.row}x${m.column}`;
  const seats = new Set();
  for (const p of m.player_list) {
    if (typeof p.name !== 'string') return '玩家 name 非字符串';
    for (const k of ['team', 'computer', 'seat', 'flag']) {
      if (typeof p[k] !== 'number') return `玩家 ${k} 非数字`;
    }
    if (p.seat < 1 || p.seat > 127) return `seat 越界 ${p.seat}`;
    if (seats.has(p.seat)) return `seat 重复 ${p.seat}`;
    seats.add(p.seat);
  }
  for (const tile of m.battlefield) {
    if (!Array.isArray(tile) || tile.length !== 3 || !tile.every((v) => typeof v === 'number' && Number.isInteger(v))) {
      return '地块字段非整数三元组';
    }
    const [t, o, s] = tile;
    if (!TERRAIN_OK.has(t)) return `地形非法 ${t}`;
    if (!(o === 128 || o === 255 || o === 0 || (o >= 1 && o <= 127))) return `归属非法 ${o}`;
    if (s < 0) return `兵力为负 ${s}`;
  }
  return null;
}

function softWarnings(m) {
  const warns = [];
  let terrain2 = 0;
  const births = new Map();
  for (const [t, o, s] of m.battlefield) {
    if (t === 2) terrain2++;
    if (t === 1 && o >= 1 && o <= 127 && s > 0) births.set(o, (births.get(o) || 0) + 1);
  }
  if (terrain2) warns.push(`地形2x${terrain2}`);
  const off = m.player_list.filter((p) => (births.get(p.seat) || 0) !== 1);
  if (off.length) warns.push(`出生点异常seat${off.map((p) => `${p.seat}:${births.get(p.seat) || 0}`).join(',')}`);
  return warns;
}

/* ---------------- 主流程 ---------------- */
const read = readZip(readFileSync(XLSX));
const sheetPath = firstSheetPath(read);
const sharedStrings = parseSharedStrings(read('xl/sharedStrings.xml'));
const rows = parseSheet(read(sheetPath), sharedStrings);

const sortedRows = [...rows.keys()].sort((a, b) => a - b);
const dataRows = sortedRows.filter((r) => r >= 2);

const seen = new Map(); // code -> 首次出现的行号
const written = [];
const skipped = [];
const duplicate = [];
const warnings = [];
const trimmed = [];

mkdirSync(OUT, { recursive: true });
let removed = 0;
for (const f of readdirSync(OUT)) {
  if (/^pve_\d+\.json$/.test(f)) { unlinkSync(join(OUT, f)); removed++; }
}

for (const rowNum of dataRows) {
  if (LIMIT && written.length >= LIMIT) break;
  const cells = rows.get(rowNum);
  const rawCode = cells.C ?? '';
  const code = String(rawCode).replace(/\s+/g, '');
  const xlsxTitle = String(cells.A ?? '');
  const xlsxCategory = String(cells.B ?? '');
  const xlsxAuthor = String(cells.D ?? '');

  if (!code) {
    if (cells.A || cells.D) skipped.push({ row: rowNum, title: xlsxTitle, reason: 'C 列为空' });
    continue;
  }
  if (seen.has(code)) {
    duplicate.push({ row: rowNum, first: seen.get(code), title: xlsxTitle });
    continue;
  }
  seen.set(code, rowNum);

  const res = await MapCode.decodeMapCode(code);
  if (!res.ok) {
    skipped.push({ row: rowNum, title: xlsxTitle, reason: res.error });
    continue;
  }
  const map = res.map;
  // 图内 title/author 偶尔带粘贴残留的首尾换行/空格（如 "生死时速：突击\r\n"），仅清理首尾空白，其余字段保持原样
  for (const k of ['title', 'author']) {
    const cleaned = String(map[k] ?? '').replace(/^\s+|\s+$/g, '');
    if (cleaned !== map[k]) {
      trimmed.push({ row: rowNum, field: k, before: map[k], after: cleaned });
      map[k] = cleaned;
    }
  }
  const bad = hardError(map);
  if (bad) {
    skipped.push({ row: rowNum, title: xlsxTitle, reason: `结构校验失败：${bad}` });
    continue;
  }
  const warn = softWarnings(map);
  if (warn.length) warnings.push({ row: rowNum, title: map.title, warn: warn.join(';') });

  const id = `pve_${String(rowNum).padStart(4, '0')}`;
  const file = `${id}.json`;
  writeFileSync(join(OUT, file), `${JSON.stringify(map)}\n`);

  // 落盘后复读复校（防止写坏）
  const back = JSON.parse(readFileSync(join(OUT, file), 'utf8'));
  const backBad = hardError(back);
  if (backBad) throw new Error(`${file} 回读校验失败：${backBad}`);

  written.push({
    row: rowNum,
    file,
    title: map.title,
    author: map.author,
    rowCount: map.row,
    column: map.column,
    playerNum: map.player_num,
    xlsxTitle,
    xlsxCategory,
    xlsxAuthor,
  });
}

/* ---------------- 清单 CSV ---------------- */
const csvCell = (v) => {
  const s = String(v ?? '').replace(/\r\n|\r|\n/g, ' ');
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const header = ['excel行', '文件', '标题(图内)', '作者(图内)', '行', '列', '势力数', '表格标题', '表格类别', '表格作者'];
const lines = [header.join(',')];
for (const w of written) {
  lines.push([w.row, w.file, w.title, w.author, w.rowCount, w.column, w.playerNum, w.xlsxTitle, w.xlsxCategory, w.xlsxAuthor].map(csvCell).join(','));
}
mkdirSync(dirname(MANIFEST), { recursive: true });
writeFileSync(MANIFEST, `\ufeff${lines.join('\n')}\n`);

/* ---------------- 报告 ---------------- */
console.log(`源文件：${XLSX}（工作表 ${sheetPath}）`);
console.log(`目标目录：${OUT}（清理旧文件 ${removed} 个）`);
console.log(`数据行：${dataRows.length} | 写入：${written.length} | 跳过：${skipped.length} | 重复跳过：${duplicate.length}`);
console.log(`软性警告（不阻塞）：${warnings.length}`);
console.log(`首尾空白清理：${trimmed.length} 处（仅 title/author）`);
if (skipped.length) {
  console.log('\n跳过明细：');
  for (const s of skipped) console.log(`  行 ${s.row}「${s.title}」：${s.reason}`);
}
if (duplicate.length) {
  console.log('\n重复码跳过明细（保留首次出现）：');
  for (const d of duplicate) console.log(`  行 ${d.row}「${d.title}」与行 ${d.first} 相同`);
}
const totalBytes = written.reduce((a, w) => a + readFileSync(join(OUT, w.file)).length, 0);
console.log(`\n产物合计 ${(totalBytes / 1048576).toFixed(1)} MB，清单：${MANIFEST}`);
