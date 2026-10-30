// PVE 房间的本地地图导入：JSON 文件 / 地图编辑器 sessionStorage。
// 只在前端校验与持有，不写服务器地图库。
import { stripJsonComments, validateMapData } from '@dl/shared';
import type { MapFullData } from '@dl/shared';

export const PVE_MAP_MAX_ROWS = 255;
export const PVE_MAP_MAX_COLUMNS = 255;

export type LocalMapResult = { ok: true; map: MapFullData } | { ok: false; error: string };

function localMapId(base?: string): string {
  const safe = (base ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${safe || 'pve-local'}-${Date.now().toString(36)}-${suffix}`;
}

/** 校验任意地图对象并分配本地 id（导入/编辑器交接共用） */
export function normalizeImportedMap(raw: unknown, idBase?: string): LocalMapResult {
  if (!validateMapData(raw)) return { ok: false, error: '地图结构校验不通过' };
  const map = raw as MapFullData;
  if (map.row > PVE_MAP_MAX_ROWS || map.column > PVE_MAP_MAX_COLUMNS) {
    return { ok: false, error: `地图尺寸 ${map.row}×${map.column} 超过 ${PVE_MAP_MAX_ROWS}×${PVE_MAP_MAX_COLUMNS} 上限` };
  }
  if (map.player_num < 2) return { ok: false, error: '地图至少需要 2 个势力' };
  return { ok: true, map: { ...map, id: map.id || localMapId(idBase) } };
}

/** 解析 JSON 文本（允许 // 注释），校验后分配本地 id */
export function parseMapJsonText(text: string, idBase?: string): LocalMapResult {
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonComments(text));
  } catch (err) {
    return { ok: false, error: `JSON 解析失败：${err instanceof Error ? err.message : String(err)}` };
  }
  return normalizeImportedMap(raw, idBase);
}

/** 读取本地 .json 文件并解析 */
export async function readMapFile(file: File): Promise<LocalMapResult> {
  const text = await file.text();
  return parseMapJsonText(text, file.name.replace(/\.json$/i, ''));
}
