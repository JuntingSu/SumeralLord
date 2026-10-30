// 地图 JSON 工具：前后端共用（目录加载、保存接口、PVE 导入）。
// 与原 backend/src/maps/catalog.ts 的实现保持一致；stripJsonComments 允许地图文件带 // 行注释。
import { TERRAIN, TILE_OWNER } from '../types.js';

/** 剥离 // 行注释（字符串内的 // 不受影响） */
export function stripJsonComments(raw: string): string {
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

/** 地图结构校验（目录加载与保存接口共用）：返回 true 表示通过 */
export function validateMapData(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object') return false;
  const m = raw as Record<string, unknown>;
  if (
    typeof m.title !== 'string' ||
    typeof m.row !== 'number' ||
    typeof m.column !== 'number' ||
    typeof m.player_num !== 'number' ||
    !Array.isArray(m.player_list) ||
    (m.player_list as unknown[]).length === 0 ||
    m.player_num !== (m.player_list as unknown[]).length ||
    !Array.isArray(m.battlefield) ||
    (m.battlefield as unknown[]).length !== m.row * m.column
  ) {
    return false;
  }
  const seats = new Set<number>();
  for (const p of m.player_list as Record<string, unknown>[]) {
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
  if (seats.size !== (m.player_list as unknown[]).length) return false;
  const terrainValues = new Set<number>([TERRAIN.PLAIN, TERRAIN.CITY, TERRAIN.OCEAN, TERRAIN.MOUNTAIN, TERRAIN.VOID]);
  for (const entry of m.battlefield as unknown[]) {
    const tile = entry as unknown[];
    if (!Array.isArray(tile) || tile.length !== 3 || !tile.every((v) => typeof v === 'number' && Number.isInteger(v))) {
      return false;
    }
    const [terrain, owner, strength] = tile as [number, number, number];
    if (
      !terrainValues.has(terrain) ||
      !(owner === TILE_OWNER.EMPTY || owner === TILE_OWNER.BLOCKER || owner === TILE_OWNER.WILD || (owner >= 1 && owner <= 127)) ||
      strength < 0
    ) {
      return false;
    }
  }
  return true;
}
