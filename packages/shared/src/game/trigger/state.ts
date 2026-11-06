// gamestate 路径：白名单式的状态读取与显示格式化。
// 仅允许表内路径；动态段只能是座次（数字或 player）、地块序号、触发器 id。
import type { GameState } from '../types.js';
import type { TriggerDifficulty } from './types.js';
import { TRIGGER_INTENT_TYPES } from './types.js';

export type StateValueKind =
  | 'int'
  | 'bool'
  | 'text'
  | 'phase'
  | 'terrain'
  | 'difficulty'
  | 'seat'
  | 'owner'
  | 'intent'
  | 'textVisible';

export type StatePathGroup = 'global' | 'force' | 'tile' | 'fog' | 'trigger' | 'text';

export interface StatePathDef {
  /** 路径模板，如 gamestate.forces.{seat}.points */
  template: string;
  label: string;
  group: StatePathGroup;
  kind: StateValueKind;
  /** 该路径的取值可能为 null（显示为“无”） */
  nullable?: boolean;
  /** 模板里的动态参数，按出现顺序 */
  params: Array<'seat' | 'tile' | 'trigger' | 'text'>;
  get: (state: GameState, args: Record<string, string>) => unknown;
}

const PHASE_LABELS: Record<string, string> = {
  PREPARE: '准备阶段',
  ACTION: '行动阶段',
  ADD_POINT: '加点阶段',
  END: '结束阶段',
};

const TERRAIN_LABELS: Record<number, string> = {
  0: '平原',
  1: '据点',
  3: '海洋',
  4: '山地',
  5: '虚空',
};

const DIFFICULTY_LABELS: Record<number, string> = {
  1: '简单',
  2: '普通',
  3: '困难',
  255: '休闲',
};

const INTENT_LABELS: Record<string, string> = {
  MOVE: '移动',
  ATTACK: '进攻',
  ADD_POINT: '加点',
  SWITCH_PHASE: '切换阶段',
  SURRENDER: '投降',
};

function forceOf(state: GameState, seat: number) {
  return state.forces.find((f) => f.seat === seat);
}

/** 座次参数：数字座次或 player（当前玩家控制势力） */
function resolveSeatArg(state: GameState, raw: string | undefined): number | null {
  if (raw === 'player') return state.controlledSeat;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 127 ? n : null;
}

function resolveTileArg(state: GameState, raw: string | undefined): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n >= state.rows * state.columns) return null;
  return n;
}

function soldierOf(state: GameState, tile: number | null) {
  if (tile === null) return undefined;
  return state.tiles[tile]?.soldier ?? null;
}

export const STATE_PATH_DEFS: StatePathDef[] = [
  {
    template: 'gamestate.turn',
    label: '当前回合',
    group: 'global',
    kind: 'int',
    params: [],
    get: (state) => state.turn,
  },
  {
    template: 'gamestate.phase',
    label: '当前阶段',
    group: 'global',
    kind: 'phase',
    params: [],
    get: (state) => state.phase,
  },
  {
    template: 'gamestate.currentSeat',
    label: '当前行动势力',
    group: 'global',
    kind: 'seat',
    params: [],
    get: (state) => state.currentSeat,
  },
  {
    template: 'gamestate.controlledSeat',
    label: '玩家控制势力',
    group: 'global',
    kind: 'seat',
    nullable: true,
    params: [],
    get: (state) => state.controlledSeat,
  },
  {
    template: 'gamestate.finished',
    label: '对局是否结束',
    group: 'global',
    kind: 'bool',
    params: [],
    get: (state) => state.finished,
  },
  {
    template: 'gamestate.winningTeam',
    label: '获胜队伍',
    group: 'global',
    kind: 'int',
    nullable: true,
    params: [],
    get: (state) => state.winningTeam,
  },
  {
    template: 'gamestate.intentSeq',
    label: '意图计数',
    group: 'global',
    kind: 'int',
    params: [],
    get: (state) => state.triggerRuntime?.intentSeq ?? 0,
  },
  {
    template: 'gamestate.turnSeq',
    label: '结束回合计数',
    group: 'global',
    kind: 'int',
    params: [],
    get: (state) => state.triggerRuntime?.turnSeq ?? 0,
  },
  {
    template: 'gamestate.lastIntentType',
    label: '上一个意图',
    group: 'global',
    kind: 'intent',
    nullable: true,
    params: [],
    get: (state) => state.triggerRuntime?.lastIntentType ?? null,
  },
  {
    template: 'gamestate.forces.{seat}.alive',
    label: '势力存活',
    group: 'force',
    kind: 'bool',
    params: ['seat'],
    get: (state, args) => {
      const seat = resolveSeatArg(state, args.seat);
      return seat === null ? undefined : (forceOf(state, seat)?.alive ?? false);
    },
  },
  {
    template: 'gamestate.forces.{seat}.exists',
    label: '势力存在',
    group: 'force',
    kind: 'bool',
    params: ['seat'],
    get: (state, args) => {
      const seat = resolveSeatArg(state, args.seat);
      return seat === null ? undefined : (forceOf(state, seat)?.exists ?? false);
    },
  },
  {
    template: 'gamestate.forces.{seat}.points',
    label: '势力点数',
    group: 'force',
    kind: 'int',
    params: ['seat'],
    get: (state, args) => {
      const seat = resolveSeatArg(state, args.seat);
      return seat === null ? undefined : (forceOf(state, seat)?.points ?? 0);
    },
  },
  {
    template: 'gamestate.forces.{seat}.team',
    label: '势力队伍',
    group: 'force',
    kind: 'int',
    params: ['seat'],
    get: (state, args) => {
      const seat = resolveSeatArg(state, args.seat);
      return seat === null ? undefined : (forceOf(state, seat)?.team ?? 0);
    },
  },
  {
    template: 'gamestate.forces.{seat}.name',
    label: '势力名称',
    group: 'force',
    kind: 'text',
    params: ['seat'],
    get: (state, args) => {
      const seat = resolveSeatArg(state, args.seat);
      return seat === null ? undefined : (forceOf(state, seat)?.name ?? '');
    },
  },
  {
    template: 'gamestate.forces.{seat}.flag',
    label: '势力旗帜',
    group: 'force',
    kind: 'int',
    params: ['seat'],
    get: (state, args) => {
      const seat = resolveSeatArg(state, args.seat);
      return seat === null ? undefined : (forceOf(state, seat)?.flag ?? 0);
    },
  },
  {
    template: 'gamestate.forces.{seat}.computer',
    label: '势力 AI 难度',
    group: 'force',
    kind: 'difficulty',
    params: ['seat'],
    get: (state, args) => {
      const seat = resolveSeatArg(state, args.seat);
      return seat === null ? undefined : ((forceOf(state, seat)?.computer ?? 255) as TriggerDifficulty);
    },
  },
  {
    template: 'gamestate.tiles.{tile}.terrain',
    label: '地块地形',
    group: 'tile',
    kind: 'terrain',
    params: ['tile'],
    get: (state, args) => {
      const tile = resolveTileArg(state, args.tile);
      return tile === null ? undefined : state.tiles[tile]?.terrain;
    },
  },
  {
    template: 'gamestate.tiles.{tile}.soldier.exists',
    label: '地块是否有兵',
    group: 'tile',
    kind: 'bool',
    params: ['tile'],
    get: (state, args) => {
      const tile = resolveTileArg(state, args.tile);
      return tile === null ? undefined : !!state.tiles[tile]?.soldier;
    },
  },
  {
    template: 'gamestate.tiles.{tile}.soldier.owner',
    label: '地块守军归属',
    group: 'tile',
    kind: 'owner',
    nullable: true,
    params: ['tile'],
    get: (state, args) => {
      const soldier = soldierOf(state, resolveTileArg(state, args.tile));
      return soldier === undefined ? undefined : (soldier?.owner ?? null);
    },
  },
  {
    template: 'gamestate.tiles.{tile}.soldier.strength',
    label: '地块守军兵力',
    group: 'tile',
    kind: 'int',
    nullable: true,
    params: ['tile'],
    get: (state, args) => {
      const soldier = soldierOf(state, resolveTileArg(state, args.tile));
      return soldier === undefined ? undefined : (soldier?.strength ?? null);
    },
  },
  {
    template: 'gamestate.tiles.{tile}.soldier.isLinked',
    label: '地块守军是否连兵',
    group: 'tile',
    kind: 'bool',
    nullable: true,
    params: ['tile'],
    get: (state, args) => {
      const soldier = soldierOf(state, resolveTileArg(state, args.tile));
      return soldier === undefined ? undefined : (soldier ? soldier.isLinked : null);
    },
  },
  {
    template: 'gamestate.tiles.{tile}.soldier.hasMovement',
    label: '地块守军是否有移动力',
    group: 'tile',
    kind: 'bool',
    nullable: true,
    params: ['tile'],
    get: (state, args) => {
      const soldier = soldierOf(state, resolveTileArg(state, args.tile));
      return soldier === undefined ? undefined : (soldier ? soldier.hasMovement : null);
    },
  },
  {
    template: 'gamestate.fogOverrides.enabled',
    label: '迷雾覆盖是否开启',
    group: 'fog',
    kind: 'bool',
    nullable: true,
    params: [],
    get: (state) => state.fogOverrides?.enabled ?? null,
  },
  {
    template: 'gamestate.triggerRuntime.firedCounts.{trigger}',
    label: '触发器已触发次数',
    group: 'trigger',
    kind: 'int',
    params: ['trigger'],
    get: (state, args) => state.triggerRuntime?.firedCounts[args.trigger ?? ''] ?? 0,
  },
  {
    template: 'gamestate.texts.{text}.visible',
    label: '文本状态',
    group: 'text',
    kind: 'textVisible',
    params: ['text'],
    get: (state, args) => !!state.triggerRuntime?.visibleTexts?.[args.text ?? ''],
  },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileTemplate(def: StatePathDef): RegExp {
  const parts = def.template.split(/(\{seat\}|\{tile\}|\{trigger\}|\{text\})/);
  let pattern = '^';
  for (const part of parts) {
    if (part === '{seat}' || part === '{tile}') pattern += '([^.]+)';
    else if (part === '{trigger}' || part === '{text}') pattern += '(.+)';
    else pattern += escapeRegExp(part);
  }
  return new RegExp(pattern + '$');
}

interface CompiledDef {
  def: StatePathDef;
  re: RegExp;
}
const COMPILED: CompiledDef[] = STATE_PATH_DEFS.map((def) => ({ def, re: compileTemplate(def) }));

export interface ParsedStatePath {
  def: StatePathDef;
  args: Record<string, string>;
}

/** 解析具体路径；未知路径返回 null */
export function parseStatePath(path: string): ParsedStatePath | null {
  for (const { def, re } of COMPILED) {
    const m = re.exec(path);
    if (!m) continue;
    const args: Record<string, string> = {};
    def.params.forEach((p, i) => {
      args[p] = m[i + 1];
    });
    return { def, args };
  }
  return null;
}

/** 可用路径上下文（校验动态段） */
export interface StatePathContext {
  total: number;
  seats: ReadonlySet<number>;
  ids: ReadonlySet<string>;
  /** 合法文本 id（gamestate.texts.{text}.visible）；缺省视为无 */
  texts?: ReadonlySet<string>;
}

export function validateStatePath(path: string, ctx: StatePathContext): boolean {
  const parsed = parseStatePath(path);
  if (!parsed) return false;
  for (const param of parsed.def.params) {
    const raw = parsed.args[param];
    if (param === 'seat') {
      if (raw === 'player') continue;
      const n = Number(raw);
      if (!Number.isInteger(n) || !ctx.seats.has(n)) return false;
    } else if (param === 'tile') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n >= ctx.total) return false;
    } else if (param === 'trigger') {
      if (!ctx.ids.has(raw)) return false;
    } else if (param === 'text') {
      if (!(ctx.texts ?? new Set<string>()).has(raw)) return false;
    }
  }
  return true;
}

const PHASE_VALUES = new Set(['PREPARE', 'ACTION', 'ADD_POINT', 'END']);
const TERRAIN_VALUES = new Set([0, 1, 3, 4, 5]);
const DIFFICULTY_VALUES = new Set([1, 2, 3, 255]);
const INTENT_VALUES = new Set<string>(TRIGGER_INTENT_TYPES);

/** 断言预期值是否与路径类型匹配 */
export function validateStateValue(
  path: string,
  value: unknown,
  ctx: StatePathContext,
): boolean {
  const parsed = parseStatePath(path);
  if (!parsed) return false;
  const { def } = parsed;
  if (value === null) return !!def.nullable || def.kind === 'owner';
  switch (def.kind) {
    case 'int':
      return typeof value === 'number' && Number.isInteger(value);
    case 'bool':
      return typeof value === 'boolean';
    case 'text':
      return typeof value === 'string';
    case 'phase':
      return typeof value === 'string' && PHASE_VALUES.has(value);
    case 'terrain':
      return typeof value === 'number' && TERRAIN_VALUES.has(value);
    case 'difficulty':
      return typeof value === 'number' && DIFFICULTY_VALUES.has(value);
    case 'seat':
      return value === 'player' || (typeof value === 'number' && ctx.seats.has(value));
    case 'owner':
      return (
        value === 'player' ||
        (typeof value === 'number' && (value === 0 || value === 255 || ctx.seats.has(value)))
      );
    case 'intent':
      return typeof value === 'string' && INTENT_VALUES.has(value);
    case 'textVisible':
      return typeof value === 'boolean';
  }
}

/** 读取路径值；无法解析（未知路径/越界/缺势力）返回 undefined，合法空值返回 null */
export function resolveStatePath(state: GameState, path: string): unknown {
  const parsed = parseStatePath(path);
  if (!parsed) return undefined;
  try {
    return parsed.def.get(state, parsed.args);
  } catch {
    return undefined;
  }
}

function forceName(state: GameState, seat: number): string {
  return forceOf(state, seat)?.name || `P${seat}`;
}

/** 单个值 → 便于理解的文字（只输出值，不带标签） */
export function formatStateValue(state: GameState, def: StatePathDef, value: unknown): string {
  if (value === null || value === undefined) return '无';
  switch (def.kind) {
    case 'bool':
      return value ? '是' : '否';
    case 'phase':
      return PHASE_LABELS[String(value)] ?? String(value);
    case 'terrain':
      return TERRAIN_LABELS[Number(value)] ?? String(value);
    case 'difficulty':
      return DIFFICULTY_LABELS[Number(value)] ?? String(value);
    case 'intent':
      return INTENT_LABELS[String(value)] ?? String(value);
    case 'textVisible':
      return value ? '展示' : '隐藏';
    case 'seat':
      return forceName(state, Number(value));
    case 'owner': {
      const n = Number(value);
      if (n === 0) return '野生';
      if (n === 255) return '阻挡';
      return forceName(state, n);
    }
    default:
      return String(value);
  }
}

const TOKEN_RE = /\{gamestate\.([^{}]+)\}/g;

/** 解析文本里的全部状态占位符 */
export function stateTextTokens(template: string): string[] {
  const out: string[] = [];
  for (const m of template.matchAll(TOKEN_RE)) out.push(`gamestate.${m[1]}`);
  return out;
}

/** 文本模板校验：所有 {gamestate.xxx} 必须是合法路径 */
export function validateStateText(template: string, ctx: StatePathContext): boolean {
  for (const path of stateTextTokens(template)) {
    if (!validateStatePath(path, ctx)) return false;
  }
  return true;
}

/** 文本模板 → 展示文本；无法解析的占位符保留原样（保存校验会拦截） */
export function formatStateText(state: GameState, template: string): string {
  return template.replace(TOKEN_RE, (token, path: string) => {
    const full = `gamestate.${path}`;
    const parsed = parseStatePath(full);
    if (!parsed) return token;
    const value = resolveStatePath(state, full);
    if (value === undefined) return token;
    return formatStateValue(state, parsed.def, value);
  });
}
