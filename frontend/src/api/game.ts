import { api } from './client';
import type { GameStartMsg, GameLogResult } from '@dl/shared';

export interface GameStateInfo {
  gameId: string;
  roomId: string;
  status: 'in_game' | 'finished' | 'aborted';
  winners: string[] | null;
  clearedSeats: number[];
  lastEventId: number;
  reducerVersion: string;
  participants: Array<{ seat: number; playerId: number | null; connected: boolean }>;
}

/** 对局元信息（断线重连/中途观战数据源；不含 boardState——由重放派生） */
export function fetchGameState(gameId: string): Promise<GameStateInfo> {
  return api<GameStateInfo>(`/api/game/${gameId}/state`);
}

/** 对局初始数据（刷新重连/中途观战恢复 boardState 用；与 GAME_START 同构） */
export function fetchGameMeta(gameId: string): Promise<Omit<GameStartMsg, 'type'>> {
  return api<Omit<GameStartMsg, 'type'>>(`/api/game/${gameId}/meta`);
}

/** 按 eventId 补发对局流（EVENT_GAP 跳号补发 / RECONNECT 续拉）；nextCursor=0 表示无更多 */
export function fetchGameEvents(
  gameId: string,
  after: number,
  limit = 500,
): Promise<{ events: Array<Record<string, unknown>>; nextCursor: number }> {
  return api<{ events: Array<Record<string, unknown>>; nextCursor: number }>(
    `/api/game/${gameId}/events?after=${after}&limit=${limit}`,
  );
}

/** 对局日志（BM7a 回放）：GAME_START 首行 + 对局流分页；start=null 表示旧对局不可回放 */
export function fetchGameLog(gameId: string, after = 0, limit = 500): Promise<GameLogResult> {
  return api<GameLogResult>(`/api/game/${gameId}/log?after=${after}&limit=${limit}`);
}
