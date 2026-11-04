// 地图 JSON 工具：前后端共用（目录加载、保存接口、PVE 导入）。
// 与原 backend/src/maps/catalog.ts 的实现保持一致；stripJsonComments 允许地图文件带 // 行注释。
import { TERRAIN, TILE_OWNER } from '../types.js';
import { TEXT_SCREEN_POSITIONS } from '../game/trigger/types.js';
import { parseStatePath, validateStatePath, validateStateText, validateStateValue } from '../game/trigger/state.js';

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
}

function validateCondition(c: unknown, ctx: StatePathCtx): boolean {
  if (!isRecord(c) || typeof c.op !== 'string') return false;
  switch (c.op) {
    case 'and':
    case 'or':
      if (!Array.isArray(c.items) || c.items.length === 0) return false;
      return c.items.every((item) => validateCondition(item, ctx));
    case 'not':
      return validateCondition(c.item, ctx);
    case 'tile_owner_changed':
      return (
        isTileRef(c.tile, ctx.total) &&
        isOwnerRef(c.from, ctx.seats) &&
        isOwnerRef(c.to, ctx.seats)
      );
    case 'force_gone':
      return isAnyForceRef(c.force, ctx.seats);
    case 'phase_start':
    case 'phase_end':
      return (
        isAnyForceRef(c.force, ctx.seats) &&
        isPhaseRef(c.phase) &&
        isTurnRef(c.turn)
      );
    case 'turn_start':
      return isTurnRef(c.turn);
    case 'state_assert': {
      if (typeof c.path !== 'string' || !validateStatePath(c.path, ctx)) return false;
      const cmp = c.cmp;
      if (cmp !== '=' && cmp !== '>' && cmp !== '<' && cmp !== '>=' && cmp !== '<=') return false;
      if (cmp !== '=') {
        const parsed = parseStatePath(c.path);
        if (!parsed || parsed.def.kind !== 'int') return false;
        if (typeof c.value !== 'number') return false;
      }
      return validateStateValue(c.path, c.value, ctx);
    }
    case 'trigger_fired':
      return isTriggerRef(c.trigger_id);
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

function validateEffect(
  e: unknown,
  ctx: StatePathCtx,
  teams: ReadonlySet<number>,
): boolean {
  if (!isRecord(e) || typeof e.op !== 'string') return false;
  const seats = ctx.seats;
  const total = ctx.total;
  switch (e.op) {
    case 'spawn_soldier':
      return (
        isTile(e.tile, total) &&
        isSpawnForceRef(e.force, seats) &&
        isInt(e.strength) &&
        e.strength > 0 &&
        typeof e.movement === 'boolean'
      );
    case 'update_soldier': {
      if (!isTile(e.tile, total) || !isRecord(e.patch)) return false;
      const p = e.patch;
      const ok =
        (p.strength === 'unchanged' || (isInt(p.strength) && p.strength >= 0)) &&
        (p.owner === 'unchanged' || isSeat(p.owner, seats)) &&
        (p.movement === 'unchanged' || typeof p.movement === 'boolean');
      if (!ok) return false;
      // 至少一项不是 unchanged，否则该效果没有意义
      return (
        p.strength !== 'unchanged' ||
        p.owner !== 'unchanged' ||
        p.movement !== 'unchanged'
      );
    }
    case 'remove_soldier':
      return isTile(e.tile, total);
    case 'set_terrain':
      return isTile(e.tile, total) && isInt(e.terrain) && TERRAIN_VALUES.has(e.terrain);
    case 'update_force': {
      if (!isForceRef(e.force, seats) || !isRecord(e.patch)) return false;
      const p = e.patch;
      const ok =
        (p.name === 'unchanged' || (typeof p.name === 'string' && p.name.length <= 64)) &&
        (p.flag === 'unchanged' || isInt(p.flag)) &&
        (p.team === 'unchanged' || (isInt(p.team) && teams.has(p.team))) &&
        (p.points === 'unchanged' || (isInt(p.points) && p.points >= 0)) &&
        (p.computer === 'unchanged' ||
          (typeof p.computer === 'number' && [1, 2, 3, 255].includes(p.computer)));
      if (!ok) return false;
      return (
        p.name !== 'unchanged' ||
        p.flag !== 'unchanged' ||
        p.team !== 'unchanged' ||
        p.points !== 'unchanged' ||
        p.computer !== 'unchanged'
      );
    }
    case 'clear_force':
      return isForceRef(e.force, seats);
    case 'transfer_control':
      return e.ai_level === 1 || e.ai_level === 2 || e.ai_level === 255;
    case 'set_turn_order': {
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
        (typeof e.enabled === 'boolean' || e.enabled === 'flipped' || e.enabled === 'unchanged') &&
        Array.isArray(e.reveal) &&
        e.reveal.every((t) => isTile(t, total)) &&
        Array.isArray(e.hide) &&
        e.hide.every((t) => isTile(t, total))
      );
    case 'show_text':
      return (
        typeof e.text_id === 'string' &&
        e.text_id.length > 0 &&
        e.text_id.length <= 64 &&
        typeof e.text === 'string' &&
        e.text.length <= 4000 &&
        validateStateText(e.text, ctx) &&
        validateTextPlacement(e.placement, total)
      );
    case 'hide_text':
      return typeof e.text_id === 'string' && e.text_id.length > 0 && e.text_id.length <= 64;
    case 'end_game':
      return isInt(e.winning_team) && teams.has(e.winning_team);
    case 'insert_move_intent':
    case 'insert_attack_intent':
      return isForceRef(e.force, seats) && isTile(e.from, total) && isTile(e.to, total);
    case 'insert_add_point_intent':
      return isForceRef(e.force, seats) && isTile(e.coordinate, total) && isInt(e.amount) && e.amount > 0;
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
  const ctx: StatePathCtx = { total, seats, ids };
  for (const entry of raw) {
    if (!isRecord(entry)) return false;
    if (entry.priority !== undefined && !isInt(entry.priority)) return false;
    if (entry.once !== undefined && typeof entry.once !== 'boolean') return false;
    if (entry.repeatable !== undefined && typeof entry.repeatable !== 'boolean') return false;
    if (!validateCondition(entry.when, ctx)) return false;
    if (entry.delay !== undefined) {
      if (!isRecord(entry.delay)) return false;
      if (!isInt(entry.delay.amount) || entry.delay.amount <= 0) return false;
      if (entry.delay.unit !== 'intent' && entry.delay.unit !== 'turn' && entry.delay.unit !== 'round') {
        return false;
      }
    }
    if (!Array.isArray(entry.effects) || entry.effects.length === 0) return false;
    if (!entry.effects.every((effect) => validateEffect(effect, ctx, teams))) return false;
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
