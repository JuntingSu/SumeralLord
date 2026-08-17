// REST 请求体 / WS 消息的 Zod schema：前后端共享的协议契约
import { z } from 'zod';
import { TIME_OPTIONS } from './constants.js';
import type { RoomData, RoomPlayer } from './types.js';

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

// ---------- REST：房间管理（BM2） ----------

export const CreateRoomBodySchema = z.object({
  name: z.string().min(1).max(20),
  password: z.string().min(1).max(32).optional(),
  allowSpectate: z.boolean(),
  fogMode: z.boolean(),
  randomSpawn: z.boolean(),
  aiTakeover: z.boolean().optional(),
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

// ---------- WS 房间阶段（BM3）：客户端 → 服务器 ----------

export const ChatSendSchema = z.object({
  type: z.literal('CHAT'),
  text: z.string().min(1),
});
export type ChatSendMsg = z.infer<typeof ChatSendSchema>;

export interface PingMsg {
  type: 'PING';
}

export type RoomClientMsg = PingMsg | ChatSendMsg;

// ---------- WS 房间阶段（BM3）：服务器 → 客户端 ----------

export interface ConnectAckMsg {
  type: 'CONNECT_ACK';
  roomId: string;
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
  reason: 'host_disband' | 'idle_timeout';
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
  | ErrorMsg;

/** RoomManager 状态变更事件（WS 网关广播源） */
export type RoomManagerEvent = Exclude<RoomServerMsg, ConnectAckMsg | PongMsg | ChatMsg | ErrorMsg>;

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
  eventId: number;
}
