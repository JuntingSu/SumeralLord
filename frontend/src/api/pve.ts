import type {
  MapFullData,
  MapListResult,
  MapMeta,
  MapPreview,
  PveRandomMapResult,
  PveSaveBody,
  PveSaveMetaResponse,
  PveSavePayload,
  PveSaveResponse,
  PveWeightsResult,
} from '@dl/shared';
import { api } from './client';

export type PveMapMode = 'normal' | 'campaign';

export async function listPveMaps(search?: string, mode: PveMapMode = 'normal'): Promise<MapMeta[]> {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (mode === 'campaign') params.set('mode', 'campaign');
  const qs = params.toString() ? `?${params.toString()}` : '';
  const result = await api<MapListResult>(`/api/pve/maps${qs}`);
  return result.mapList;
}

export function getPveMap(id: string): Promise<MapFullData> {
  return api<MapFullData>(`/api/pve/maps/${encodeURIComponent(id)}`);
}

export function getPveMapPreview(id: string): Promise<MapPreview> {
  return api<MapPreview>(`/api/pve/maps/${encodeURIComponent(id)}/preview`);
}

/** 点击随机地图时调用：服务端直接从可玩库随机并返回完整地图，不依赖前端列表 */
export async function randomPveMap(
  exclude?: string,
  mode: PveMapMode = 'normal',
): Promise<MapFullData> {
  const params = new URLSearchParams();
  if (exclude) params.set('exclude', exclude);
  if (mode === 'campaign') params.set('mode', 'campaign');
  const qs = params.toString() ? `?${params.toString()}` : '';
  const result = await api<PveRandomMapResult>(`/api/pve/maps/random${qs}`);
  return result.map;
}

export function getPveWeights(): Promise<PveWeightsResult> {
  return api<PveWeightsResult>('/api/pve/ai/weights');
}

export function savePveGame(body: PveSaveBody): Promise<{ savedAt: number }> {
  return api<{ savedAt: number }>('/api/pve/save', {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function getPveSave(): Promise<PveSavePayload | null> {
  const result = await api<PveSaveResponse>('/api/pve/save');
  return result.save;
}

export function getPveSaveMeta(): Promise<PveSaveMetaResponse> {
  return api<PveSaveMetaResponse>('/api/pve/save/meta');
}

export function deletePveSave(): Promise<{ deleted: boolean }> {
  return api<{ deleted: boolean }>('/api/pve/save', { method: 'DELETE' });
}
