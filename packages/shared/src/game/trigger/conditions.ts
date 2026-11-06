// 触发器条件求值：动作类条件读增量 diff，回合类条件读阶段-回合转换，状态类条件读当前局面。
// 取消 action/world 区分后，条件树上两类叶子可以混排：同一事务里同时提供 delta 与 transition 时，
// and 里的动作叶子与回合叶子可以一起成立。
//
// any 语义：条件里的 any 一律表示“无约束”；地块(any) 有多个候选时按存在量词判定。
import type { GameState, SoldierState } from '../types.js';
import type {
  TriggerAnyForceRef,
  TriggerCondition,
  TriggerDelta,
  TriggerOwnerRef,
  WorldTransition,
} from './types.js';
import { isNeutralOwner } from '../constants.js';
import { resolveForceRef } from './resolve.js';
import { parseStatePath, resolveStatePath } from './state.js';

/** 条件求值上下文：动作叶子需要 delta，回合叶子需要 transition */
export interface TriggerMatchContext {
  delta?: TriggerDelta;
  transition?: WorldTransition;
}

function tileOf(delta: TriggerDelta, index: number) {
  return delta.tiles.find((t) => t.index === index);
}

function forceOf(delta: TriggerDelta, seat: number) {
  return delta.forces.find((f) => f.seat === seat);
}

/** 归属归一：seat 原样返回；无兵或中立势力统一为 null（显示为“无主/中立”） */
function ownerValueOf(soldier: SoldierState | null): number | null {
  if (!soldier) return null;
  return isNeutralOwner(soldier.owner) ? null : soldier.owner;
}

function ownerRefMatches(ref: TriggerOwnerRef, value: number | null, state: GameState): boolean {
  if (ref === 'any') return true;
  if (ref === 'null') return value === null;
  if (ref === 'player') {
    const player = resolveForceRef(state, 'player');
    return player !== null && value === player;
  }
  return value === ref;
}

/** 某次地块增量是否满足归属变化条件 */
function tileOwnerMatches(
  cond: Extract<TriggerCondition, { op: 'tile_owner_changed' }>,
  t: TriggerDelta['tiles'][number],
  state: GameState,
): boolean {
  const before = ownerValueOf(t.before.soldier);
  const after = ownerValueOf(t.after.soldier);
  if (before === after) return false;
  return ownerRefMatches(cond.from, before, state) && ownerRefMatches(cond.to, after, state);
}

function forceRefAny(ref: TriggerAnyForceRef): ref is 'any' {
  return ref === 'any';
}

/** 条件树里的叶子是否都能在本上下文求值（用于 not：缺上下文时不能当作“条件不成立”） */
function contextCovers(cond: TriggerCondition, ctx: TriggerMatchContext): boolean {
  switch (cond.op) {
    case 'and':
    case 'or':
      return cond.items.every((item) => contextCovers(item, ctx));
    case 'not':
      return contextCovers(cond.item, ctx);
    case 'tile_owner_changed':
    case 'force_gone':
      return !!ctx.delta;
    case 'phase_start':
    case 'phase_end':
    case 'turn_start':
      return !!ctx.transition;
    case 'state_assert':
      // “改变”需要本步骤的前后增量；普通断言只看当前局面
      return cond.cmp !== 'changed' || !!ctx.delta;
    default:
      return true;
  }
}

/** 统一条件求值：缺少对应上下文的条件叶子返回 false */
export function matchCondition(
  cond: TriggerCondition,
  ctx: TriggerMatchContext,
  fired: ReadonlySet<string>,
  state: GameState,
): boolean {
  switch (cond.op) {
    case 'and':
      return cond.items.every((item) => matchCondition(item, ctx, fired, state));
    case 'or':
      return cond.items.some((item) => matchCondition(item, ctx, fired, state));
    case 'not':
      return contextCovers(cond.item, ctx) && !matchCondition(cond.item, ctx, fired, state);
    case 'tile_owner_changed': {
      const delta = ctx.delta;
      if (!delta) return false;
      if (cond.tile === 'any') return delta.tiles.some((t) => tileOwnerMatches(cond, t, state));
      const t = tileOf(delta, cond.tile);
      return t ? tileOwnerMatches(cond, t, state) : false;
    }
    case 'force_gone': {
      const delta = ctx.delta;
      if (!delta) return false;
      if (cond.force === 'any') {
        return delta.forces.some((f) => f.before.alive && !f.after.alive);
      }
      const force = resolveForceRef(state, cond.force);
      if (force === null) return false;
      const f = forceOf(delta, force);
      if (!f) return false;
      return f.before.alive && !f.after.alive;
    }
    case 'state_assert': {
      if (cond.cmp === 'changed') {
        const delta = ctx.delta;
        if (!delta) return false;
        const before = resolveStatePath(delta.before, cond.path);
        const after = resolveStatePath(delta.after, cond.path);
        if (before === undefined || after === undefined) return false;
        return before !== after;
      }
      const actual = resolveStatePath(state, cond.path);
      if (actual === undefined) return false;
      let expected: unknown;
      if (cond.value_ref !== undefined) {
        expected = resolveStatePath(state, cond.value_ref);
        if (expected === undefined) return false;
      } else {
        expected = cond.value;
        if (expected === 'player') {
          const parsed = parseStatePath(cond.path);
          if (parsed && (parsed.def.kind === 'seat' || parsed.def.kind === 'owner')) {
            if (state.controlledSeat === null) return false;
            expected = state.controlledSeat;
          }
        }
      }
      if (cond.cmp === '=') return actual === expected;
      if (typeof actual !== 'number' || typeof expected !== 'number') return false;
      switch (cond.cmp) {
        case '>':
          return actual > expected;
        case '<':
          return actual < expected;
        case '>=':
          return actual >= expected;
        case '<=':
          return actual <= expected;
      }
      return false;
    }
    case 'trigger_fired':
      if (cond.trigger_id === 'any') return fired.size > 0;
      return fired.has(cond.trigger_id);
    case 'phase_start': {
      const tx = ctx.transition;
      if (!tx) return false;
      if (!forceRefAny(cond.force)) {
        const force = resolveForceRef(state, cond.force);
        if (force === null || tx.seat !== force) return false;
      }
      return (
        tx.kind === 'PHASE_START' &&
        (cond.phase === 'any' || tx.phase === cond.phase) &&
        (cond.turn === 'any' || tx.turn === cond.turn)
      );
    }
    case 'phase_end': {
      const tx = ctx.transition;
      if (!tx) return false;
      if (!forceRefAny(cond.force)) {
        const force = resolveForceRef(state, cond.force);
        if (force === null || tx.seat !== force) return false;
      }
      return (
        tx.kind === 'PHASE_END' &&
        (cond.phase === 'any' || tx.phase === cond.phase) &&
        (cond.turn === 'any' || tx.turn === cond.turn)
      );
    }
    case 'turn_start': {
      const tx = ctx.transition;
      if (!tx) return false;
      return tx.kind === 'TURN_START' && (cond.turn === 'any' || tx.turn === cond.turn);
    }
  }
}

/** 条件里是否含地块引用（相对/任意地块需要遍历候选，供调试与编辑器使用） */
export function hasAnyTile(cond: TriggerCondition): boolean {
  switch (cond.op) {
    case 'and':
    case 'or':
      return cond.items.some(hasAnyTile);
    case 'not':
      return hasAnyTile(cond.item);
    case 'tile_owner_changed':
      return cond.tile === 'any';
    default:
      return false;
  }
}

/** 条件树里是否含“事件”叶子：有事件走动作/回合 pass，没有则走状态监听 pass */
export function hasEventCondition(cond: TriggerCondition): boolean {
  switch (cond.op) {
    case 'and':
    case 'or':
      return cond.items.some(hasEventCondition);
    case 'not':
      return hasEventCondition(cond.item);
    case 'tile_owner_changed':
    case 'force_gone':
    case 'phase_start':
    case 'phase_end':
    case 'turn_start':
    case 'trigger_fired':
      return true;
    case 'state_assert':
      // 纯状态断言走状态监听；“改变”断言依赖本步骤增量，属于事件叶子
      return cond.cmp === 'changed';
    default:
      return false;
  }
}

/** 条件树里是否含回合类叶子（决定触发器是否参与回合 pass） */
export function hasWorldCondition(cond: TriggerCondition): boolean {
  switch (cond.op) {
    case 'and':
    case 'or':
      return cond.items.some(hasWorldCondition);
    case 'not':
      return hasWorldCondition(cond.item);
    case 'phase_start':
    case 'phase_end':
    case 'turn_start':
      return true;
    default:
      return false;
  }
}
