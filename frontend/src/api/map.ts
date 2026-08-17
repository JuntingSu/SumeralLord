import type { MapFullData, MapListResult, MapMeta, MapPreview } from '@dl/shared';
import { api } from './client';

export async function listMaps(search?: string): Promise<MapMeta[]> {
  const qs = search ? `?search=${encodeURIComponent(search)}` : '';
  const result = await api<MapListResult>(`/api/maps${qs}`);
  return result.mapList;
}

export function getMapPreview(id: string): Promise<MapPreview> {
  return api<MapPreview>(`/api/maps/${id}/preview`);
}

export function getMap(id: string): Promise<MapFullData> {
  return api<MapFullData>(`/api/maps/${id}`);
}
