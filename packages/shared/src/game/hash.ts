// 稳定序列化 + FNV-1a 哈希：黄金样本跨端比对用（确定性：键排序、数组保序、整数运算）
import type { GameState } from './types.js';

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map((v) => stableStringify(v)).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/** FNV-1a 32 位，返回 8 位十六进制 */
export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** GameState 摘要哈希（用于双端 boardState 一致性比对） */
export function hashGameState(state: GameState): string {
  const core = {
    rows: state.rows,
    columns: state.columns,
    cylindrical: state.cylindrical,
    turn: state.turn,
    currentSeat: state.currentSeat,
    phase: state.phase,
    finished: state.finished,
    winners: state.winners,
    winningTeam: state.winningTeam,
    forces: state.forces.map((f) => [f.seat, f.team, f.playerId, f.isAI, f.exists, f.alive, f.points]),
    tiles: state.tiles.map((t) => (t.soldier ? [t.terrain, t.soldier.owner, t.soldier.strength, t.soldier.isLinked ? 1 : 0, t.soldier.hasMovement ? 1 : 0, t.soldier.counter] : [t.terrain, -1])),
  };
  return fnv1a(stableStringify(core));
}
