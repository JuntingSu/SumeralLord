// 对局核心类型：GameState / 事件（四级）/ reducer 契约（规则 v2 §11）
import type { PlayerIntent, ConsensusPayload } from '../protocol.js';
import type { MapFullData, RoomTimeSettings } from '../types.js';
import type { TextPlacement, TriggerDef, TriggerRuntime } from './trigger/types.js';

/** 回合四阶段（§6.1）。PREPARE/END 为自动阶段，静止态只会是 ACTION / ADD_POINT */
export type Phase = 'PREPARE' | 'ACTION' | 'ADD_POINT' | 'END';

/** 兵（§1.2）。owner 取 seat（1..127）或 TILE_OWNER.WILD(0)/BLOCKER(255) */
export interface SoldierState {
  owner: number;
  strength: number;
  /** 连兵 true / 断兵 false */
  isLinked: boolean;
  hasMovement: boolean;
  /** 剩余反击次数（据点为 COUNTER_INFINITE） */
  counter: number;
}

export interface TileState {
  terrain: number;
  soldier: SoldierState | null;
}

/** 势力（§1.3）。exists=false 表示无主势力：开局删兵，等同从未存在（不进轮转/胜负/共识） */
export interface ForceState {
  seat: number;
  team: number;
  name: string;
  flag: number;
  playerId: number | null;
  /** AI 接管（isAI = aiTakeover && playerId===null） */
  isAI: boolean;
  /** 地图 player_list[].computer；难度 1~3 与 255 由 AI 策略层决策（M5 起，当前统一跳过，D3 拍板） */
  computer: number;
  exists: boolean;
  alive: boolean;
  /** 可支配点数 */
  points: number;
}

export interface GameState {
  rows: number;
  columns: number;
  /** 滚筒地图（左右连通） */
  cylindrical: boolean;
  /** 服务器开局下发的随机种子（AI 决策确定性随机源；双端一致） */
  seed: string;
  /** 全局轮次，从 1 起（末位回绕 +1） */
  turn: number;
  currentSeat: number;
  phase: Phase;
  /** 全部势力，按 seat 升序（含已灭与无主 exists=false） */
  forces: ForceState[];
  /** 线性坐标 → 地块，长度 rows*columns，index 0 在左下 */
  tiles: TileState[];
  /** 计时设置透传（reducer 不使用，供前端计时器/重连初始化） */
  timeSettings: RoomTimeSettings;
  finished: boolean;
  /** 获胜玩家 playerId 字符串（对局结束后有效） */
  winners: string[] | null;
  winningTeam: number | null;
  /** 战役模式开关；普通对局 false，行为与既有规则完全一致 */
  triggerMode: boolean;
  /** 触发器运行态；普通对局 null */
  triggerRuntime: TriggerRuntime | null;
  /** 玩家当前扮演的势力；普通对局 null */
  controlledSeat: number | null;
  /** 玩家 userId，用于控制转移写入 playerId；普通对局 null */
  humanPlayerId: number | null;
  /** 势力行动顺序；普通对局为存在势力 seat 升序 */
  turnOrder: number[];
  /** 迷雾覆盖（战役触发器可改）；普通对局 null */
  fogOverrides: { enabled?: boolean; revealed: number[]; hidden: number[] } | null;
  /** 地图触发器定义（普通对局空数组）；执行受 triggerMode 控制 */
  triggers: TriggerDef[];
}

// ---------- 事件（§7 四级全集） ----------

/** 一级：玩家发起；二级：兵操作；三级：连断修复；四级：清除/胜负（§11.2） */
export type GameEvent =
  // 一级
  | { level: 1; kind: 'MOVE'; from: number; to: number }
  | { level: 1; kind: 'ATTACK'; from: number; to: number }
  | { level: 1; kind: 'SURRENDER'; seat: number; reason: 'voluntary' | 'timeout' }
  | { level: 1; kind: 'SWITCH_PHASE'; seat: number; from: Phase; to: Phase }
  | { level: 1; kind: 'END_TURN'; fromSeat: number; toSeat: number; turn: number }
  | { level: 1; kind: 'INIT' }
  | { level: 1; kind: 'ADD_POINT'; seat: number; coordinate: number; amount: number }
  // 二级
  | { level: 2; kind: 'SPAWN'; tile: number; soldier: SoldierState }
  | { level: 2; kind: 'UPDATE'; tile: number; before: SoldierState; after: SoldierState }
  | { level: 2; kind: 'DESPAWN'; tile: number; soldier: SoldierState }
  // 三级
  | { level: 3; kind: 'REJOIN'; tile: number }
  | { level: 3; kind: 'BREAK'; tile: number; branches: number[] }
  // 四级
  | { level: 4; kind: 'BREAK_JUDGE'; tile: number; connected: boolean; region: number[] }
  | { level: 4; kind: 'FORCE_CLEAR'; seat: number; reason: 'no_stronghold' | 'surrender' | 'timeout' | 'trigger' }
  | { level: 4; kind: 'VICTORY'; winningTeam: number; winners: string[]; losers: string[] }
  // 五级：触发器系统（棋盘变化仍走二级/四级事件，以下用于 UI/日志/控制流）
  | { level: 5; kind: 'TRIGGER_FIRE'; triggerId: string }
  | { level: 5; kind: 'TRIGGER_TEXT_SHOW'; textId: string; text: string; placement?: TextPlacement }
  | { level: 5; kind: 'TRIGGER_TEXT_HIDE'; textId: string }
  | { level: 5; kind: 'TERRAIN_CHANGE'; tile: number; from: number; to: number }
  | { level: 5; kind: 'FORCE_UPDATE'; seat: number; patch: Record<string, unknown> }
  | { level: 5; kind: 'CONTROL_CHANGE'; fromSeat: number | null; toSeat: number | null; aiLevel: number }
  | { level: 5; kind: 'TURN_ORDER_CHANGE'; order: number[] }
  | {
      level: 5;
      kind: 'FOG_CHANGE';
      overrides: { enabled?: boolean; revealed: number[]; hidden: number[] } | null;
    }
  | { level: 5; kind: 'TRIGGER_OVERFLOW'; transactionSeq: number };

// ---------- reducer 契约（P5，§11.2） ----------

/** 意图来源：玩家、AI 规划/托管或服务器（断线超时代发投降专用） */
export type Actor =
  | { kind: 'PLAYER'; seat: number }
  | { kind: 'AI'; seat: number }
  | { kind: 'SERVER' };

export interface IntentEnvelope {
  actor: Actor;
  intent: PlayerIntent;
}

export type RejectReason =
  | 'NOT_YOUR_TURN'
  | 'WRONG_PHASE'
  | 'ILLEGAL_MOVE'
  | 'ILLEGAL_ATTACK'
  | 'NO_POINTS'
  | 'SEAT_CLEARED'
  | 'OUT_OF_BOUNDS'
  | 'NO_GAME';

/** 演算到共识节点时同步产出的上报任务（§11.3；consensusId 由调用方拼接 eventId 组成） */
export interface ConsensusReport {
  payload: ConsensusPayload;
  /** FORCE_CLEAR 受影响 seat；VICTORY 恒 0（consensusId 尾段） */
  nodeSeat: number;
}

export type ApplyResult =
  | { ok: true; state: GameState; chain: GameEvent[]; consensus: ConsensusReport[] }
  | { ok: false; state: GameState; reason: RejectReason };

// ---------- 开局 ----------

export interface SeatAssignment {
  seat: number;
  playerId: number | null;
  isAI: boolean;
  /** AI 难度覆盖（房主为势力指定；缺省用地图 player_list[].computer） */
  computer?: number;
}

export interface SpawnAssignment {
  seat: number;
  spawnIndex: number;
}

export interface InitStateInput {
  map: MapFullData;
  seatAssignments: SeatAssignment[];
  /** 随机种子（GAME_START.seed 透传；AI 决策与确定性随机使用，双端一致） */
  seed: string;
  /** 恒等映射（randomSpawn 洗玩家分配而非出生点，2026-08-16 拍板）；reducer 仅透传签名，不参与演算 */
  spawnAssignments?: SpawnAssignment[];
  timeSettings: RoomTimeSettings;
  /** 战役触发器模式；缺省 false（普通对局） */
  triggerMode?: boolean;
  /** 战役玩家当前扮演势力；缺省取 seatAssignments 中的真人势力 */
  controlledSeat?: number;
  /** 战役玩家 userId；控制转移写入 playerId 用 */
  humanPlayerId?: number;
}

export interface InitStateResult {
  state: GameState;
  chain: GameEvent[];
}
