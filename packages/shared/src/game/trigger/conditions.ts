// 触发器条件求值：动作类条件读增量 diff，回合类条件读阶段-回合转换，状态类条件读当前局面。
// 筛选条件（任意/列表引用）会额外产出列表，供同触发器内的条件/效果引用。
//
// any 语义：条件里已有的 any 仍表示“无约束”；只有 state_assert 的 args 里的 { any: true }
// 以及参数 refs 里的 { ref } 才是“筛选变量”，会产出列表。
import type { GameState, SoldierState } from '../types.js';
import type {
  TriggerAnyForceRef,
  TriggerCondition,
  TriggerDelta,
  TriggerFilterList,
  TriggerForceRef,
  TriggerOwnerRef,
  TriggerParamRef,
  TriggerPathArg,
  TriggerValueType,
  WorldTransition,
} from './types.js';
import { isNeutralOwner } from '../constants.js';
import { resolveForceRef } from './resolve.js';
import {
  fillStatePath,
  parseStatePath,
  parseStatePathTemplate,
  resolveStatePath,
} from './state.js';
import { CONDITION_PARAM_KINDS, filterTypeOfKind } from './params.js';

/** 条件求值上下文：动作叶子需要 delta，回合叶子需要 transition */
export interface TriggerMatchContext {
  delta?: TriggerDelta;
  transition?: WorldTransition;
  /** 事务开始前（最近意图执行前）的完整状态，用于前态引用 */
  beforeState?: GameState;
}

interface ConditionEval {
  pass: boolean;
  list?: TriggerFilterList;
}

interface EvalEnv {
  ctx: TriggerMatchContext;
  fired: ReadonlySet<string>;
  state: GameState;
  byId: Map<string, TriggerCondition>;
  cache: Map<string, ConditionEval>;
  visiting: Set<string>;
}

export interface TriggerEvalResult {
  pass: boolean;
  /** cid → 筛选列表（只有引用使用的条件会被包含） */
  bindings: Record<string, TriggerFilterList>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
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

function forceRefAny(ref: TriggerAnyForceRef): ref is 'any' {
  return ref === 'any';
}

function collectConditions(cond: TriggerCondition, out: Map<string, TriggerCondition>): void {
  if (cond.cid && !out.has(cond.cid)) out.set(cond.cid, cond);
  if (cond.op === 'and' || cond.op === 'or') {
    for (const item of cond.items) collectConditions(item, out);
  } else if (cond.op === 'not') {
    collectConditions(cond.item, out);
  }
}

function resolveStateRef(ref: Extract<TriggerParamRef, { gamestate: string }>, env: EvalEnv): unknown {
  const target = ref.at === 'before' ? env.ctx.beforeState : env.state;
  if (!target) return undefined;
  return resolveStatePath(target, ref.gamestate);
}

/** 条件参数取值：筛选候选 > refs 中的 gamestate 标量 > 字面值 */
function paramValue(
  cond: TriggerCondition,
  key: string,
  literal: unknown,
  env: EvalEnv,
  overrides: Record<string, unknown>,
): unknown {
  if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
  const ref = cond.refs?.[key];
  if (ref) {
    if ('gamestate' in ref) return resolveStateRef(ref, env);
    return undefined;
  }
  return literal;
}

function stateArgType(arg: string): TriggerValueType | null {
  if (arg === 'seat') return 'seat';
  if (arg === 'tile') return 'tile';
  if (arg === 'trigger') return 'trigger';
  if (arg === 'text') return 'text';
  if (arg === 'var') return 'var';
  return null;
}

function pathArgValue(
  cond: Extract<TriggerCondition, { op: 'state_assert' }>,
  key: string,
  env: EvalEnv,
  overrides: Record<string, unknown>,
): unknown {
  if (Object.prototype.hasOwnProperty.call(overrides, key)) return overrides[key];
  const ref = cond.refs?.[key];
  if (ref && 'gamestate' in ref) {
    return resolveStateRef({ gamestate: ref.gamestate, at: ref.at }, env);
  }
  const arg = cond.args?.[key];
  if (arg !== undefined) {
    if (typeof arg === 'string' || typeof arg === 'number') return arg;
    if (isRecord(arg)) {
      if ('gamestate' in arg && typeof arg.gamestate === 'string') {
        return resolveStateRef(
          { gamestate: arg.gamestate, at: arg.at as 'current' | 'before' | undefined },
          env,
        );
      }
      // any / ref 是筛选变量，必须由 overrides 提供
      return undefined;
    }
    return undefined;
  }
  const parsed = parseStatePath(cond.path);
  return parsed ? parsed.args[key] : undefined;
}

function resolveAssertPath(
  cond: Extract<TriggerCondition, { op: 'state_assert' }>,
  env: EvalEnv,
  overrides: Record<string, unknown>,
): string | undefined {
  if (!cond.args) return cond.path;
  const def = parseStatePathTemplate(cond.path);
  if (!def) return undefined;
  const args: Record<string, string> = {};
  for (const key of def.params) {
    const value = pathArgValue(cond, key, env, overrides);
    if (value === undefined || value === null) return undefined;
    args[key] = String(value);
  }
  return fillStatePath(def.template, args);
}

function compareValues(actual: unknown, expected: unknown, cmp: string): boolean {
  if (cmp === '=') return actual === expected;
  if (cmp === '!=') return actual !== expected;
  if (typeof actual !== 'number' || typeof expected !== 'number') return false;
  switch (cmp) {
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

function matchLeafBoolean(
  cond: TriggerCondition,
  env: EvalEnv,
  overrides: Record<string, unknown>,
): boolean {
  const { state, ctx, fired } = env;
  switch (cond.op) {
    case 'and':
    case 'or':
    case 'not':
      return false; // 由 evalNode 处理
    case 'tile_owner_changed': {
      const delta = ctx.delta;
      if (!delta) return false;
      const rawTile = paramValue(cond, 'tile', cond.tile, env, overrides);
      const rawFrom = paramValue(cond, 'from', cond.from, env, overrides);
      const rawTo = paramValue(cond, 'to', cond.to, env, overrides);
      if (rawTile === undefined || rawFrom === undefined || rawTo === undefined) return false;
      const from = rawFrom as TriggerOwnerRef;
      const to = rawTo as TriggerOwnerRef;
      if (rawTile === 'any') return delta.tiles.some((t) => tileOwnerMatches(t, state, from, to));
      const n = Number(rawTile);
      if (!Number.isInteger(n)) return false;
      const t = tileOf(delta, n);
      return t ? tileOwnerMatches(t, state, from, to) : false;
    }
    case 'force_gone': {
      const delta = ctx.delta;
      if (!delta) return false;
      const rawForce = paramValue(cond, 'force', cond.force, env, overrides);
      if (rawForce === undefined) return false;
      const forceRef = rawForce as TriggerAnyForceRef;
      if (forceRef === 'any') {
        return delta.forces.some((f) => f.before.alive && !f.after.alive);
      }
      const force = resolveForceRef(state, forceRef);
      if (force === null) return false;
      const f = forceOf(delta, force);
      if (!f) return false;
      return f.before.alive && !f.after.alive;
    }
    case 'state_assert': {
      if (cond.cmp === 'changed') {
        const delta = ctx.delta;
        if (!delta) return false;
        const path = resolveAssertPath(cond, env, overrides);
        if (!path) return false;
        const before = resolveStatePath(delta.before, path);
        const after = resolveStatePath(delta.after, path);
        if (before === undefined || after === undefined) return false;
        return before !== after;
      }
      const path = resolveAssertPath(cond, env, overrides);
      if (!path) return false;
      const actual = resolveStatePath(state, path);
      if (actual === undefined) return false;
      let expected: unknown;
      if (cond.value_ref !== undefined) {
        expected = resolveStatePath(state, cond.value_ref);
        if (expected === undefined) return false;
      } else {
        expected = cond.value;
        if (expected === 'player') {
          const parsed = parseStatePath(path);
          if (parsed && (parsed.def.kind === 'seat' || parsed.def.kind === 'owner')) {
            if (state.controlledSeat === null) return false;
            expected = state.controlledSeat;
          }
        }
      }
      return compareValues(actual, expected, cond.cmp);
    }
    case 'trigger_fired': {
      const raw = paramValue(cond, 'trigger_id', cond.trigger_id, env, overrides);
      if (typeof raw !== 'string') return false;
      if (raw === 'any') return fired.size > 0;
      return fired.has(raw);
    }
    case 'phase_start':
    case 'phase_end': {
      const tx = ctx.transition;
      if (!tx) return false;
      const rawForce = paramValue(cond, 'force', cond.force, env, overrides);
      const rawPhase = paramValue(cond, 'phase', cond.phase, env, overrides);
      const rawTurn = paramValue(cond, 'turn', cond.turn, env, overrides);
      if (rawForce === undefined || rawPhase === undefined || rawTurn === undefined) return false;
      if (!forceRefAny(rawForce as TriggerAnyForceRef)) {
        const force = resolveForceRef(state, rawForce as TriggerForceRef);
        if (force === null || tx.seat !== force) return false;
      }
      return (
        tx.kind === (cond.op === 'phase_start' ? 'PHASE_START' : 'PHASE_END') &&
        (rawPhase === 'any' || tx.phase === rawPhase) &&
        (rawTurn === 'any' || tx.turn === Number(rawTurn))
      );
    }
    case 'turn_start': {
      const tx = ctx.transition;
      if (!tx) return false;
      const rawTurn = paramValue(cond, 'turn', cond.turn, env, overrides);
      if (rawTurn === undefined) return false;
      return tx.kind === 'TURN_START' && (rawTurn === 'any' || tx.turn === Number(rawTurn));
    }
  }
}

function tileOwnerMatches(
  t: TriggerDelta['tiles'][number],
  state: GameState,
  from: TriggerOwnerRef,
  to: TriggerOwnerRef,
): boolean {
  const before = ownerValueOf(t.before.soldier);
  const after = ownerValueOf(t.after.soldier);
  if (before === after) return false;
  return ownerRefMatches(from, before, state) && ownerRefMatches(to, after, state);
}

// ---------- 筛选域 / 列表 ----------

function textIdsOfState(state: GameState): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (id: unknown) => {
    if (typeof id !== 'string' || !id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };
  for (const trigger of state.triggers) {
    for (const effect of trigger.effects) {
      if (
        effect.op === 'show_text' ||
        effect.op === 'show_choice_text' ||
        effect.op === 'hide_text'
      ) {
        add(effect.text_id);
      }
    }
  }
  for (const id of Object.keys(state.triggerRuntime?.visibleTexts ?? {})) add(id);
  for (const id of Object.keys(state.triggerRuntime?.choiceValues ?? {})) add(id);
  return out;
}

function varIdsOfState(state: GameState): string[] {
  const set = new Set<string>();
  for (const trigger of state.triggers) {
    for (const effect of trigger.effects) {
      if (effect.op === 'declare' && effect.var_id) set.add(effect.var_id);
    }
  }
  for (const id of Object.keys(state.triggerRuntime?.numberVars ?? {})) set.add(id);
  return [...set].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function domainValues(state: GameState, type: TriggerValueType): Array<number | string> {
  if (type === 'tile') {
    return Array.from({ length: state.rows * state.columns }, (_, i) => i);
  }
  if (type === 'seat') {
    return [...state.forces]
      .map((f) => f.seat)
      .sort((a, b) => a - b);
  }
  if (type === 'trigger') return state.triggers.map((t) => t.id);
  if (type === 'text') return textIdsOfState(state);
  return varIdsOfState(state);
}

function canonicalValues(
  type: TriggerValueType,
  values: Array<number | string>,
  state: GameState,
): Array<number | string> {
  const triggerOrder = new Map(state.triggers.map((t, i) => [t.id, i]));
  const textOrder = new Map(textIdsOfState(state).map((id, i) => [id, i]));
  const unique = new Map<string, number | string>();
  for (const value of values) {
    if (value === null || value === undefined) continue;
    unique.set(String(value), value);
  }
  return [...unique.values()].sort((a, b) => {
    if (type === 'tile' || type === 'seat') return Number(a) - Number(b);
    if (type === 'trigger') {
      return (triggerOrder.get(String(a)) ?? 0) - (triggerOrder.get(String(b)) ?? 0);
    }
    if (type === 'text') {
      return (textOrder.get(String(a)) ?? 0) - (textOrder.get(String(b)) ?? 0);
    }
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  });
}

function combineLists(
  type: TriggerValueType,
  lists: TriggerFilterList[],
  mode: 'and' | 'or',
  state: GameState,
): TriggerFilterList | undefined {
  if (!lists.length) return undefined;
  if (lists.some((l) => l.type !== type)) return undefined;
  let result = new Map<string, number | string>();
  if (mode === 'and') {
    for (const value of lists[0].values) result.set(String(value), value);
    for (let i = 1; i < lists.length; i++) {
      const allowed = new Set(lists[i].values.map((v) => String(v)));
      for (const key of [...result.keys()]) {
        if (!allowed.has(key)) result.delete(key);
      }
    }
  } else {
    for (const list of lists) {
      for (const value of list.values) result.set(String(value), value);
    }
  }
  return { type, values: canonicalValues(type, [...result.values()], state) };
}

function findListRef(cond: TriggerCondition): { key: string; ref: string } | null {
  if (!cond.refs) return null;
  for (const [key, ref] of Object.entries(cond.refs)) {
    if (ref && typeof ref === 'object' && 'ref' in ref && typeof ref.ref === 'string') {
      return { key, ref: ref.ref };
    }
  }
  return null;
}

function findStateAssertFilter(
  cond: Extract<TriggerCondition, { op: 'state_assert' }>,
): { key: string; arg: Extract<TriggerPathArg, { any: true } | { ref: string }> } | null {
  if (!cond.args) return null;
  for (const [key, arg] of Object.entries(cond.args)) {
    if (arg && typeof arg === 'object' && ('any' in arg || 'ref' in arg)) {
      return { key, arg: arg as Extract<TriggerPathArg, { any: true } | { ref: string }> };
    }
  }
  return null;
}

function referencedList(
  refId: string,
  expected: TriggerValueType,
  env: EvalEnv,
): TriggerFilterList | undefined {
  const target = env.byId.get(refId);
  if (!target) return undefined;
  const result = evalNode(target, env);
  if (!result.list || result.list.type !== expected) return undefined;
  return result.list;
}

function stateAssertFilterType(
  cond: Extract<TriggerCondition, { op: 'state_assert' }>,
  key: string,
): TriggerValueType | null {
  const def = parseStatePathTemplate(cond.path);
  if (!def || !def.params.includes(key as never)) return null;
  return stateArgType(key);
}

function evalFilterLeaf(
  cond: TriggerCondition,
  env: EvalEnv,
  filter: { key: string; type: TriggerValueType; candidates: Array<number | string> },
): ConditionEval {
  const passed: Array<number | string> = [];
  const seen = new Set<string>();
  for (const candidate of filter.candidates) {
    const key = String(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    const overrides = { [filter.key]: candidate };
    if (matchLeafBoolean(cond, env, overrides)) passed.push(candidate);
  }
  const list: TriggerFilterList = {
    type: filter.type,
    values: canonicalValues(filter.type, passed, env.state),
  };
  return { pass: list.values.length > 0, list };
}

function evalLeaf(cond: TriggerCondition, env: EvalEnv): ConditionEval {
  // state_assert 的动态参数筛选
  if (cond.op === 'state_assert') {
    const filter = findStateAssertFilter(cond);
    if (filter) {
      const type = stateAssertFilterType(cond, filter.key);
      if (!type) return { pass: false };
      let candidates: Array<number | string> | undefined;
      if ('any' in filter.arg) {
        candidates = domainValues(env.state, type);
      } else {
        const list = referencedList(filter.arg.ref, type, env);
        candidates = list?.values;
      }
      if (!candidates) return { pass: false };
      return evalFilterLeaf(cond, env, { key: filter.key, type, candidates });
    }
  }
  // 普通条件参数上的列表引用
  const listRef = findListRef(cond);
  if (listRef) {
    const kind = CONDITION_PARAM_KINDS[cond.op]?.[listRef.key];
    const type = kind ? filterTypeOfKind(kind) : null;
    if (!type) return { pass: false };
    const list = referencedList(listRef.ref, type, env);
    if (!list) return { pass: false };
    return evalFilterLeaf(cond, env, { key: listRef.key, type, candidates: list.values });
  }
  return { pass: matchLeafBoolean(cond, env, {}) };
}

function evalNodeInner(cond: TriggerCondition, env: EvalEnv): ConditionEval {
  if (cond.op === 'and' || cond.op === 'or') {
    const items = cond.items.map((item) => evalNode(item, env));
    const pass = cond.op === 'and' ? items.every((r) => r.pass) : items.some((r) => r.pass);
    const lists = items.map((r) => r.list).filter((l): l is TriggerFilterList => !!l);
    if (!lists.length) return { pass };
    const type = lists[0].type;
    if (lists.some((l) => l.type !== type)) return { pass }; // 混合类型不产列表
    return { pass, list: combineLists(type, lists, cond.op, env.state) };
  }
  if (cond.op === 'not') {
    // 缺少事件上下文时不能把“无法求值”当作“条件不成立”再取反
    if (!contextCovers(cond.item, env.ctx)) return { pass: false };
    const item = evalNode(cond.item, env);
    return { pass: !item.pass };
  }
  return evalLeaf(cond, env);
}

function evalNode(cond: TriggerCondition, env: EvalEnv): ConditionEval {
  const cid = typeof cond.cid === 'string' && cond.cid ? cond.cid : '';
  if (cid && env.cache.has(cid)) return env.cache.get(cid)!;
  if (cid) {
    if (env.visiting.has(cid)) return { pass: false };
    env.visiting.add(cid);
    const result = evalNodeInner(cond, env);
    env.visiting.delete(cid);
    env.cache.set(cid, result);
    return result;
  }
  return evalNodeInner(cond, env);
}

/** 求值整棵 when 树，并返回所有筛选列表绑定 */
export function evaluateTriggerCondition(
  when: TriggerCondition,
  ctx: TriggerMatchContext,
  fired: ReadonlySet<string>,
  state: GameState,
): TriggerEvalResult {
  const byId = new Map<string, TriggerCondition>();
  collectConditions(when, byId);
  const env: EvalEnv = {
    ctx,
    fired,
    state,
    byId,
    cache: new Map(),
    visiting: new Set(),
  };
  const root = evalNode(when, env);
  const bindings: Record<string, TriggerFilterList> = {};
  for (const [cid, result] of env.cache) {
    if (result.list) bindings[cid] = result.list;
  }
  return { pass: root.pass, bindings };
}

/** 兼容原有调用：只返回布尔值 */
export function matchCondition(
  cond: TriggerCondition,
  ctx: TriggerMatchContext,
  fired: ReadonlySet<string>,
  state: GameState,
): boolean {
  return evaluateTriggerCondition(cond, ctx, fired, state).pass;
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
