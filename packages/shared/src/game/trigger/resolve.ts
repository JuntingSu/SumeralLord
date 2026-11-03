// 触发器中的势力引用解析：数字 seat、当前玩家势力、玩家行动顺序中的下一个存活势力。
import type { GameState } from '../types.js';
import type { TriggerForceRef, TriggerSpawnForceRef } from './types.js';

/** 当前玩家控制势力；缺省回退当前行动势力（单人战役总是有 controlledSeat） */
export function playerForce(state: GameState): number | null {
  return state.controlledSeat ?? state.currentSeat;
}

export function resolveForceRef(state: GameState, ref: TriggerForceRef): number | null {
  if (typeof ref === 'number') return ref;
  return playerForce(state);
}

/** 玩家行动顺序中的下一个存活势力（跳过已灭亡势力；1v1 即对手） */
export function nextAfterPlayer(state: GameState): number | null {
  const player = playerForce(state);
  if (player === null) return null;
  const alive = new Set(state.forces.filter((f) => f.exists && f.alive).map((f) => f.seat));
  const order = state.turnOrder.filter((s) => alive.has(s));
  if (order.length <= 1) return null;
  const idx = order.indexOf(player);
  if (idx < 0) return order.find((s) => s !== player) ?? null;
  for (let i = 1; i < order.length; i++) {
    const seat = order[(idx + i) % order.length];
    if (seat !== player) return seat;
  }
  return null;
}

export function resolveSpawnForceRef(state: GameState, ref: TriggerSpawnForceRef): number | null {
  if (ref === 'next_after_player') return nextAfterPlayer(state);
  return resolveForceRef(state, ref);
}
