// 协议常量：前后端单一事实来源（《数字领主-前端接口需求声明.md》v1.1）

export const ERROR_CODES = {
  AUTH_FAILED: 'AUTH_FAILED',
  INVALID_PARAMS: 'INVALID_PARAMS',
  USERNAME_TAKEN: 'USERNAME_TAKEN',
  RATE_LIMITED: 'RATE_LIMITED',

  ROOM_FULL: 'ROOM_FULL',
  PASSWORD_WRONG: 'PASSWORD_WRONG',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_DISBANDED: 'ROOM_DISBANDED',
  MAP_NOT_FOUND: 'MAP_NOT_FOUND',
  ALREADY_IN_ROOM: 'ALREADY_IN_ROOM',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  SPECTATE_NOT_ALLOWED: 'SPECTATE_NOT_ALLOWED',
  GAME_IN_PROGRESS: 'GAME_IN_PROGRESS',
  FORCE_TAKEN: 'FORCE_TAKEN',
  FORCE_NOT_SELECTED: 'FORCE_NOT_SELECTED',
  /** 势力已由房主指定 AI 难度（AI 专属），玩家不可选取 */
  FORCE_AI_LOCKED: 'FORCE_AI_LOCKED',
  /** 势力已被玩家占据，需先移出才能指定 AI 难度 */
  FORCE_OCCUPIED: 'FORCE_OCCUPIED',
  /** 未开启 AI 接管，不能为势力指定 AI 难度 */
  AI_TAKEOVER_OFF: 'AI_TAKEOVER_OFF',
  NOT_HOST: 'NOT_HOST',
  PLAYERS_NOT_READY: 'PLAYERS_NOT_READY',
  SEATS_UNASSIGNED: 'SEATS_UNASSIGNED',
  AI_NOT_SUPPORTED: 'AI_NOT_SUPPORTED',
  SPECTATOR_LIMIT: 'SPECTATOR_LIMIT',
  SPECTATOR_CANNOT_ACT: 'SPECTATOR_CANNOT_ACT',
  INVALID_INTENT: 'INVALID_INTENT',
  EVENT_GAP: 'EVENT_GAP',
  CONSENSUS_MISMATCH: 'CONSENSUS_MISMATCH',
  CONSENSUS_TIMEOUT: 'CONSENSUS_TIMEOUT',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  ROOM_DISBANDED_IDLE: 'ROOM_DISBANDED_IDLE',
  ROOM_DISBANDED_GAME_TIMEOUT: 'ROOM_DISBANDED_GAME_TIMEOUT',
  RECONNECT_FAILED: 'RECONNECT_FAILED',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const WS_CLOSE_CODES = {
  TICKET_INVALID: 4001,
  ROOM_NOT_FOUND: 4002,
  VERSION_MISMATCH: 4003,
  ROOM_FULL: 4004,
  SPECTATOR_LIMIT: 4005,
  DUPLICATE_CONNECTION: 4006,
  SEAT_INVALID: 4007,
} as const;

export const AUTH = {
  JWT_EXPIRES_IN: '7d',
  TICKET_TTL_MS: 5 * 60 * 1000,
  BCRYPT_COST: 10,
  LOGIN_RATE_PER_MIN: 10,
  REGISTER_RATE_PER_MIN: 5,
} as const;

export const CHAT = {
  MAX_LENGTH: 200,
} as const;

export const ROOMS = {
  /** 房间空闲自动解散（仅 waiting 房间） */
  IDLE_MS: 30 * 60 * 1000,
  /** 空闲扫描间隔 */
  SWEEP_INTERVAL_MS: 5 * 60 * 1000,
  /** 观战人数上限 */
  SPECTATOR_LIMIT: 8,
  /** 房间名长度 */
  NAME_MIN: 1,
  NAME_MAX: 20,
} as const;

/** 计时三件套的可选项与默认值（前后端单一来源，schema 按此枚举校验） */
export const TIME_OPTIONS = {
  stepTime: [15, 30, 45, 60, 90, 120, 180, 300],
  gameTime: [300, 600, 1200, 1800, 2400, 3600],
  additionalTime: [0, 5, 10, 15, 30, 60],
} as const;

export const TIME_DEFAULTS = {
  stepTime: 90,
  gameTime: 1200,
  additionalTime: 0,
} as const;

export const GAME = {
  /** 全票共识收齐超时（超时即中止对局，不推进） */
  CONSENSUS_TIMEOUT_MS: 5 * 1000,
  /** 参战玩家断线多久后推 PLAYER_DISCONNECT 并剔出共识期望集合 */
  DISCONNECT_DETECT_MS: 10 * 1000,
  /** 断线宽限期，超过即由服务器代发投降意图 */
  DISCONNECT_GRACE_MS: 120 * 1000,
  /** 对局硬上限 */
  GAME_HARD_CAP_MS: 4 * 60 * 60 * 1000,
  /** 活动 seat 计时同步频率 */
  TIME_SYNC_INTERVAL_MS: 5 * 1000,
  /** 对局流重连分页大小 */
  EVENTS_PAGE_LIMIT: 500,
} as const;

/** AI 难度档位（取值同地图 player_list[].computer）。255=休闲：reducer 内建轮到即跳过（D1 拍板）；1~3 在 M5 起由 AI 策略层决策（v1 统一按 255 跳过，D3 拍板） */
export const AI_LEVEL = {
  EASY: 1,
  MEDIUM: 2,
  HARD: 3,
  LEISURE: 255,
} as const;

/** AI 难度中文标签（房间势力 AI 徽标等展示用） */
export const AI_LEVEL_LABEL: Record<number, string> = {
  [AI_LEVEL.EASY]: '简单',
  [AI_LEVEL.MEDIUM]: '普通',
  [AI_LEVEL.HARD]: '困难',
  [AI_LEVEL.LEISURE]: '休闲',
};
