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

/**
 * 地图目录：只缓存元数据（小字段），完整地图数据按需从磁盘读取。
 * 支持 3000 张量级：内存占用可忽略；目录变更通过定时 refresh 反映，无需重启。
 * id 由文件名派生。
 */
export class MapCatalog {
  private dir = '';
  private meta = new Map<string, MapMeta>();
  private timer: NodeJS.Timeout | null = null;

  loadFromDir(dir: string): number {
    this.dir = dir;
    return this.refresh();
  }

  /** 重扫目录重建元数据缓存（整体替换，删除的文件也会从缓存消失）。 */
  refresh(): number {
    const next = new Map<string, MapMeta>();
    let files: string[] = [];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      this.meta.clear();
      return 0;
    }
    for (const file of files) {
      try {
        const raw: unknown = JSON.parse(stripJsonComments(readFileSync(path.join(this.dir, file), 'utf8')));
        if (!validateMapData(raw)) {
          console.warn(`[maps] ${file} 结构非法，已跳过`);
          continue;
        }
        const m = raw as MapFullData;
        const id = path.basename(file, '.json');
        next.set(id, {
          id,
          title: m.title,
          author: m.author,
          description: m.description,
          playerNum: m.player_num,
          row: m.row,
          column: m.column,
          tags: m.tags,
        });
      } catch (err) {
        console.warn(`[maps] ${file} 解析失败:`, err);
      }
    }
    this.meta = next;
    return this.meta.size;
  }

  list(search?: string): MapMeta[] {
    const all = [...this.meta.values()];
    if (!search) return all;
    const q = search.toLowerCase();
    return all.filter((m) =>
      [m.title, m.author, m.description, ...(m.tags ?? [])].some((t) => t.toLowerCase().includes(q)),
    );
  }

  /** 完整地图按需从磁盘读取，不缓存；缺失/损坏返回 null。id 白名单防路径穿越。 */
  get(id: string): MapFullData | null {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
    try {
      const raw: unknown = JSON.parse(stripJsonComments(readFileSync(path.join(this.dir, `${id}.json`), 'utf8')));
      if (!validateMapData(raw)) return null;
      const map = raw as MapFullData;
      map.id = id;
      return map;
    } catch {
      return null;
    }
  }

  /** 周期重扫目录，使新增/删除的地图无需重启即可反映（防重入）。 */
  startAutoReload(intervalMs: number): void {
    this.stopAutoReload();
    this.timer = setInterval(() => {
      try {
        this.refresh();
      } catch (err) {
        console.warn('[maps] 自动重载失败:', err);
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  stopAutoReload(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.stopAutoReload();
  }
}
