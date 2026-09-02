// REST 请求体 / WS 消息的 Zod schema：前后端共享的协议契约
import { z } from 'zod';
import { TIME_OPTIONS } from './constants.js';
import type { MapFullData, RoomData, RoomPlayer } from './types.js';
import type { SeatAssignment, SpawnAssignment } from './game/types.js';

const oneOf = (options: readonly number[], label: string) =>
  z
    .number()
    .int()
    .refine((v) => options.includes(v), { message: `${label}仅允许 ${options.join('/')} 秒` });

const StepTimeSchema = oneOf(TIME_OPTIONS.stepTime, '步时');
const GameTimeSchema = oneOf(TIME_OPTIONS.gameTime, '局时');
const AdditionalTimeSchema = oneOf(TIME_OPTIONS.additionalTime, '加时');

const TimeSettingsSchema = z.object({
  stepTime: StepTimeSchema,
  gameTime: GameTimeSchema,
  additionalTime: AdditionalTimeSchema,
});
export type RoomTimeSettingsBody = z.infer<typeof TimeSettingsSchema>;

// ---------- REST：认证 ----------

export const RegisterBodySchema = z.object({
  username: z.string().min(3).max(20),
  password: z.string().min(6).max(32),
});
export type RegisterBody = z.infer<typeof RegisterBodySchema>;

export const LoginBodySchema = z.object({
  username: z.string().min(1).max(20),
  password: z.string().min(1).max(32),
});
export type LoginBody = z.infer<typeof LoginBodySchema>;

// ---------- REST：个人资料 / 皮肤 ----------

/** 修改用户名 / 密码（改密码必须带 oldPassword 且正确；username 与 newPassword 至少一项） */
export const UpdateProfileBodySchema = z
  .object({
    username: z.string().min(3).max(20).optional(),
    oldPassword: z.string().min(1).max(32).optional(),
    newPassword: z.string().min(6).max(32).optional(),
  })
  .refine((b) => b.username !== undefined || b.newPassword !== undefined, {
    message: '至少提供一项要修改的内容',
  });
export type UpdateProfileBody = z.infer<typeof UpdateProfileBodySchema>;

/** 皮肤上传：solid/hollow 各为一张 192×216 RGBA PNG 的 base64（data URL 或裸 base64） */
export const SkinUploadBodySchema = z.object({
  solid: z.string().min(1).max(4_000_000),
  hollow: z.string().min(1).max(4_000_000),
});
export type SkinUploadBody = z.infer<typeof SkinUploadBodySchema>;

// ---------- REST：房间管理（BM2） ----------

export const CreateRoomBodySchema = z.object({
  name: z.string().min(1).max(20),
  password: z.string().min(1).max(32).optional(),
  allowSpectate: z.boolean(),
  fogMode: z.boolean(),
  randomSpawn: z.boolean(),
  aiTakeover: z.boolean().optional(),
  usePersonalSkin: z.boolean().optional(),
  mapId: z.string().min(1),
  timeSettings: TimeSettingsSchema,
});
export type CreateRoomBody = z.infer<typeof CreateRoomBodySchema>;

export const JoinRoomBodySchema = z.object({
  password: z.string().optional(),
  asSpectator: z.boolean().default(false),
});
export type JoinRoomBody = z.infer<typeof JoinRoomBodySchema>;

export const RoomSettingsPatchSchema = z.object({
  name: z.string().min(1).max(20).optional(),
  password: z.string().min(1).max(32).nullable().optional(), // null = 清除密码
  allowSpectate: z.boolean().optional(),
  fogMode: z.boolean().optional(),
  randomSpawn: z.boolean().optional(),
  aiTakeover: z.boolean().optional(),
  usePersonalSkin: z.boolean().optional(),
  timeSettings: TimeSettingsSchema.optional(),
});
export type RoomSettingsPatch = z.infer<typeof RoomSettingsPatchSchema>;

export const KickBodySchema = z.object({ playerId: z.number().int().positive() });
export type KickBody = z.infer<typeof KickBodySchema>;

export const TransferHostBodySchema = z.object({ toPlayerId: z.number().int().positive() });
export type TransferHostBody = z.infer<typeof TransferHostBodySchema>;

export const ChangeMapBodySchema = z.object({ mapId: z.string().min(1) });
export type ChangeMapBody = z.infer<typeof ChangeMapBodySchema>;

export const ReadyBodySchema = z.object({ ready: z.boolean() });
export type ReadyBody = z.infer<typeof ReadyBodySchema>;

export const SelectForceBodySchema = z.object({ seat: z.number().int().min(-1).max(127) });
export type SelectForceBody = z.infer<typeof SelectForceBodySchema>;

/** 房主将某势力上的玩家移出（seat 为势力座次，非 -1） */
export const ForceRemoveBodySchema = z.object({ seat: z.number().int().min(0).max(127) });
export type ForceRemoveBody = z.infer<typeof ForceRemoveBodySchema>;

// ---------- WS 房间阶段（BM3）：客户端 → 服务器 ----------

export const ChatSendSchema = z.object({
  type: z.literal('CHAT'),
  text: z.string().min(1),
});
export type ChatSendMsg = z.infer<typeof ChatSendSchema>;

export interface PingMsg {
  type: 'PING';
}

export type RoomClientMsg =
  | PingMsg
  | ChatSendMsg
  | z.infer<typeof IntentSubmitSchema>
  | z.infer<typeof ConsensusResultSchema>
  | z.infer<typeof ReconnectMsgSchema>
  | z.infer<typeof TimeSyncMsgSchema>
  | z.infer<typeof SettlementDismissedSchema>;

// ---------- WS 房间阶段（BM3）：服务器 → 客户端 ----------

export interface ConnectAckMsg {
  type: 'CONNECT_ACK';
  roomId: string;
  /** 对局进行中时携带：当前对局与已发生 eventId（前端据此决定重连重放） */
  gameId?: string;
  lastEventId?: number;
}

export interface PongMsg {
  type: 'PONG';
}

export interface ChatMsg {
  type: 'CHAT';
  roomId: string;
  from: number; // 发送者 userId
  username: string;
  text: string;
  ts: number;
}

export interface PlayerJoinMsg {
  type: 'PLAYER_JOIN';
  roomId: string;
  player: RoomPlayer;
}

export interface PlayerLeaveMsg {
  type: 'PLAYER_LEAVE';
  roomId: string;
  playerId: number;
  newHostId?: number;
}

export interface PlayerReadyMsg {
  type: 'PLAYER_READY';
  roomId: string;
  playerId: number;
  ready: boolean;
}

export interface HostTransferMsg {
  type: 'HOST_TRANSFER';
  roomId: string;
  newHostId: number;
}

export interface RoomUpdateMsg {
  type: 'ROOM_UPDATE';
  roomId: string;
  room: RoomData;
}

export interface ForceSelectMsg {
  type: 'FORCE_SELECT';
  roomId: string;
  seat: number;
  playerId: number | null;
}

export interface RoomDisbandedMsg {
  type: 'ROOM_DISBANDED';
  roomId: string;
  reason: 'host_disband' | 'idle_timeout' | 'game_timeout';
}

export interface ErrorMsg {
  type: 'ERROR';
  code: string;
  message: string;
  fatal: boolean;
}

export type RoomServerMsg =
  | ConnectAckMsg
  | PongMsg
  | ChatMsg
  | PlayerJoinMsg
  | PlayerLeaveMsg
  | PlayerReadyMsg
  | HostTransferMsg
  | RoomUpdateMsg
  | ForceSelectMsg
  | RoomDisbandedMsg
  | ErrorMsg
  // 对局开始（广播；不带 eventId，但前端据此初始化本地对局状态）
  | GameStartMsg
  // 对局流消息（带 eventId，需按序应用/重放）
  | IntentAckMsg
  | IntentBroadcastMsg
  | ConsensusConfirmedMsg
  | GameOverMsg
  // 对局会话消息（不带 eventId）
  | TimeSyncMsg
  | PlayerDisconnectMsg
  | PlayerReconnectMsg
  | ReconnectAckMsg;

/** RoomManager 状态变更事件（WS 网关广播源） */
export type RoomManagerEvent =
  | Exclude<RoomServerMsg, ConnectAckMsg | PongMsg | ChatMsg | ErrorMsg | IntentAckMsg | TimeSyncMsg | PlayerDisconnectMsg | PlayerReconnectMsg | ReconnectAckMsg | IntentBroadcastMsg | ConsensusConfirmedMsg | GameOverMsg>
  | GameStartMsg;

// ---------- 对局：意图（P1） ----------

export const PlayerIntentSchema = z.discriminatedUnion('intentType', [
  z.object({
    intentType: z.literal('MOVE'),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
  }),
  z.object({
    intentType: z.literal('ATTACK'),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
  }),
  z.object({
    intentType: z.literal('ADD_POINT'),
    coordinate: z.number().int().nonnegative(),
    amount: z.number().int().positive(),
  }),
  z.object({ intentType: z.literal('SWITCH_PHASE') }),
  z.object({
    intentType: z.literal('SURRENDER'),
    seat: z.number().int().positive(),
    reason: z.enum(['voluntary', 'timeout']).optional(),
  }),
]);
export type PlayerIntent = z.infer<typeof PlayerIntentSchema>;

// ---------- 对局：共识（P2） ----------

export const ConsensusPayloadSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('FORCE_CLEAR'),
    seat: z.number().int().positive(),
    reason: z.enum(['no_stronghold', 'surrender', 'timeout']),
  }),
  z.object({
    kind: z.literal('VICTORY'),
    winningTeam: z.number().int(),
    winners: z.array(z.string()),
    losers: z.array(z.string()),
  }),
]);
export type ConsensusPayload = z.infer<typeof ConsensusPayloadSchema>;

/** consensusId 严格格式：{触发意图eventId}:{nodeType}:{受影响seat} */
export const CONSENSUS_ID_PATTERN = /^\d+:(force_clear|victory):\d+$/;

/**
 * 非意图消息的独立序号（refId）：不占用意图 eventId 整数序列，避免在意图流中制造空洞。
 * 格式：共识 = "{触发意图eventId}*"（对 N 号意图的共识）；终局 = "end"。
 */
export const consensusRefId = (triggerEventId: number): string => `${triggerEventId}*`;
export const GAME_OVER_REF_ID = 'end';

// ---------- WS 客户端 → 服务器 ----------

export const IntentSubmitSchema = z.object({
  type: z.literal('INTENT_SUBMIT'),
  clientTempId: z.string().min(1).max(64),
  intent: PlayerIntentSchema,
});

export const ConsensusResultSchema = z.object({
  type: z.literal('CONSENSUS_RESULT'),
  consensusId: z.string().regex(CONSENSUS_ID_PATTERN),
  result: ConsensusPayloadSchema,
});

export const ReconnectMsgSchema = z.object({
  type: z.literal('RECONNECT'),
  lastEventId: z.number().int().nonnegative(),
  gameId: z.string().min(1),
});

export const TimeSyncMsgSchema = z.object({
  type: z.literal('TIME_SYNC'),
  gameId: z.string().min(1),
  seat: z.number().int().positive(),
  stepTimeRemain: z.number().int().nonnegative(),
  gameTimeRemain: z.number().int().nonnegative(),
  ts: z.number().int(),
});

/** 结算页已关闭（对局结束后客户端上报；全部参战玩家关闭后房间立即回落 ROOM_OPEN，不等保留期） */
export const SettlementDismissedSchema = z.object({
  type: z.literal('SETTLEMENT_DISMISSED'),
  gameId: z.string().min(1),
});
export type SettlementDismissedMsg = z.infer<typeof SettlementDismissedSchema>;

// ---------- WS 服务器 → 客户端（结构声明，供前端类型使用） ----------

export interface IntentBroadcastMsg {
  type: 'INTENT_BROADCAST';
  from: string; // playerId 或 'SERVER'（代发投降专用）
  fromSeat: number;
  intent: PlayerIntent;
  eventId: number;
}

export interface IntentAckMsg {
  type: 'INTENT_ACK';
  clientTempId: string;
  eventId: number;
}

export interface ConsensusConfirmedMsg {
  type: 'CONSENSUS_CONFIRMED';
  consensusId: string;
  confirmed: ConsensusPayload;
  /** 非意图独立序号："{触发意图eventId}*"（不占用意图 eventId 序列） */
  refId: string;
}

/** 对局结束时各势力会话结果（服务器会话账本，非游戏演算；前端结算以本地 reducer 状态为准） */
export interface ForceResult {
  seat: number;
  playerId: string | null;
  isAI: boolean;
  /** 对局中已确认清除（投降/清除共识确认过） */
  cleared: boolean;
}

export interface GameOverMsg {
  type: 'GAME_OVER';
  gameId: string;
  winners: string[];
  winningTeam: number;
  forces: ForceResult[];
  /** 非意图独立序号：终局固定 "end"（不占用意图 eventId 序列） */
  refId: string;
}

export interface TimeSyncMsg {
  type: 'TIME_SYNC';
  gameId: string;
  seat: number;
  stepTimeRemain: number;
  gameTimeRemain: number;
  ts: number;
}

export interface PlayerDisconnectMsg {
  type: 'PLAYER_DISCONNECT';
  gameId: string;
  seat: number;
  at: number;
}

export interface PlayerReconnectMsg {
  type: 'PLAYER_RECONNECT';
  gameId: string;
  seat: number;
}

export interface ReconnectAckMsg {
  type: 'RECONNECT_ACK';
  gameId: string;
  lastEventId: number;
  /** 本次直发批（≤500）；续批走 GET /api/game/:gameId/events?after= 拉取 */
  batch: Array<Record<string, unknown>>;
  nextBatchCursor?: number;
}

// ---------- 对局：开局（P4：不带 initialBoardState，带随机源） ----------
// SeatAssignment / SpawnAssignment 定义于 game/types.ts（开局构造同源使用）

export interface GameStartMsg {
  type: 'GAME_START';
  roomId: string;
  gameId: string;
  map: MapFullData;
  seatAssignments: SeatAssignment[];
  spawnAssignments: SpawnAssignment[];
  seed: string;
  timeSettings: { stepTime: number; gameTime: number; additionalTime: number };
  reducerVersion: string;
}
