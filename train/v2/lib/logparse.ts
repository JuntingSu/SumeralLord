// logparse.ts — 对局日志解析与重放（浏览器/Node 通用，无 node 依赖）
import { applyIntent, initState } from '@dl/shared';
import type { GameStartMsg, GameState, PlayerIntent } from '@dl/shared';

export interface ReplayIntent {
  intent: PlayerIntent;
  fromSeat: number;
}

export interface ParsedLogData {
  start: GameStartMsg;
  intents: ReplayIntent[];
}

/** 解析对局日志文本：首行 GAME_START + 其余行意图流（坏行跳过；非 GAME_START 首行 → null） */
export function parseLogText(text: string): ParsedLogData | null {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  let start: GameStartMsg | null = null;
  const intents: ReplayIntent[] = [];
  lines.forEach((line, i) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (i === 0) {
      if (msg.type === 'GAME_START') start = msg as unknown as GameStartMsg;
      return;
    }
    const m = msg as { type?: string; intent?: PlayerIntent; fromSeat?: number };
    if (m.type === 'INTENT_BROADCAST' && m.intent && typeof m.fromSeat === 'number') {
      intents.push({ intent: m.intent, fromSeat: m.fromSeat });
    }
  });
  return start ? { start, intents } : null;
}

/** 重放到第 n 条意图（含），返回静止局面；n 越界裁剪 */
export function replayLog(start: GameStartMsg, intents: ReplayIntent[], n: number): GameState {
  let state = initState({
    map: start.map,
    seatAssignments: start.seatAssignments,
    timeSettings: start.timeSettings,
    seed: start.seed,
  }).state;
  const k = Math.max(0, Math.min(n, intents.length));
  for (let i = 0; i < k; i++) {
    const item = intents[i];
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: item.fromSeat }, intent: item.intent });
    if (r.ok) state = r.state;
  }
  return state;
}
