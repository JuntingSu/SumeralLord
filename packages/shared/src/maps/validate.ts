// 地图 JSON 工具：前后端共用（目录加载、保存接口、PVE 导入）。
// 与原 backend/src/maps/catalog.ts 的实现保持一致；stripJsonComments 允许地图文件带 // 行注释。
import { TERRAIN, TILE_OWNER } from '../types.js';
import { TEXT_SCREEN_POSITIONS } from '../game/trigger/types.js';
import type { TriggerValueType } from '../game/trigger/types.js';
import {
  fillStatePath,
  parseStatePath,
  parseStatePathTemplate,
  validateStatePath,
  validateStateText,
  validateStateValue,
} from '../game/trigger/state.js';
import type { StateValueKind } from '../game/trigger/state.js';
import {
  CONDITION_PARAM_KINDS,
  EFFECT_PARAM_SPECS,
  filterTypeOfKind,
  isStateRefCapable,
  stateKindCompatibleWithParam,
} from '../game/trigger/params.js';
import type { TriggerParamKind } from '../game/trigger/params.js';

/** 剥离 // 行注释（字符串内的 // 不受影响） */
export function stripJsonComments(raw: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      out += ch;
      if (ch === '"') inString = false;
      else if (ch === '\\') {
        out += raw[i + 1] ?? '';
        i++;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return out;
}

// ---------- 战役触发器校验 ----------

const PHASE_VALUES = new Set<string>(['PREPARE', 'ACTION', 'ADD_POINT', 'END']);
const TERRAIN_VALUES = new Set<number>([
  TERRAIN.PLAIN,
  TERRAIN.CITY,
  TERRAIN.OCEAN,
  TERRAIN.MOUNTAIN,
  TERRAIN.VOID,
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function isTile(v: unknown, total: number): v is number {
  return isInt(v) && v >= 0 && v < total;
}

function isSeat(v: unknown, seats: ReadonlySet<number>): v is number {
  return isInt(v) && seats.has(v);
}

function isForceRef(v: unknown, seats: ReadonlySet<number>): boolean {
  return v === 'player' || isSeat(v, seats);
}

function isSpawnForceRef(v: unknown, seats: ReadonlySet<number>): boolean {
  return v === 'next_after_player' || isForceRef(v, seats);
}

/** 归属引用：seat / any（任意）/ null（无主·中立） */
function isOwnerRef(v: unknown, seats: ReadonlySet<number>): boolean {
  return v === 'player' || v === 'any' || v === 'null' || isSeat(v, seats);
}

/** 条件地块：序号或 any（存在某地块） */
function isTileRef(v: unknown, total: number): boolean {
  return v === 'any' || isTile(v, total);
}

/** 条件势力：seat / player / any（不限） */
function isAnyForceRef(v: unknown, seats: ReadonlySet<number>): boolean {
  return v === 'any' || isForceRef(v, seats);
}

function isPhaseRef(v: unknown): boolean {
  return v === 'any' || (typeof v === 'string' && PHASE_VALUES.has(v));
}

function isTurnRef(v: unknown): boolean {
  return v === 'any' || (isInt(v) && v >= 1);
}

function isTriggerRef(v: unknown): boolean {
  return v === 'any' || (typeof v === 'string' && v.length > 0);
}

interface StatePathCtx {
  total: number;
  seats: ReadonlySet<number>;
  ids: ReadonlySet<string>;
  texts: ReadonlySet<string>;
  vars: ReadonlySet<string>;
}

/** 单个触发器内的组件上下文：cid → 条件 / 全部组件 */
interface TriggerCtx extends StatePathCtx {
  conditions: Map<string, Record<string, unknown>>;
  components: Map<string, Record<string, unknown>>;
}

function isStateRef(v: unknown): v is { gamestate: string; at?: 'current' | 'before' } {
  return isRecord(v) && typeof v.gamestate === 'string';
}

function isListRef(v: unknown): v is { ref: string } {
  return isRecord(v) && typeof v.ref === 'string';
}

function isFilterArg(v: unknown): v is { any: true } | { ref: string } {
  return isRecord(v) && (('any' in v && v.any === true) || typeof v.ref === 'string');
}

function isCid(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= 64;
}

function pathArgKind(key: string): TriggerParamKind | null {
  if (key === 'seat' || key === 'tile' || key === 'trigger' || key === 'text' || key === 'var') {
    return key;
  }
  return null;
}

function pathArgFilterType(key: string): TriggerValueType | null {
  if (key === 'seat') return 'seat';
  if (key === 'tile') return 'tile';
  if (key === 'trigger') return 'trigger';
  if (key === 'text') return 'text';
  if (key === 'var') return 'var';
  return null;
}

function validatePathArgLiteral(arg: unknown, kind: TriggerParamKind, ctx: StatePathCtx): boolean {
  switch (kind) {
    case 'seat':
      return arg === 'player' || (isInt(arg) && ctx.seats.has(arg));
    case 'tile':
      return isTile(arg, ctx.total);
    case 'trigger':
      return typeof arg === 'string' && ctx.ids.has(arg);
    case 'text':
      return typeof arg === 'string' && ctx.texts.has(arg);
    case 'var':
      return typeof arg === 'string' && ctx.vars.has(arg);
    default:
      return false;
  }
}

function stateRefKindOk(path: string, kind: TriggerParamKind, ctx: StatePathCtx): boolean {
  if (!validateStatePath(path, ctx)) return false;
  const parsed = parseStatePath(path);
  return !!parsed && stateKindCompatibleWithParam(parsed.def.kind, kind);
}

function stateAssertParamKinds(
  c: Record<string, unknown>,
): Record<string, TriggerParamKind> | null {
  if (typeof c.path !== 'string') return null;
  const def = parseStatePathTemplate(c.path);
  if (!def) return null;
  const out: Record<string, TriggerParamKind> = {};
  for (const p of def.params) {
    const kind = pathArgKind(p);
    if (kind) out[p] = kind;
  }
  return out;
}

/** 条件产生的筛选列表类型；不产生列表（或混合类型）返回 null */
function conditionFilterType(
  c: Record<string, unknown>,
  ctx: TriggerCtx,
  seen: Set<string> = new Set(),
): TriggerValueType | null {
  if (isCid(c.cid)) {
    if (seen.has(c.cid)) return null;
    seen.add(c.cid);
  }
  if (typeof c.op !== 'string') return null;
  if (c.op === 'not') return null;
  if (c.op === 'and' || c.op === 'or') {
    if (!Array.isArray(c.items)) return null;
    const types: TriggerValueType[] = [];
    for (const item of c.items) {
      if (!isRecord(item)) continue;
      const type = conditionFilterType(item, ctx, seen);
      if (type) types.push(type);
    }
    if (types.length === 0) return null;
    return types.every((t) => t === types[0]) ? types[0] : null;
  }
  if (c.op === 'state_assert') {
    if (!isRecord(c.args)) return null;
    for (const key of Object.keys(c.args)) {
      if (isFilterArg(c.args[key])) return pathArgFilterType(key);
    }
    return null;
  }
  const kinds = CONDITION_PARAM_KINDS[c.op];
  if (!kinds || !isRecord(c.refs)) return null;
  for (const [key, ref] of Object.entries(c.refs)) {
    if (isListRef(ref)) {
      const kind = kinds[key];
      return kind ? filterTypeOfKind(kind) : null;
    }
  }
  return null;
}

function refTargetMatchesType(
  cid: string,
  expected: TriggerValueType,
  ctx: TriggerCtx,
): boolean {
  const target = ctx.conditions.get(cid);
  if (!target) return false;
  return conditionFilterType(target, ctx) === expected;
}

/** 校验组件 refs；返回 false 表示非法。state_assert 的路径参数也允许 state ref */
function validateComponentRefs(
  component: Record<string, unknown>,
  paramKinds: Record<string, TriggerParamKind> | null,
  ctx: TriggerCtx,
): boolean {
  const refs = component.refs;
  if (refs === undefined) return true;
  if (!isRecord(refs)) return false;
  let listRefs = 0;
  for (const [key, ref] of Object.entries(refs)) {
    if (!paramKinds || !paramKinds[key]) return false;
    const kind = paramKinds[key];
    if (isListRef(ref)) {
      listRefs += 1;
      if (listRefs > 1) return false; // 每个组件最多一个列表筛选引用
      if (!filterTypeOfKind(kind)) return false;
      const expected = filterTypeOfKind(kind)!;
      if (!refTargetMatchesType(ref.ref, expected, ctx)) return false;
      continue;
    }
    if (isStateRef(ref)) {
      if (ref.at !== undefined && ref.at !== 'current' && ref.at !== 'before') return false;
      if (!isStateRefCapable(kind)) return false;
      if (!stateRefKindOk(ref.gamestate, kind, ctx)) return false;
      continue;
    }
    return false;
  }
  return true;
}

/** 收集条件树的 cid → 条件；重复 cid 或非法 cid 返回 false */
function collectConditionCids(
  c: unknown,
  conditions: Map<string, Record<string, unknown>>,
  components: Map<string, Record<string, unknown>>,
): boolean {
  if (!isRecord(c) || typeof c.op !== 'string') return false;
  if (c.cid !== undefined) {
    if (!isCid(c.cid)) return false;
    if (components.has(c.cid)) return false;
    components.set(c.cid, c);
    conditions.set(c.cid, c);
  }
  if (c.op === 'and' || c.op === 'or') {
    if (!Array.isArray(c.items) || c.items.length === 0) return false;
    return c.items.every((item) => collectConditionCids(item, conditions, components));
  }
  if (c.op === 'not') return collectConditionCids(c.item, conditions, components);
  return true;
}

function collectEffectCids(effects: unknown[], components: Map<string, Record<string, unknown>>): boolean {
  for (const effect of effects) {
    if (!isRecord(effect)) return false;
    if (effect.cid === undefined) continue;
    if (!isCid(effect.cid)) return false;
    if (components.has(effect.cid)) return false;
    components.set(effect.cid, effect);
  }
  return true;
}

/** 条件引用不得成环（只跟随 { ref } 列表引用） */
function validateConditionRefGraph(ctx: TriggerCtx): boolean {
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (cid: string): boolean => {
    const mark = state.get(cid);
    if (mark === 'done') return true;
    if (mark === 'visiting') return false;
    state.set(cid, 'visiting');
    const cond = ctx.conditions.get(cid);
    if (!cond) return false;
    if (isRecord(cond.refs)) {
      for (const ref of Object.values(cond.refs)) {
        if (!isListRef(ref)) continue;
        if (!ctx.conditions.has(ref.ref)) return false;
        if (!visit(ref.ref)) return false;
      }
    }
    if (cond.op === 'state_assert' && isRecord(cond.args)) {
      for (const arg of Object.values(cond.args)) {
        if (!isListRef(arg)) continue;
        if (!ctx.conditions.has(arg.ref)) return false;
        if (!visit(arg.ref)) return false;
      }
    }
    state.set(cid, 'done');
    return true;
  };
  for (const cid of ctx.conditions.keys()) {
    if (!visit(cid)) return false;
  }
  return true;
}

function valueMatchesDef(
  def: { kind: StateValueKind; nullable?: boolean },
  value: unknown,
  ctx: StatePathCtx,
): boolean {
  if (value === null) return !!def.nullable || def.kind === 'owner';
  switch (def.kind) {
    case 'int':
      return isInt(value);
    case 'bool':
    case 'textVisible':
      return typeof value === 'boolean';
    case 'text':
      return typeof value === 'string';
    case 'phase':
      return typeof value === 'string' && PHASE_VALUES.has(value);
    case 'terrain':
      return isInt(value) && TERRAIN_VALUES.has(value);
    case 'difficulty':
      return isInt(value) && [1, 2, 3, 255].includes(value);
    case 'seat':
      return value === 'player' || (isInt(value) && ctx.seats.has(value));
    case 'owner':
      return value === 'player' || isInt(value);
    case 'intent':
      return typeof value === 'string';
  }
}

function validateCondition(c: unknown, ctx: TriggerCtx): boolean {
  if (!isRecord(c) || typeof c.op !== 'string') return false;
  if (c.cid !== undefined && !isCid(c.cid)) return false;
  switch (c.op) {
    case 'and':
    case 'or':
      if (!Array.isArray(c.items) || c.items.length === 0) return false;
      if (c.refs !== undefined) return false; // 组合条件没有可直接引用的参数
      return c.items.every((item) => validateCondition(item, ctx));
    case 'not':
      if (c.refs !== undefined) return false;
      return validateCondition(c.item, ctx);
    case 'tile_owner_changed': {
      const refs = isRecord(c.refs) ? c.refs : {};
      const has = (key: string) => Object.prototype.hasOwnProperty.call(refs, key);
      return (
        (has('tile') || isTileRef(c.tile, ctx.total)) &&
        (has('from') || isOwnerRef(c.from, ctx.seats)) &&
        (has('to') || isOwnerRef(c.to, ctx.seats)) &&
        validateComponentRefs(c, CONDITION_PARAM_KINDS[c.op], ctx)
      );
    }
    case 'force_gone': {
      const refs = isRecord(c.refs) ? c.refs : {};
      const has = Object.prototype.hasOwnProperty.call(refs, 'force');
      return (
        (has || isAnyForceRef(c.force, ctx.seats)) &&
        validateComponentRefs(c, CONDITION_PARAM_KINDS[c.op], ctx)
      );
    }
    case 'phase_start':
    case 'phase_end': {
      const refs = isRecord(c.refs) ? c.refs : {};
      const has = (key: string) => Object.prototype.hasOwnProperty.call(refs, key);
      return (
        (has('force') || isAnyForceRef(c.force, ctx.seats)) &&
        (has('phase') || isPhaseRef(c.phase)) &&
        (has('turn') || isTurnRef(c.turn)) &&
        validateComponentRefs(c, CONDITION_PARAM_KINDS[c.op], ctx)
      );
    }
    case 'turn_start': {
      const refs = isRecord(c.refs) ? c.refs : {};
      const has = Object.prototype.hasOwnProperty.call(refs, 'turn');
      return (
        (has || isTurnRef(c.turn)) &&
        validateComponentRefs(c, CONDITION_PARAM_KINDS[c.op], ctx)
      );
    }
    case 'trigger_fired': {
      const refs = isRecord(c.refs) ? c.refs : {};
      const has = Object.prototype.hasOwnProperty.call(refs, 'trigger_id');
      return (
        (has || isTriggerRef(c.trigger_id)) &&
        validateComponentRefs(c, CONDITION_PARAM_KINDS[c.op], ctx)
      );
    }
    case 'state_assert': {
      if (typeof c.path !== 'string') return false;
      const def = parseStatePathTemplate(c.path);
      if (!def) return false;
      const isTemplate = c.path.includes('{');
      let filterArgs = 0;
      let allLiteral = true;
      const filled: Record<string, string> = {};
      if (c.args !== undefined) {
        if (!isRecord(c.args)) return false;
        if (!isTemplate) return false; // 具体路径不应再带 args
        if (def.params.some((p) => !Object.prototype.hasOwnProperty.call(c.args, p))) {
          return false;
        }
        for (const [key, raw] of Object.entries(c.args)) {
          const kind = pathArgKind(key);
          if (!kind || !def.params.includes(key as never)) return false;
          if (isFilterArg(raw)) {
            filterArgs += 1;
            const expected = pathArgFilterType(key);
            if (!expected) return false;
            if (isListRef(raw) && !refTargetMatchesType(raw.ref, expected, ctx)) return false;
            allLiteral = false;
            continue;
          }
          if (isStateRef(raw)) {
            if (raw.at !== undefined && raw.at !== 'current' && raw.at !== 'before') return false;
            if (!stateRefKindOk(raw.gamestate, kind, ctx)) return false;
            allLiteral = false;
            continue;
          }
          if (typeof raw !== 'string' && typeof raw !== 'number') return false;
          if (!validatePathArgLiteral(raw, kind, ctx)) return false;
          filled[key] = String(raw);
        }
        if (filterArgs > 1) return false; // 每个条件最多一个筛选变量
      } else {
        if (isTemplate) return false; // 模板路径必须提供 args
        if (!validateStatePath(c.path, ctx)) return false;
      }
      if (c.refs !== undefined) {
        if (!isRecord(c.refs)) return false;
        // state_assert 的筛选变量只能放在 args 的“任意”位置；refs 仅接受 state 标量
        for (const ref of Object.values(c.refs)) {
          if (!isStateRef(ref)) return false;
        }
        if (!validateComponentRefs(c, stateAssertParamKinds(c), ctx)) return false;
      }
      const cmp = c.cmp;
      if (cmp === 'changed') return true;
      if (cmp !== '=' && cmp !== '!=' && cmp !== '>' && cmp !== '<' && cmp !== '>=' && cmp !== '<=') {
        return false;
      }
      if (c.value_ref !== undefined) {
        if (typeof c.value_ref !== 'string' || !validateStatePath(c.value_ref, ctx)) return false;
        if (c.value !== undefined) return false;
        if (cmp !== '=' && cmp !== '!=') {
          const ref = parseStatePath(c.value_ref);
          if (def.kind !== 'int') return false;
          if (!ref || ref.def.kind !== 'int') return false;
        }
        return true;
      }
      if (cmp !== '=' && cmp !== '!=') {
        if (def.kind !== 'int' || typeof c.value !== 'number') return false;
      }
      if (!isTemplate) return validateStateValue(c.path, c.value, ctx);
      if (allLiteral) {
        return validateStateValue(fillStatePath(def.template, filled), c.value, ctx);
      }
      return valueMatchesDef(def, c.value, ctx);
    }
    default:
      return false;
  }
}

function validateTextPlacement(p: unknown, total: number): boolean {
  if (!isRecord(p)) return false;
  if (p.kind === 'screen') {
    return (
      typeof p.position === 'string' &&
      (TEXT_SCREEN_POSITIONS as readonly string[]).includes(p.position)
    );
  }
  if (p.kind === 'tile') return isTile(p.tile, total);
  return false;
}

function effectParamKinds(op: string): Record<string, TriggerParamKind> | null {
  const specs = EFFECT_PARAM_SPECS[op];
  if (!specs) return null;
  const out: Record<string, TriggerParamKind> = {};
  for (const [key, spec] of Object.entries(specs)) out[key] = spec.kind;
  return out;
}

function validateEffect(
  e: unknown,
  ctx: TriggerCtx,
  teams: ReadonlySet<number>,
): boolean {
  if (!isRecord(e) || typeof e.op !== 'string') return false;
  if (e.cid !== undefined && !isCid(e.cid)) return false;
  const kinds = effectParamKinds(e.op);
  if (!kinds) return false;
  if (!validateComponentRefs(e, kinds, ctx)) return false;
  const seats = ctx.seats;
  const total = ctx.total;
  const refs = isRecord(e.refs) ? e.refs : {};
  const has = (key: string) => Object.prototype.hasOwnProperty.call(refs, key);
  switch (e.op) {
    case 'spawn_soldier':
      return (
        (has('tile') || isTile(e.tile, total)) &&
        (has('force') || isSpawnForceRef(e.force, seats)) &&
        (has('strength') || (isInt(e.strength) && e.strength > 0)) &&
        (has('movement') || typeof e.movement === 'boolean')
      );
    case 'update_soldier': {
      if (!(has('tile') || isTile(e.tile, total)) || !isRecord(e.patch)) return false;
      const p = e.patch;
      const ok =
        (p.strength === 'unchanged' || has('strength') || (isInt(p.strength) && p.strength >= 0)) &&
        (p.owner === 'unchanged' || has('owner') || isSeat(p.owner, seats)) &&
        (p.movement === 'unchanged' || has('movement') || typeof p.movement === 'boolean');
      if (!ok) return false;
      // 至少一项不是 unchanged，否则该效果没有意义
      return (
        p.strength !== 'unchanged' ||
        has('strength') ||
        p.owner !== 'unchanged' ||
        has('owner') ||
        p.movement !== 'unchanged' ||
        has('movement')
      );
    }
    case 'remove_soldier':
      return has('tile') || isTile(e.tile, total);
    case 'set_terrain':
      return (
        (has('tile') || isTile(e.tile, total)) &&
        (has('terrain') || (isInt(e.terrain) && TERRAIN_VALUES.has(e.terrain)))
      );
    case 'update_force': {
      if (!(has('force') || isForceRef(e.force, seats)) || !isRecord(e.patch)) return false;
      const p = e.patch;
      const ok =
        (p.name === 'unchanged' || has('name') || (typeof p.name === 'string' && p.name.length <= 64)) &&
        (p.flag === 'unchanged' || has('flag') || isInt(p.flag)) &&
        (p.team === 'unchanged' || has('team') || (isInt(p.team) && teams.has(p.team))) &&
        (p.points === 'unchanged' || has('points') || (isInt(p.points) && p.points >= 0)) &&
        (p.computer === 'unchanged' ||
          has('computer') ||
          (typeof p.computer === 'number' && [1, 2, 3, 255].includes(p.computer)));
      if (!ok) return false;
      return (
        p.name !== 'unchanged' ||
        has('name') ||
        p.flag !== 'unchanged' ||
        has('flag') ||
        p.team !== 'unchanged' ||
        has('team') ||
        p.points !== 'unchanged' ||
        has('points') ||
        p.computer !== 'unchanged' ||
        has('computer')
      );
    }
    case 'clear_force':
      return has('force') || isForceRef(e.force, seats);
    case 'transfer_control':
      return has('ai_level') || e.ai_level === 1 || e.ai_level === 2 || e.ai_level === 255;
    case 'set_turn_order': {
      if (has('order')) return true;
      if (!Array.isArray(e.order) || e.order.length !== seats.size) return false;
      const seen = new Set<number>();
      for (const s of e.order) {
        if (!isSeat(s, seats) || seen.has(s)) return false;
        seen.add(s);
      }
      return true;
    }
    case 'set_fog':
      return (
        (has('enabled') ||
          typeof e.enabled === 'boolean' ||
          e.enabled === 'flipped' ||
          e.enabled === 'unchanged') &&
        (has('reveal') || (Array.isArray(e.reveal) && e.reveal.every((t) => isTile(t, total)))) &&
        (has('hide') || (Array.isArray(e.hide) && e.hide.every((t) => isTile(t, total))))
      );
    case 'show_text':
      return (
        (has('text_id') ||
          (typeof e.text_id === 'string' && e.text_id.length > 0 && e.text_id.length <= 64)) &&
        (has('text') ||
          (typeof e.text === 'string' && e.text.length <= 4000 && validateStateText(e.text, ctx))) &&
        (has('placement') || validateTextPlacement(e.placement, total))
      );
    case 'show_choice_text':
      return (
        (has('text_id') ||
          (typeof e.text_id === 'string' && e.text_id.length > 0 && e.text_id.length <= 64)) &&
        (has('text') ||
          (typeof e.text === 'string' && e.text.length <= 4000 && validateStateText(e.text, ctx))) &&
        (has('placement') || validateTextPlacement(e.placement, total)) &&
        Array.isArray(e.options) &&
        e.options.length > 0 &&
        e.options.every(
          (option) =>
            typeof option === 'string' &&
            option.length > 0 &&
            option.length <= 4000 &&
            validateStateText(option, ctx),
        )
      );
    case 'hide_text':
      return (
        has('text_id') ||
        (typeof e.text_id === 'string' && e.text_id.length > 0 && e.text_id.length <= 64)
      );
    case 'declare': {
      if (!(has('var_id') || (typeof e.var_id === 'string' && e.var_id.length > 0 && e.var_id.length <= 64))) {
        return false;
      }
      if (e.init_ref !== undefined) {
        if (has('init')) return false; // 现态路径与 refs 引用二选一
        if (typeof e.init_ref !== 'string' || !validateStatePath(e.init_ref, ctx)) return false;
        return e.init === undefined;
      }
      return has('init') || isInt(e.init);
    }
    case 'change': {
      if (!(has('var_id') || (typeof e.var_id === 'string' && ctx.vars.has(e.var_id)))) return false;
      if (e.operator !== '+' && e.operator !== '-' && e.operator !== '*' && e.operator !== '/' && e.operator !== '=') {
        return false;
      }
      if (e.param_ref !== undefined) {
        if (has('param')) return false; // 现态路径与 refs 引用二选一
        if (typeof e.param_ref !== 'string' || !validateStatePath(e.param_ref, ctx)) return false;
        return e.param === undefined;
      }
      return has('param') || isInt(e.param);
    }
    case 'end_game':
      return has('winning_team') || (isInt(e.winning_team) && teams.has(e.winning_team));
    case 'insert_move_intent':
    case 'insert_attack_intent':
      return (
        (has('force') || isForceRef(e.force, seats)) &&
        (has('from') || isTile(e.from, total)) &&
        (has('to') || isTile(e.to, total))
      );
    case 'insert_add_point_intent':
      return (
        (has('force') || isForceRef(e.force, seats)) &&
        (has('coordinate') || isTile(e.coordinate, total)) &&
        (has('amount') || (isInt(e.amount) && e.amount > 0))
      );
    default:
      return false;
  }
}

function validateConditionRefs(c: unknown, ids: ReadonlySet<string>): boolean {
  if (!isRecord(c) || typeof c.op !== 'string') return false;
  if (c.op === 'and' || c.op === 'or') {
    return Array.isArray(c.items) && c.items.every((item) => validateConditionRefs(item, ids));
  }
  if (c.op === 'not') return validateConditionRefs(c.item, ids);
  if (c.op === 'trigger_fired') {
    if (isRecord(c.refs) && Object.prototype.hasOwnProperty.call(c.refs, 'trigger_id')) return true;
    if (c.trigger_id === 'any') return true;
    return typeof c.trigger_id === 'string' && ids.has(c.trigger_id);
  }
  return true;
}

/** 校验地图顶层 triggers（缺省视为无触发器） */
export function validateTriggers(
  raw: unknown,
  row: number,
  column: number,
  seats: ReadonlySet<number>,
  teams: ReadonlySet<number>,
): boolean {
  if (raw === undefined) return true;
  if (!Array.isArray(raw)) return false;
  const total = row * column;
  const ids = new Set<string>();
  // 先收集全部 id：状态路径（triggerRuntime.firedCounts.<id>）需要完整集合
  for (const entry of raw) {
    if (!isRecord(entry)) return false;
    if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > 64) {
      return false;
    }
    if (entry.id === 'any') return false; // 保留字：条件里的 trigger_id = any
    if (ids.has(entry.id)) return false;
    ids.add(entry.id);
  }
  const textIds = new Set<string>();
  const varIds = new Set<string>();
  const ctx: StatePathCtx = { total, seats, ids, texts: textIds, vars: varIds };
  // 文本 id 来自 show_text / hide_text 效果：状态路径 gamestate.texts.{text}.visible 需要完整集合
  for (const entry of raw) {
    if (!isRecord(entry) || !Array.isArray(entry.effects)) continue;
    for (const effect of entry.effects) {
      if (
        isRecord(effect) &&
        (effect.op === 'show_text' || effect.op === 'show_choice_text' || effect.op === 'hide_text') &&
        typeof effect.text_id === 'string' &&
        effect.text_id.length > 0
      ) {
        textIds.add(effect.text_id);
      }
      if (
        isRecord(effect) &&
        effect.op === 'declare' &&
        typeof effect.var_id === 'string' &&
        effect.var_id.length > 0
      ) {
        varIds.add(effect.var_id);
      }
    }
  }
  for (const entry of raw) {
    if (!isRecord(entry)) return false;
    if (entry.priority !== undefined && !isInt(entry.priority)) return false;
    if (entry.once !== undefined && typeof entry.once !== 'boolean') return false;
    if (entry.repeatable !== undefined && typeof entry.repeatable !== 'boolean') return false;
    if (!Array.isArray(entry.effects) || entry.effects.length === 0) return false;
    const conditions = new Map<string, Record<string, unknown>>();
    const components = new Map<string, Record<string, unknown>>();
    if (!collectConditionCids(entry.when, conditions, components)) return false;
    if (!collectEffectCids(entry.effects, components)) return false;
    const tctx: TriggerCtx = { ...ctx, conditions, components };
    if (!validateCondition(entry.when, tctx)) return false;
    if (!validateConditionRefGraph(tctx)) return false;
    if (entry.delay !== undefined) {
      if (!isRecord(entry.delay)) return false;
      if (!isInt(entry.delay.amount) || entry.delay.amount <= 0) return false;
      if (entry.delay.unit !== 'intent' && entry.delay.unit !== 'turn' && entry.delay.unit !== 'round') {
        return false;
      }
    }
    if (!entry.effects.every((effect) => validateEffect(effect, tctx, teams))) return false;
  }
  for (const entry of raw) {
    if (!isRecord(entry) || !validateConditionRefs(entry.when, ids)) return false;
  }
  return true;
}

/** 地图结构校验（目录加载与保存接口共用）：返回 true 表示通过 */
export function validateMapData(raw: unknown): boolean {
  if (raw === null || typeof raw !== 'object') return false;
  const m = raw as Record<string, unknown>;
  if (
    typeof m.title !== 'string' ||
    typeof m.row !== 'number' ||
    !Number.isInteger(m.row) ||
    m.row <= 0 ||
    typeof m.column !== 'number' ||
    !Number.isInteger(m.column) ||
    m.column <= 0 ||
    typeof m.player_num !== 'number' ||
    !Array.isArray(m.player_list) ||
    (m.player_list as unknown[]).length === 0 ||
    m.player_num !== (m.player_list as unknown[]).length ||
    !Array.isArray(m.battlefield) ||
    (m.battlefield as unknown[]).length !== m.row * m.column
  ) {
    return false;
  }
  const seats = new Set<number>();
  const teams = new Set<number>();
  for (const p of m.player_list as Record<string, unknown>[]) {
    if (
      typeof p.name !== 'string' ||
      typeof p.team !== 'number' ||
      typeof p.computer !== 'number' ||
      typeof p.seat !== 'number' ||
      typeof p.flag !== 'number' ||
      p.seat < 1 ||
      p.seat > 127
    ) {
      return false;
    }
    seats.add(p.seat);
    teams.add(p.team);
  }
  if (seats.size !== (m.player_list as unknown[]).length) return false;
  const terrainValues = new Set<number>([TERRAIN.PLAIN, TERRAIN.CITY, TERRAIN.OCEAN, TERRAIN.MOUNTAIN, TERRAIN.VOID]);
  for (const entry of m.battlefield as unknown[]) {
    const tile = entry as unknown[];
    if (!Array.isArray(tile) || tile.length !== 3 || !tile.every((v) => typeof v === 'number' && Number.isInteger(v))) {
      return false;
    }
    const [terrain, owner, strength] = tile as [number, number, number];
    if (
      !terrainValues.has(terrain) ||
      !(owner === TILE_OWNER.EMPTY || owner === TILE_OWNER.BLOCKER || owner === TILE_OWNER.WILD || (owner >= 1 && owner <= 127)) ||
      strength < 0
    ) {
      return false;
    }
  }
  if (m.trigger_schema_version !== undefined) {
    if (!isInt(m.trigger_schema_version) || m.trigger_schema_version < 1) return false;
  }
  if (Array.isArray(m.triggers) && m.triggers.length > 0 && m.trigger_schema_version !== 2) {
    return false; // 含触发器的新地图固定使用 schema v2
  }
  return validateTriggers(m.triggers, m.row, m.column, seats, teams);
}
