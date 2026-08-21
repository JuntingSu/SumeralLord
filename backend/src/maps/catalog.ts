import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { TERRAIN, TILE_OWNER } from '@dl/shared';
import type { MapFullData, MapMeta } from '@dl/shared';

/** 剥离 // 行注释（地图文件允许带注释，字符串内的 // 不受影响） */
function stripJsonComments(raw: string): string {
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

/** 启动时从 static/maps/*.json 加载地图目录（内存缓存，v1 不支持热更新）。id 由文件名派生。 */
export class MapCatalog {
  private readonly maps = new Map<string, MapFullData>();

  loadFromDir(dir: string): number {
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return 0;
    }
    for (const file of files) {
      try {
        const raw: unknown = JSON.parse(stripJsonComments(readFileSync(path.join(dir, file), 'utf8')));
        if (validateMapData(raw)) {
          const map = raw as MapFullData;
          map.id = path.basename(file, '.json');
          this.maps.set(map.id, map);
        } else {
          console.warn(`[maps] ${file} 结构非法，已跳过`);
        }
      } catch (err) {
        console.warn(`[maps] ${file} 解析失败:`, err);
      }
    }
    return this.maps.size;
  }

  list(search?: string): MapMeta[] {
    const all: MapMeta[] = [...this.maps.values()].map((m) => ({
      id: m.id,
      title: m.title,
      author: m.author,
      description: m.description,
      playerNum: m.player_num,
      tags: m.tags,
    }));
    if (!search) return all;
    const q = search.toLowerCase();
    return all.filter((m) =>
      [m.title, m.author, m.description, ...(m.tags ?? [])].some((t) => t.toLowerCase().includes(q)),
    );
  }

  get(id: string): MapFullData | null {
    return this.maps.get(id) ?? null;
  }
}
