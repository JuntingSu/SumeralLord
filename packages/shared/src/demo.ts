// 演示回放文件契约：初态 GameState + 逐步意图。前后端共用同一份校验。
// 回放不依赖地图文件或服务器对局日志，initialState 自包含全部棋盘/势力/触发器信息。
import { PlayerIntentSchema } from './protocol.js';
import type { PlayerIntent } from './protocol.js';
import type { GameState } from './game/types.js';

export const DEMO_REPLAY_VERSION = 1;

export interface DemoReplayStep {
  /** 该步由哪个势力发起（MOVE/ATTACK/ADD_POINT/SWITCH_PHASE 本身不带 seat） */
  seat: number;
  intent: PlayerIntent;
}

export interface DemoReplayFile {
  version: typeof DEMO_REPLAY_VERSION;
  type: 'demo-replay';
  /** 生成时的 reducer 版本，用于回放时提示兼容性 */
  reducerVersion: string;
  createdAt: string;
  mapTitle: string;
  /** 初态：initState 完成、任何玩家意图之前 */
  initialState: GameState;
  /** 仅记录被 reducer 接受且尚未撤销的意图 */
  steps: DemoReplayStep[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** 只做结构与关键字段校验；逐地块深校验由 reducer 在回放时自然承担 */
export function validateDemoReplayFile(raw: unknown): raw is DemoReplayFile {
  if (!isRecord(raw)) return false;
  if (raw.version !== DEMO_REPLAY_VERSION) return false;
  if (raw.type !== 'demo-replay') return false;
  if (typeof raw.reducerVersion !== 'string') return false;
  if (typeof raw.createdAt !== 'string') return false;
  if (typeof raw.mapTitle !== 'string') return false;

  const state = raw.initialState;
  if (!isRecord(state)) return false;
  if (!isInt(state.rows) || !isInt(state.columns)) return false;
  if (state.rows <= 0 || state.columns <= 0) return false;
  if (!Array.isArray(state.tiles) || state.tiles.length !== state.rows * state.columns) return false;
  if (!Array.isArray(state.forces) || state.forces.length === 0) return false;
  if (!Array.isArray(state.turnOrder)) return false;
  if (typeof state.currentSeat !== 'number' || typeof state.turn !== 'number') return false;
  if (typeof state.phase !== 'string') return false;
  if (typeof state.finished !== 'boolean') return false;

  if (!Array.isArray(raw.steps)) return false;
  for (const step of raw.steps) {
    if (!isRecord(step)) return false;
    if (!isInt(step.seat) || step.seat < 1 || step.seat > 127) return false;
    if (!PlayerIntentSchema.safeParse(step.intent).success) return false;
  }
  return true;
}
