import type {
  CreateRoomBody,
  CreateRoomResult,
  JoinRoomResult,
  RoomData,
  RoomListItem,
  RoomSettingsPatch,
} from '@dl/shared';
import { api } from './client';

export function listRooms(): Promise<RoomListItem[]> {
  return api<RoomListItem[]>('/api/rooms');
}

export function getRoom(id: string): Promise<RoomData> {
  return api<RoomData>(`/api/rooms/${id}`);
}

/** 我所在的房间（服务器为准，无则 null） */
export function getMyRoom(): Promise<RoomData | null> {
  return api<RoomData | null>('/api/rooms/mine');
}

export function createRoom(body: CreateRoomBody): Promise<CreateRoomResult> {
  return api<CreateRoomResult>('/api/rooms', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function joinRoom(
  id: string,
  body: { password?: string; asSpectator: boolean },
): Promise<JoinRoomResult> {
  return api<JoinRoomResult>(`/api/rooms/${id}/join`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function leaveRoom(id: string): Promise<void> {
  return api<void>(`/api/rooms/${id}/leave`, { method: 'POST' });
}

export function disbandRoom(id: string): Promise<void> {
  return api<void>(`/api/rooms/${id}/disband`, { method: 'POST' });
}

export function setReady(id: string, ready: boolean): Promise<void> {
  return api<void>(`/api/rooms/${id}/ready`, {
    method: 'POST',
    body: JSON.stringify({ ready }),
  });
}

export function selectForce(id: string, seat: number): Promise<RoomData> {
  return api<RoomData>(`/api/rooms/${id}/select-force`, {
    method: 'POST',
    body: JSON.stringify({ seat }),
  });
}

export function kickPlayer(id: string, playerId: number): Promise<RoomData> {
  return api<RoomData>(`/api/rooms/${id}/kick`, {
    method: 'POST',
    body: JSON.stringify({ playerId }),
  });
}

/** 房主将某势力上的玩家移出（被移者回落未选择势力·未准备状态） */
export function kickFromForce(id: string, seat: number): Promise<RoomData> {
  return api<RoomData>(`/api/rooms/${id}/force-remove`, {
    method: 'POST',
    body: JSON.stringify({ seat }),
  });
}

export function updateRoomSettings(id: string, patch: RoomSettingsPatch): Promise<RoomData> {
  return api<RoomData>(`/api/rooms/${id}/settings`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

export function changeRoomMap(id: string, mapId: string): Promise<RoomData> {
  return api<RoomData>(`/api/rooms/${id}/change-map`, {
    method: 'POST',
    body: JSON.stringify({ mapId }),
  });
}

/** 房主开始对局（成功后房间 WS 广播 GAME_START，前端据此跳转对局页） */
export function startRoomGame(id: string): Promise<{ gameId: string }> {
  return api<{ gameId: string }>(`/api/rooms/${id}/start`, { method: 'POST' });
}
