// 触发器条件求值：动作条件读增量 diff + 当前状态；回合条件读单个阶段-回合转换 + 当前状态。
import type { GameState } from '../types.js';
import type { TriggerCondition, TriggerDelta, WorldTransition } from './types.js';
import { resolveForceRef } from './resolve.js';

function tileOf(delta: TriggerDelta, index: number) {
  return delta.tiles.find((t) => t.index === index);
}

function forceOf(delta: TriggerDelta, seat: number) {
  return delta.forces.find((f) => f.seat === seat);
}

/** 动作类条件；world 叶子在动作事务中不匹配 */
export function matchActionCondition(
  cond: TriggerCondition,
  delta: TriggerDelta,
  fired: ReadonlySet<string>,
  state: GameState,
): boolean {
  switch (cond.op) {
    case 'and':
      return cond.items.every((item) => matchActionCondition(item, delta, fired, state));
    case 'or':
      return cond.items.some((item) => matchActionCondition(item, delta, fired, state));
    case 'not':
      return !matchActionCondition(cond.item, delta, fired, state);
    case 'tile_owner_appeared': {
      const force = resolveForceRef(state, cond.force);
      if (force === null) return false;
      const t = tileOf(delta, cond.tile);
      if (!t) return false;
      return t.before.soldier?.owner !== force && t.after.soldier?.owner === force;
    }
    case 'tile_emptied': {
      const t = tileOf(delta, cond.tile);
      if (!t) return false;
      return t.before.soldier !== null && t.after.soldier === null;
    }
    case 'tile_owner_changed': {
      const to = resolveForceRef(state, cond.to);
      if (to === null) return false;
      const from = cond.from === undefined ? null : resolveForceRef(state, cond.from);
      if (cond.from !== undefined && from === null) return false;
      const t = tileOf(delta, cond.tile);
      if (!t) return false;
      const before = t.before.soldier;
      const after = t.after.soldier;
      if (!before || !after || before.owner === after.owner || after.owner !== to) return false;
      return cond.from === undefined || before.owner === from;
    }
    case 'force_gone': {
      const force = resolveForceRef(state, cond.force);
      if (force === null) return false;
      const f = forceOf(delta, force);
      if (!f) return false;
      return f.before.alive && !f.after.alive;
    }
    case 'tile_soldier_owner_not': {
      const force = resolveForceRef(state, cond.force);
      if (force === null) return false;
      return state.tiles[cond.tile]?.soldier?.owner !== force;
    }
    case 'trigger_fired':
      return fired.has(cond.trigger_id);
    case 'trigger_done':
      return (state.triggerRuntime?.firedCounts[cond.trigger_id] ?? 0) > 0;
    case 'phase_start':
    case 'phase_end':
    case 'turn_start':
      return false;
  }
}

/** 回合类条件；对单个转换求值，action 叶子在回合事务中不匹配 */
export function matchWorldCondition(
  cond: TriggerCondition,
  tx: WorldTransition,
  fired: ReadonlySet<string>,
  state: GameState,
): boolean {
  switch (cond.op) {
    case 'and':
      return cond.items.every((item) => matchWorldCondition(item, tx, fired, state));
    case 'or':
      return cond.items.some((item) => matchWorldCondition(item, tx, fired, state));
    case 'not':
      return !matchWorldCondition(cond.item, tx, fired, state);
    case 'phase_start': {
      const force = resolveForceRef(state, cond.force);
      if (force === null) return false;
      return (
        tx.kind === 'PHASE_START' &&
        tx.seat === force &&
        tx.phase === cond.phase &&
        (cond.turn === undefined || tx.turn === cond.turn)
      );
    }
    case 'phase_end': {
      const force = resolveForceRef(state, cond.force);
      if (force === null) return false;
      return (
        tx.kind === 'PHASE_END' &&
        tx.seat === force &&
        tx.phase === cond.phase &&
        (cond.turn === undefined || tx.turn === cond.turn)
      );
    }
    case 'turn_start':
      return tx.kind === 'TURN_START' && tx.turn === cond.turn;
    case 'tile_soldier_owner_not': {
      const force = resolveForceRef(state, cond.force);
      if (force === null) return false;
      return state.tiles[cond.tile]?.soldier?.owner !== force;
    }
    case 'trigger_fired':
      return fired.has(cond.trigger_id);
    case 'trigger_done':
      return (state.triggerRuntime?.firedCounts[cond.trigger_id] ?? 0) > 0;
    case 'tile_owner_appeared':
    case 'tile_emptied':
    case 'tile_owner_changed':
    case 'force_gone':
      return false;
  }
}
