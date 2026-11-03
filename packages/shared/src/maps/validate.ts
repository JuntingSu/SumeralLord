// 地图 JSON 工具：前后端共用（目录加载、保存接口、PVE 导入）。
// 与原 backend/src/maps/catalog.ts 的实现保持一致；stripJsonComments 允许地图文件带 // 行注释。
import { TERRAIN, TILE_OWNER } from '../types.js';
import { TEXT_SCREEN_POSITIONS } from '../game/trigger/types.js';

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

function validateCondition(
  c: unknown,
  seats: ReadonlySet<number>,
  total: number,
  cls: 'action' | 'world',
): boolean {
  if (!isRecord(c) || typeof c.op !== 'string') return false;
  switch (c.op) {
    case 'and':
    case 'or':
      if (!Array.isArray(c.items) || c.items.length === 0) return false;
      return c.items.every((item) => validateCondition(item, seats, total, cls));
    case 'not':
      return validateCondition(c.item, seats, total, cls);
    case 'tile_owner_appeared':
      return cls === 'action' && isTile(c.tile, total) && isForceRef(c.force, seats);
    case 'tile_emptied':
      return cls === 'action' && isTile(c.tile, total);
    case 'tile_owner_changed':
      return (
        cls === 'action' &&
        isTile(c.tile, total) &&
        isForceRef(c.to, seats) &&
        (c.from === undefined || isForceRef(c.from, seats))
      );
    case 'force_gone':
      return cls === 'action' && isForceRef(c.force, seats);
    case 'tile_soldier_owner_not':
      // 状态叶子：允许动作/回合两类触发器使用
      return isTile(c.tile, total) && isForceRef(c.force, seats);
    case 'phase_start':
    case 'phase_end':
      return (
        cls === 'world' &&
        isForceRef(c.force, seats) &&
        typeof c.phase === 'string' &&
        PHASE_VALUES.has(c.phase) &&
        (c.turn === undefined || (isInt(c.turn) && c.turn >= 1))
      );
    case 'turn_start':
      return cls === 'world' && isInt(c.turn) && c.turn >= 1;
    case 'trigger_fired':
      return typeof c.trigger_id === 'string' && c.trigger_id.length > 0;
    case 'trigger_done':
      return typeof c.trigger_id === 'string' && c.trigger_id.length > 0;
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

function validateEffect(e: unknown, seats: ReadonlySet<number>, total: number): boolean {
  if (!isRecord(e) || typeof e.op !== 'string') return false;
  switch (e.op) {
    case 'spawn_soldier':
      return (
        isTile(e.tile, total) &&
        isSpawnForceRef(e.force, seats) &&
        isInt(e.strength) &&
        e.strength > 0 &&
        (e.linked === undefined || typeof e.linked === 'boolean') &&
        (e.movement === undefined || typeof e.movement === 'boolean') &&
        (e.counter === undefined || (isInt(e.counter) && e.counter >= 0))
      );
    case 'update_soldier': {
      if (!isTile(e.tile, total) || !isRecord(e.patch)) return false;
      const p = e.patch;
      return (
        (p.strength === undefined || (isInt(p.strength) && p.strength >= 0)) &&
        (p.owner === undefined || isSeat(p.owner, seats)) &&
        (p.linked === undefined || typeof p.linked === 'boolean') &&
        (p.movement === undefined || typeof p.movement === 'boolean') &&
        (p.counter === undefined || (isInt(p.counter) && p.counter >= 0))
      );
    }
    case 'remove_soldier':
      return isTile(e.tile, total);
    case 'set_terrain':
      return isTile(e.tile, total) && isInt(e.terrain) && TERRAIN_VALUES.has(e.terrain);
    case 'update_force': {
      if (!isForceRef(e.force, seats) || !isRecord(e.patch)) return false;
      const p = e.patch;
      return (
        (p.name === undefined || typeof p.name === 'string') &&
        (p.flag === undefined || isInt(p.flag)) &&
        (p.team === undefined || isInt(p.team)) &&
        (p.points === undefined || (isInt(p.points) && p.points >= 0)) &&
        (p.computer === undefined ||
          (typeof p.computer === 'number' && [1, 2, 3, 255].includes(p.computer)))
      );
    }
    case 'clear_force':
      return isForceRef(e.force, seats);
    case 'transfer_control':
      return (
        isForceRef(e.to_force, seats) &&
        (e.ai_level === 1 || e.ai_level === 2 || e.ai_level === 255)
      );
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
        (e.enabled === undefined || typeof e.enabled === 'boolean') &&
        (e.reveal === undefined ||
          (Array.isArray(e.reveal) && e.reveal.every((t) => isTile(t, total)))) &&
        (e.hide === undefined || (Array.isArray(e.hide) && e.hide.every((t) => isTile(t, total))))
      );
    case 'show_text':
      return (
        typeof e.text_id === 'string' &&
        e.text_id.length > 0 &&
        e.text_id.length <= 64 &&
        typeof e.text === 'string' &&
        e.text.length <= 4000 &&
        (e.placement === undefined || validateTextPlacement(e.placement, total))
      );
    case 'hide_text':
      return typeof e.text_id === 'string' && e.text_id.length > 0 && e.text_id.length <= 64;
    case 'end_game':
      return isInt(e.winning_team);
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
  if (c.op === 'trigger_fired' || c.op === 'trigger_done') {
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
): boolean {
  if (raw === undefined) return true;
  if (!Array.isArray(raw)) return false;
  const total = row * column;
  const ids = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) return false;
    if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.id.length > 64) {
      return false;
    }
    if (ids.has(entry.id)) return false;
    ids.add(entry.id);
    if (entry.class !== 'action' && entry.class !== 'world') return false;
    const cls: 'action' | 'world' = entry.class;
    if (entry.priority !== undefined && !isInt(entry.priority)) return false;
    if (entry.once !== undefined && typeof entry.once !== 'boolean') return false;
    if (entry.repeatable !== undefined && typeof entry.repeatable !== 'boolean') return false;
    if (!validateCondition(entry.when, seats, total, cls)) return false;
    if (entry.delay !== undefined) {
      if (!isRecord(entry.delay)) return false;
      if (!isInt(entry.delay.amount) || entry.delay.amount <= 0) return false;
      if (entry.delay.unit !== 'intent' && entry.delay.unit !== 'turn' && entry.delay.unit !== 'round') {
        return false;
      }
    }
    if (!Array.isArray(entry.effects) || entry.effects.length === 0) return false;
    if (!entry.effects.every((effect) => validateEffect(effect, seats, total))) return false;
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
  return validateTriggers(m.triggers, m.row, m.column, seats);
}
