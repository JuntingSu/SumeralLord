import type {
  MapFullData,
  MapLikeResult,
  MapPreview,
  UserMapListResult,
  UserMapMeta,
  UserMapSort,
} from '@dl/shared';
import { api } from './client';

export interface UserMapListQuery {
  search?: string;
  sort?: UserMapSort;
  page?: number;
  pageSize?: number;
}

function queryString(q: UserMapListQuery): string {
  const params = new URLSearchParams();
  if (q.search) params.set('search', q.search);
  if (q.sort) params.set('sort', q.sort);
  if (q.page) params.set('page', String(q.page));
  if (q.pageSize) params.set('pageSize', String(q.pageSize));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export function listMyMaps(q: UserMapListQuery = {}): Promise<UserMapListResult> {
  return api<UserMapListResult>(`/api/user-maps${queryString(q)}`);
}

export function createUserMap(map: MapFullData): Promise<UserMapMeta> {
  return api<UserMapMeta>('/api/user-maps', {
    method: 'POST',
    body: JSON.stringify({ map }),
  });
}

export function updateUserMap(id: string, map: MapFullData): Promise<UserMapMeta> {
  return api<UserMapMeta>(`/api/user-maps/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ map }),
  });
}

export function getUserMap(id: string): Promise<MapFullData> {
  return api<MapFullData>(`/api/user-maps/${encodeURIComponent(id)}`);
}

export function getUserMapPreview(id: string): Promise<MapPreview> {
  return api<MapPreview>(`/api/user-maps/${encodeURIComponent(id)}/preview`);
}

export function publishUserMap(id: string): Promise<UserMapMeta> {
  return api<UserMapMeta>(`/api/user-maps/${encodeURIComponent(id)}/publish`, {
    method: 'POST',
  });
}

// ---------- 社区 ----------

export function listCommunityMaps(q: UserMapListQuery = {}): Promise<UserMapListResult> {
  return api<UserMapListResult>(`/api/community/maps${queryString(q)}`);
}

/** 选择器用：拉取社区地图全部页（最多 10 页 / 600 张，避免无界请求） */
export async function listAllCommunityMaps(search?: string): Promise<UserMapMeta[]> {
  const out: UserMapMeta[] = [];
  let page = 1;
  for (; page <= 10; page++) {
    const r = await listCommunityMaps({ search, page, pageSize: 60 });
    out.push(...r.mapList);
    if (out.length >= r.total || r.mapList.length === 0) break;
  }
  return out;
}

export function getCommunityMap(id: string): Promise<MapFullData> {
  return api<MapFullData>(`/api/community/maps/${encodeURIComponent(id)}`);
}

export function getCommunityMapPreview(id: string): Promise<MapPreview> {
  return api<MapPreview>(`/api/community/maps/${encodeURIComponent(id)}/preview`);
}

export function getCommunityLike(id: string): Promise<MapLikeResult> {
  return api<MapLikeResult>(`/api/community/maps/${encodeURIComponent(id)}/like`);
}

export function likeCommunityMap(id: string): Promise<MapLikeResult> {
  return api<MapLikeResult>(`/api/community/maps/${encodeURIComponent(id)}/like`, {
    method: 'POST',
  });
}
