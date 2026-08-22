// 共享类型：REST 响应包裹与用户公开信息
import type { ErrorCode } from './constants.js';

export interface ApiEnvelope<T = unknown> {
  success: boolean;
  data?: T;
  code?: ErrorCode;
  message?: string;
}

export interface UserPublic {
  id: number;
  username: string;
  matches: number;
  wins: number;
  flag: number;
}

export interface LoginResult {
  token: string;
  user: UserPublic;
}

export interface WsTicketResult {
  ticket: string;
}

// ---------- 地图（对齐 example.json 规范：snake_case 字段 + battlefield 三元组） ----------

/**
 * 地形值：0 平原 1 据点（城市）3 海洋 4 山地 5 虚空。
 * 编码 2（原"王城"）已废弃并保留空缺、不回收复用（防旧图混淆，2026-08-16 迁移）。
 */
export const TERRAIN = {
  PLAIN: 0,
  CITY: 1,
  OCEAN: 3,
  MOUNTAIN: 4,
  VOID: 5,
} as const;

/**
 * battlefield 归属特殊值：128 无主地块；255 特殊中立兵「阻挡」；0 特殊中立兵「野生」。
 * 其余 1..player_num 对应 player_list 中的 seat。
 * 注意：owner 255 与 player_list[].computer 的 255（休闲 AI）是不同字段的取值。
 */
export const TILE_OWNER = {
  EMPTY: 128,
  BLOCKER: 255,
  WILD: 0,
} as const;

/** 地图内嵌玩家定义（出生点由 battlefield 中 belongs=seat 的据点地块表达，恒等映射） */
export interface MapPlayer {
  name: string;
  team: number;
  /** 电脑难度 {1,2,3,255}，255=休闲（M4：轮到即跳过；1~3 按 255 处理，难度行为 M5+） */
  computer: number;
  /** 行动顺序 */
  seat: number;
  /** 旗帜编号 */
  flag: number;
}

export interface OnlineTimeSettings {
  total_time: number;
  round_time: number;
  time_bonus: number;
}

/** 战场地块：[地形, 归属, 兵力] */
export type BattlefieldTile = [terrain: number, belongs: number, strength: number];

export interface MapFullData {
  /** 由文件名派生（地图文件本身不含 id） */
  id: string;
  version: number;
  title: string;
  description: string;
  author: string;
  /** "YYYY-MM-DD HH:mm:ss.f" 格式字符串，保持此形式 */
  timestamp: string;
  row: number; // 行数（横向线条数）
  column: number; // 列数（纵向格数）
  random_spawn: boolean;
  cylindrical_map: boolean;
  fog_mode: boolean;
  online_time_settings: OnlineTimeSettings;
  tags: string[];
  player_num: number;
  player_list: MapPlayer[];
  /**
   * 线性数组，index 0 = 左下，从左到右、从下到上；每项 [地形, 归属, 兵力]。
   * 归属取值见 TILE_OWNER，其余为 seat；兵力为该地块驻军数。
   */
  battlefield: BattlefieldTile[];
}

export interface MapMeta {
  id: string;
  title: string;
  author: string;
  description: string;
  playerNum: number;
  row: number;
  column: number;
  tags: string[];
}

export interface MapPreview {
  row: number;
  column: number;
  battlefield: BattlefieldTile[];
}

// ---------- 房间 ----------

export type RoomPlayerState = 'unready' | 'prepared' | 'spectating' | 'in_game' | 'offline';

export interface RoomPlayer {
  id: number;
  username: string;
  flag: number;
  state: RoomPlayerState;
  joinedAt: number;
  /** 是否已连接房间 WS（false = 离线显示） */
  online: boolean;
}

export interface RoomForce {
  seat: number;
  team: number;
  name: string;
  flag: number;
  playerId: number | null;
}

export interface RoomTimeSettings {
  stepTime: number;
  gameTime: number;
  additionalTime: number;
}

export interface RoomData {
  id: string;
  name: string;
  hostId: number;
  hasPassword: boolean;
  allowSpectate: boolean;
  fogMode: boolean;
  randomSpawn: boolean;
  /** 开启后，开局时无玩家扮演的势力由 AI 接管（难度取地图 player_list[].computer）；关闭则开局删除其所有兵 */
  aiTakeover: boolean;
  mapId: string;
  mapTitle: string;
  playerNum: number; // maxPlayers，来自地图
  timeSettings: RoomTimeSettings;
  /** game_over：对局已结束，结算展示保留期（超时由 idleSweeper 回落 waiting） */
  status: 'waiting' | 'in_game' | 'game_over';
  players: RoomPlayer[];
  forces: RoomForce[];
}

export interface RoomListItem {
  id: string;
  name: string;
  currentPlayers: number; // 非观战人数
  spectatorCount: number;
  maxPlayers: number;
  status: 'waiting' | 'in_game' | 'game_over';
  hasPassword: boolean;
  allowSpectate: boolean;
}

export interface CreateRoomResult {
  roomId: string;
  room: RoomData;
}

export interface JoinRoomResult {
  room: RoomData;
  gameId?: string; // 仅 in_game 房间观战加入时返回（BM4+）
}

export interface MapListResult {
  mapList: MapMeta[];
}

/** 对局记录（BM7a/BM7b：战绩与回放列表；match_history 行） */
export interface MatchRecord {
  gameId: string;
  roomId: string;
  startedAt: number;
  finishedAt: number;
  /** 胜方 playerId 字符串数组（共识中止时为空） */
  winners: string[];
  winningTeam: number;
  /** 参战者快照 [{ seat, playerId, isAI }] */
  participants: Array<{ seat: number; playerId: number | null; isAI: boolean }>;
  /** 共识中止（不结算） */
  aborted: boolean;
}

/** 对局日志（BM7a 回放数据源：GAME_START 首行 + 对局流分页） */
export interface GameLogResult {
  /** 开局负载（旧对局 JSONL 无 GAME_START 首行时为 null → 不可回放） */
  start: import('./protocol.js').GameStartMsg | null;
  events: Array<Record<string, unknown>>;
  /** 0 = 无更多 */
  nextCursor: number;
}
