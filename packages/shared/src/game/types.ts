// 对局核心类型：GameState / 事件（四级）/ reducer 契约（规则 v2 §11）
import type { PlayerIntent, ConsensusPayload } from '../protocol.js';
import type { MapFullData, RoomTimeSettings } from '../types.js';

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
  /** 地图 player_list[].computer；M4 一律按 255=休闲跳过处理（D2 拍板） */
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
  | { level: 4; kind: 'FORCE_CLEAR'; seat: number; reason: 'no_stronghold' | 'surrender' | 'timeout' }
  | { level: 4; kind: 'VICTORY'; winningTeam: number; winners: string[]; losers: string[] };

// ---------- reducer 契约（P5，§11.2） ----------

/** 意图来源：玩家（校验归属）或服务器（断线超时代发投降专用） */
export type Actor = { kind: 'PLAYER'; seat: number } | { kind: 'SERVER' };

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
}

export interface SpawnAssignment {
  seat: number;
  spawnIndex: number;
}

export interface InitStateInput {
  map: MapFullData;
  seatAssignments: SeatAssignment[];
  /** 恒等映射（randomSpawn 洗玩家分配而非出生点，2026-08-16 拍板）；reducer 仅透传签名，不参与演算 */
  spawnAssignments?: SpawnAssignment[];
  timeSettings: RoomTimeSettings;
}

export interface InitStateResult {
  state: GameState;
  chain: GameEvent[];
}
