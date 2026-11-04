// 战役触发器数据模型（地图 JSON 顶层 triggers 字段）。
// 地图内 DSL 使用 snake_case 与 MapFullData 保持一致；运行时状态使用 camelCase 与 GameState 一致。
import type { ForceState, GameState, Phase, TileState } from '../types.js';

export type TriggerClass = 'action' | 'world';

export type TriggerDelayUnit = 'intent' | 'turn' | 'round';

export interface TriggerDelay {
  amount: number;
  unit: TriggerDelayUnit;
}

/** 条件/效果中的势力引用：数字 seat 或当前玩家控制势力 */
export type TriggerForceRef = number | 'player';

/** 生成兵的势力引用：额外支持“玩家行动顺序中的下一个存活势力” */
export type TriggerSpawnForceRef = TriggerForceRef | 'next_after_player';

/** 文本屏幕方位：上下左右 + 四角 */
export const TEXT_SCREEN_POSITIONS = [
  'top',
  'bottom',
  'left',
  'right',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const;
export type TextScreenPosition = (typeof TEXT_SCREEN_POSITIONS)[number];

/** 文本放置：屏幕方位或绑定到地块（互斥，二选一）；缺省 = 右上角 */
export type TextPlacement =
  | { kind: 'screen'; position: TextScreenPosition }
  | { kind: 'tile'; tile: number };

export interface TriggerDef {
  /** 稳定唯一 id；禁止用数组下标 */
  id: string;
  class: TriggerClass;
  /** 越大越先执行；缺省 0 */
  priority?: number;
  /** 每局最多触发一次 */
  once?: boolean;
  /** 同一事务内允许重复触发；缺省 false */
  repeatable?: boolean;
  when: TriggerCondition;
  delay?: TriggerDelay;
  effects: TriggerEffect[];
}

export type TriggerCondition =
  | { op: 'and'; items: TriggerCondition[] }
  | { op: 'or'; items: TriggerCondition[] }
  | { op: 'not'; item: TriggerCondition }
  // 动作类叶子：判定当前步骤增量 diff
  | { op: 'tile_owner_appeared'; tile: number; force: TriggerForceRef }
  | { op: 'tile_emptied'; tile: number }
  | { op: 'tile_owner_changed'; tile: number; to: TriggerForceRef; from?: TriggerForceRef }
  | { op: 'force_gone'; force: TriggerForceRef }
  // 状态叶子：读取当前局面（战役需要“某格是否有某势力兵”等条件）
  | { op: 'tile_soldier_owner_not'; tile: number; force: TriggerForceRef }
  // 回合类叶子：判定事件链里的阶段/回合转换
  | { op: 'phase_start'; force: TriggerForceRef; phase: Phase; turn?: number }
  | { op: 'phase_end'; force: TriggerForceRef; phase: Phase; turn?: number }
  | { op: 'turn_start'; turn: number }
  // 连锁/历史叶子：两类事务都可使用
  | { op: 'trigger_fired'; trigger_id: string }
  | { op: 'trigger_done'; trigger_id: string };

export type TriggerEffect =
  | {
      op: 'spawn_soldier';
      tile: number;
      force: TriggerSpawnForceRef;
      strength: number;
      linked?: boolean;
      movement?: boolean;
      counter?: number;
    }
  | {
      op: 'update_soldier';
      tile: number;
      patch: {
        strength?: number;
        owner?: number;
        linked?: boolean;
        movement?: boolean;
        counter?: number;
      };
    }
  | { op: 'remove_soldier'; tile: number }
  | { op: 'set_terrain'; tile: number; terrain: number }
  | {
      op: 'update_force';
      force: TriggerForceRef;
      patch: {
        name?: string;
        flag?: number;
        team?: number;
        points?: number;
        computer?: number;
      };
    }
  | { op: 'clear_force'; force: TriggerForceRef }
  | { op: 'transfer_control'; to_force: TriggerForceRef; ai_level: 1 | 2 | 255 }
  | { op: 'set_turn_order'; order: number[] }
  | { op: 'set_fog'; enabled?: boolean; reveal?: number[]; hide?: number[] }
  | { op: 'show_text'; text_id: string; text: string; placement?: TextPlacement }
  | { op: 'hide_text'; text_id: string }
  | { op: 'end_game'; winning_team: number }
  // 以指定势力执行一次玩家意图（战役脚本用）：可指定任意势力、任意时刻执行；
  // MOVE/ATTACK 忽略移动力与连断兵移动限制，ADD_POINT 忽略回合/阶段，其余规则照常检查。
  | { op: 'insert_move_intent'; force: TriggerForceRef; from: number; to: number }
  | { op: 'insert_attack_intent'; force: TriggerForceRef; from: number; to: number }
  | { op: 'insert_add_point_intent'; force: TriggerForceRef; coordinate: number; amount: number };

/** 延时触发器排期项（随 GameState 存档/悔棋） */
export interface PendingTrigger {
  triggerId: string;
  /** 确定性排序用 */
  serial: number;
  dueIntentSeq?: number;
  dueTurnSeq?: number;
  dueRound?: number;
}

/** 触发器运行时状态（仅 triggerMode 下非空） */
export interface TriggerRuntime {
  schemaVersion: number;
  /** triggerId → 已触发次数（once 判定） */
  firedCounts: Record<string, number>;
  pending: PendingTrigger[];
  /** 被接受的 HUMAN 玩家意图数 */
  intentSeq: number;
  /** END_TURN 次数（任何来源） */
  turnSeq: number;
  /** 下一次延时排期序号（确定性排序） */
  nextSerial: number;
  /** 触发器事务序号（任何来源的 applyIntent 事务） */
  transactionSeq: number;
}

export interface TriggerTileDelta {
  index: number;
  before: TileState;
  after: TileState;
}

export interface TriggerForceDelta {
  seat: number;
  before: ForceState;
  after: ForceState;
}

/** 一个步骤（意图或单个触发器执行）造成的实际变化 */
export interface TriggerDelta {
  before: GameState;
  after: GameState;
  tiles: TriggerTileDelta[];
  forces: TriggerForceDelta[];
}

export type WorldTransitionKind = 'PHASE_START' | 'PHASE_END' | 'TURN_CHANGE' | 'TURN_START';

/** 从事件链提取出的阶段/回合转换 */
export interface WorldTransition {
  kind: WorldTransitionKind;
  seat: number;
  phase: Phase;
  turn: number;
  eventIndex: number;
}
