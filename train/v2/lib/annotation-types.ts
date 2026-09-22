// annotation-types.ts — 标注/偏好题共享类型（纯类型，浏览器与 Node 通用，无 node 依赖）
import type { GameState, PlayerIntent } from '@dl/shared';

// ---------- 标注文件格式（决策定稿 §9 修订版 §二） ----------

export interface DemoFile {
  id: string;
  kind: 'demo' | 'correction';
  createdAt?: string;
  sourceGameId: string;
  seat: number;
  turnStartEventId: number;
  startEventId: number;
  intents: PlayerIntent[];
  /** 仅 correction：AI 在该位置的实际动作 */
  aiAction?: PlayerIntent | null;
  note?: string;
}

export interface PrefSideRef {
  sourceGameId: string;
  eventId: number;
  seat: number;
}

export type PrefLabel = 'a' | 'b' | 'both_bad' | 'unknown';

export type PrefFile =
  | {
      id: string;
      kind: 'position';
      createdAt?: string;
      a: PrefSideRef;
      b: PrefSideRef;
      label: PrefLabel;
      note?: string;
    }
  | {
      id: string;
      kind: 'action';
      createdAt?: string;
      sourceGameId: string;
      eventId: number;
      seat: number;
      actionA: PlayerIntent;
      actionB: PlayerIntent;
      label: PrefLabel;
      note?: string;
    };

// ---------- 偏好题（抽样器产物 / 判题工作台消费） ----------

export interface QuestionRef {
  sourceGameId: string;
  eventId: number;
  seat: number;
}

export type Question =
  | { kind: 'position'; a: QuestionRef; b: QuestionRef }
  | { kind: 'action'; sourceGameId: string; eventId: number; seat: number; actionA: PlayerIntent; actionB: PlayerIntent };

export interface PairsFile {
  id: string;
  createdAt?: string;
  questions: Question[];
}

// ---------- 转换产物（训练侧消费） ----------

/** 训练侧偏好样本（JSONL 行） */
export interface PrefSample {
  id: string;
  label: Exclude<PrefLabel, 'unknown'>;
  a: { cls: number[]; tiles: number[][]; rows: number; columns: number; seat: number };
  b: { cls: number[]; tiles: number[][]; rows: number; columns: number; seat: number };
}

/** 示范训练样本（JSONL 行；π = 人类动作 one-hot；z 恒 0，价值项不计） */
export interface DemoSample {
  gameId: string;
  mapId: string;
  turn: number;
  seat: number;
  phase: string;
  nTiles: number;
  rows: number;
  columns: number;
  cls: number[];
  tiles: number[][];
  pi: [number, number][];
  z: 0;
}

/** 动作文字摘要（判题工作台展示用；纯函数） */
export function intentToText(intent: PlayerIntent, state?: GameState): string {
  const rc = (tile: number): string => {
    if (!state) return `#${tile}`;
    const c = state.columns;
    return `(${Math.floor(tile / c)},${tile % c})`;
  };
  switch (intent.intentType) {
    case 'MOVE':
      return `移动 ${rc(intent.from)} → ${rc(intent.to)}`;
    case 'ATTACK':
      return `进攻 ${rc(intent.from)} → ${rc(intent.to)}`;
    case 'ADD_POINT':
      return `加点 +${intent.amount} @ ${rc(intent.coordinate)}`;
    case 'SWITCH_PHASE':
      return '切换阶段';
    default:
      return JSON.stringify(intent);
  }
}
