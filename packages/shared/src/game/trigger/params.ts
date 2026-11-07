// 触发器组件参数元数据：用于引用/任意筛选的类型校验与效果展开。
import type { TriggerValueType } from './types.js';

export type TriggerParamKind =
  | 'tile'
  | 'seat'
  | 'owner'
  | 'trigger'
  | 'text'
  | 'var'
  | 'int'
  | 'bool'
  | 'phase'
  | 'terrain'
  | 'difficulty'
  | 'tileList'
  | 'seatList'
  | 'textValue'
  | 'placement'
  | 'operator';

export interface TriggerEffectParamSpec {
  kind: TriggerParamKind;
  /** 该参数在 DSL 里属于 effect.patch */
  inPatch?: boolean;
}

export const CONDITION_PARAM_KINDS: Record<string, Record<string, TriggerParamKind>> = {
  tile_owner_changed: { tile: 'tile', from: 'owner', to: 'owner' },
  force_gone: { force: 'seat' },
  phase_start: { force: 'seat', phase: 'phase', turn: 'int' },
  phase_end: { force: 'seat', phase: 'phase', turn: 'int' },
  turn_start: { turn: 'int' },
  trigger_fired: { trigger_id: 'trigger' },
};

export const EFFECT_PARAM_SPECS: Record<string, Record<string, TriggerEffectParamSpec>> = {
  spawn_soldier: {
    tile: { kind: 'tile' },
    force: { kind: 'seat' },
    strength: { kind: 'int' },
    movement: { kind: 'bool' },
  },
  update_soldier: {
    tile: { kind: 'tile' },
    strength: { kind: 'int', inPatch: true },
    owner: { kind: 'seat', inPatch: true },
    movement: { kind: 'bool', inPatch: true },
  },
  remove_soldier: { tile: { kind: 'tile' } },
  set_terrain: { tile: { kind: 'tile' }, terrain: { kind: 'terrain' } },
  update_force: {
    force: { kind: 'seat' },
    name: { kind: 'textValue', inPatch: true },
    flag: { kind: 'int', inPatch: true },
    team: { kind: 'int', inPatch: true },
    points: { kind: 'int', inPatch: true },
    computer: { kind: 'difficulty', inPatch: true },
  },
  clear_force: { force: { kind: 'seat' } },
  transfer_control: { ai_level: { kind: 'difficulty' } },
  set_turn_order: { order: { kind: 'seatList' } },
  set_fog: {
    enabled: { kind: 'bool' },
    reveal: { kind: 'tileList' },
    hide: { kind: 'tileList' },
  },
  show_text: {
    text_id: { kind: 'text' },
    text: { kind: 'textValue' },
    placement: { kind: 'placement' },
  },
  show_choice_text: {
    text_id: { kind: 'text' },
    text: { kind: 'textValue' },
    placement: { kind: 'placement' },
  },
  hide_text: { text_id: { kind: 'text' } },
  declare: {
    var_id: { kind: 'var' },
    init: { kind: 'int' },
  },
  change: {
    var_id: { kind: 'var' },
    operator: { kind: 'operator' },
    param: { kind: 'int' },
  },
  insert_move_intent: {
    force: { kind: 'seat' },
    from: { kind: 'tile' },
    to: { kind: 'tile' },
  },
  insert_attack_intent: {
    force: { kind: 'seat' },
    from: { kind: 'tile' },
    to: { kind: 'tile' },
  },
  insert_add_point_intent: {
    force: { kind: 'seat' },
    coordinate: { kind: 'tile' },
    amount: { kind: 'int' },
  },
  end_game: { winning_team: { kind: 'int' } },
};

/** 列表筛选对应的元素类型 */
export function filterTypeOfKind(kind: TriggerParamKind): TriggerValueType | null {
  if (kind === 'tile' || kind === 'tileList') return 'tile';
  if (kind === 'seat' || kind === 'owner' || kind === 'seatList') return 'seat';
  if (kind === 'trigger') return 'trigger';
  if (kind === 'text') return 'text';
  if (kind === 'var') return 'var';
  return null;
}

/** 该参数本身是否是一个列表参数（收到列表引用时整表赋值而非逐项执行） */
export function isListParamKind(kind: TriggerParamKind): boolean {
  return kind === 'tileList' || kind === 'seatList';
}

/** 该参数是否允许条件列表引用 */
export function isListRefCapable(kind: TriggerParamKind): boolean {
  return filterTypeOfKind(kind) !== null;
}

/** 该参数是否允许 gamestate 标量引用 */
export function isStateRefCapable(kind: TriggerParamKind): boolean {
  return !isListParamKind(kind) && kind !== 'placement' && kind !== 'operator';
}

/** 状态路径 kind 能否作为该参数的值 */
export function stateKindCompatibleWithParam(stateKind: string, paramKind: TriggerParamKind): boolean {
  if (paramKind === 'int') {
    return ['int', 'terrain', 'difficulty', 'seat', 'owner'].includes(stateKind);
  }
  if (paramKind === 'terrain') return stateKind === 'terrain' || stateKind === 'int';
  if (paramKind === 'difficulty') return stateKind === 'difficulty' || stateKind === 'int';
  if (paramKind === 'seat' || paramKind === 'owner') {
    return stateKind === 'seat' || stateKind === 'owner' || stateKind === 'int';
  }
  if (paramKind === 'bool') return stateKind === 'bool' || stateKind === 'textVisible';
  if (paramKind === 'text' || paramKind === 'textValue') {
    return stateKind === 'text' || stateKind === 'phase' || stateKind === 'intent';
  }
  if (paramKind === 'phase') return stateKind === 'phase' || stateKind === 'text';
  if (paramKind === 'tile') return stateKind === 'int';
  if (paramKind === 'trigger') return stateKind === 'text';
  if (paramKind === 'var') return stateKind === 'int' || stateKind === 'text';
  return false;
}
