// PVE 协议与默认设置（前后端共用）：PVE 对局不经过服务器，仅存档/权重走后端。
import { AI_LEVEL } from './constants.js';
import type { GameState, Phase, SeatAssignment } from './game/types.js';
import type { MapFullData, RoomTimeSettings } from './types.js';

/** 新建一局 PVE 所需的完整配置（仅在内存中传递；存档时固化到 PveSavePayload.config） */
export interface PveGameConfig {
  gameId: string;
  map: MapFullData;
  mapTitle: string;
  seatAssignments: SeatAssignment[];
  seed: string;
  timeSettings: RoomTimeSettings;
  fogMode: boolean;
  usePersonalSkin: boolean;
  playerSeat: number;
  humanUserId: number;
  reducerVersion: string;
}

/** 存档展示用元信息（冗余自 GameState，避免房间卡片拉完整存档） */
export interface PveSaveMeta {
  turn: number;
  phase: Phase;
  currentSeat: number;
  currentForceName: string;
}

/**
 * PVE 存档：完整 GameState 快照（读档直接恢复，不重放意图）+ 本局初始地图/座位/设置。
 * 地图单独保留是为了“再来一局”和房间回显；state 已自包含当前棋盘与势力。
 */
export interface PveSavePayload {
  version: 2;
  gameId: string;
  reducerVersion: string;
  savedAt: number;
  mapTitle: string;
  state: GameState;
  config: {
    map: MapFullData;
    seatAssignments: SeatAssignment[];
    fogMode: boolean;
    usePersonalSkin: boolean;
    playerSeat: number;
    humanUserId: number;
  };
  meta: PveSaveMeta;
}

/** PUT /api/pve/save 请求体（meta 平铺用于服务端列表展示与大小校验） */
export interface PveSaveBody {
  gameId: string;
  mapTitle: string;
  turn: number;
  phase: Phase;
  currentSeat: number;
  currentForce: string;
  payload: PveSavePayload;
}

export interface PveSaveResponse {
  save: PveSavePayload | null;
}

export interface PveSaveMetaResponse {
  exists: boolean;
  gameId?: string;
  mapTitle?: string;
  turn?: number;
  phase?: Phase;
  currentSeat?: number;
  currentForce?: string;
  savedAt?: number;
}

/** GET /api/pve/ai/weights 响应（普通 AI 的 MCTS 权重） */
export interface PveWeightsResult {
  version: number;
  weights: { mid: number[]; late: number[] };
}

/** GET /api/pve/maps/random 响应：直接返回完整地图，省一次往返 */
export interface PveRandomMapResult {
  map: MapFullData;
}

/** PVE 可用难度：简单 / 普通 / 休闲（困难本版按休闲处理，UI 置灰） */
export type PveAiLevel = 1 | 2 | 255;

/** 把地图/存档里的 computer 归一为 PVE 三档：2→2，3/255→255，其余→1 */
export function normalizeAiLevel(level: number): PveAiLevel {
  if (level === AI_LEVEL.MEDIUM) return AI_LEVEL.MEDIUM;
  if (level === AI_LEVEL.HARD || level === AI_LEVEL.LEISURE) return AI_LEVEL.LEISURE;
  return AI_LEVEL.EASY;
}

/** 新局默认：玩家 seat1（无 seat1 取最小 seat），其余全部简单 AI */
export function defaultPveSetup(map: MapFullData): { playerSeat: number; aiLevels: Record<number, number> } {
  const seats = map.player_list.map((p) => p.seat).sort((a, b) => a - b);
  const playerSeat = seats.includes(1) ? 1 : (seats[0] ?? 1);
  const aiLevels: Record<number, number> = {};
  for (const seat of seats) {
    if (seat !== playerSeat) aiLevels[seat] = AI_LEVEL.EASY;
  }
  return { playerSeat, aiLevels };
}

/** PVE 可玩地图过滤：至少 2 势力，且不超过约定的 255×255 */
export function isPvePlayableMap(meta: { playerNum: number; row: number; column: number }): boolean {
  return meta.playerNum >= 2 && meta.row <= 255 && meta.column <= 255;
}
