// 战役触发器数据模型（地图 JSON 顶层 triggers 字段）。
// 地图内 DSL 使用 snake_case 与 MapFullData 保持一致；运行时状态使用 camelCase 与 GameState 一致。
//
// v2 参数约定：不存在“空缺”参数——每个参数都必须有值。
//   any       无约束（仅筛选/条件位置）
//   null      无主/中立（仅归属）
//   unchanged 不修改（仅 patch 成员）
//   flipped   相对当前取反（布尔开关）
//   auto      由引擎按上下文计算（生成兵计次 = 地块地形的默认反击次数）
import type { ForceState, GameState, Phase, TileState } from '../types.js';

export type TriggerDelayUnit = 'intent' | 'turn' | 'round';

export interface TriggerDelay {
  amount: number;
  unit: TriggerDelayUnit;
}

/** 条件/效果中的势力引用：数字 seat 或当前玩家控制势力 */
export type TriggerForceRef = number | 'player';

/** 条件筛选里的势力引用：额外支持 any（不限势力） */
export type TriggerAnyForceRef = TriggerForceRef | 'any';

/** 生成兵的势力引用：额外支持“玩家行动顺序中的下一个存活势力” */
export type TriggerSpawnForceRef = TriggerForceRef | 'next_after_player';

/** 地块归属引用：数字 seat / 当前玩家 / any 任意归属 / null 无归属或中立势力（野生/阻挡） */
export type TriggerOwnerRef = number | 'player' | 'any' | 'null';

/** 条件里的地块引用：数字序号；any 表示“存在某地块满足”（存在量词） */
export type TriggerTileRef = number | 'any';

/** 条件里的阶段引用：any 表示任意阶段 */
export type TriggerPhaseRef = Phase | 'any';

/** 条件里的回合引用：any 表示任意回合 */
export type TriggerTurnRef = number | 'any';

/** 条件里的触发器引用：any 表示任意触发器 */
export type TriggerTriggerRef = string | 'any';

/** 玩家意图类型（地图触发器的“上一个意图”断言取值） */
export const TRIGGER_INTENT_TYPES = [
  'MOVE',
  'ATTACK',
  'ADD_POINT',
  'SWITCH_PHASE',
  'SURRENDER',
  'CHOOSE_TEXT',
] as const;
export type TriggerIntentType = (typeof TRIGGER_INTENT_TYPES)[number];

/** 断言比较方式；changed = 本步骤前后该 gamestate 值发生变化（不需要预期值） */
export type TriggerCompare = '=' | '>' | '<' | '>=' | '<=' | 'changed';

/** 触发器里的 AI 难度取值 */
export type TriggerDifficulty = 1 | 2 | 3 | 255;

/** 文本屏幕方位：上下左右 + 四角 + 居中 */
export const TEXT_SCREEN_POSITIONS = [
  'top',
  'center',
  'bottom',
  'left',
  'right',
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const;
export type TextScreenPosition = (typeof TEXT_SCREEN_POSITIONS)[number];

/** 文本放置：屏幕方位或绑定到地块（互斥，二选一）；编辑器默认 screen + top-right */
export type TextPlacement =
  | { kind: 'screen'; position: TextScreenPosition }
  | { kind: 'tile'; tile: number };

export interface TriggerDef {
  /** 稳定唯一 id；禁止用数组下标 */
  id: string;
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
  // 变化类叶子：判定当前步骤增量 diff
  // 归属变化：tile=any 表示存在某地块；from/to 支持 seat、任意（any）、无主/中立（null）
  | { op: 'tile_owner_changed'; tile: TriggerTileRef; from: TriggerOwnerRef; to: TriggerOwnerRef }
  | { op: 'force_gone'; force: TriggerAnyForceRef }
  // 断言：读取白名单 gamestate 路径并与预期值比较（状态叶子；纯状态触发器走状态监听）
  // 预期值二选一：value = 具体值；value_ref = 另一个 gamestate 路径（引用的变量）
  // cmp = changed 时两者都不需要：只判定本步骤前后该路径的值是否变化
  | {
      op: 'state_assert';
      path: string;
      cmp: TriggerCompare;
      value?: number | string | boolean | null;
      value_ref?: string;
    }
  // 回合类叶子：判定事件链里的阶段/回合转换
  | { op: 'phase_start'; force: TriggerAnyForceRef; phase: TriggerPhaseRef; turn: TriggerTurnRef }
  | { op: 'phase_end'; force: TriggerAnyForceRef; phase: TriggerPhaseRef; turn: TriggerTurnRef }
  | { op: 'turn_start'; turn: TriggerTurnRef }
  // 连锁/历史叶子：两类事务都可使用
  | { op: 'trigger_fired'; trigger_id: TriggerTriggerRef };

export type TriggerEffect =
  | {
      op: 'spawn_soldier';
      tile: number;
      force: TriggerSpawnForceRef;
      strength: number;
      movement: boolean;
      // 链接固定为断兵、计次固定按地形默认反击次数，禁止脚本修改
    }
  | {
      op: 'update_soldier';
      tile: number;
      /** unchanged = 不修改该项；至少要有一项不是 unchanged。链接与计次不可改 */
      patch: {
        strength: number | 'unchanged';
        owner: number | 'unchanged';
        movement: boolean | 'unchanged';
      };
    }
  | { op: 'remove_soldier'; tile: number }
  | { op: 'set_terrain'; tile: number; terrain: number }
  | {
      op: 'update_force';
      force: TriggerForceRef;
      /** unchanged = 不修改该项；至少要有一项不是 unchanged */
      patch: {
        name: string | 'unchanged';
        flag: number | 'unchanged';
        team: number | 'unchanged';
        points: number | 'unchanged';
        computer: TriggerDifficulty | 'unchanged';
      };
    }
  | { op: 'clear_force'; force: TriggerForceRef }
  /** 把玩家当前势力的控制权交给新建的 AI 玩家（不再指定目标势力） */
  | { op: 'transfer_control'; ai_level: 1 | 2 | 255 }
  | { op: 'set_turn_order'; order: number[] }
  | { op: 'set_fog'; enabled: boolean | 'flipped' | 'unchanged'; reveal: number[]; hide: number[] }
  | { op: 'show_text'; text_id: string; text: string; placement: TextPlacement }
  /** 带选项的阻塞文本：首次显示等待选择，选择后关闭；再次显示不阻塞，仅回显已选项 */
  | { op: 'show_choice_text'; text_id: string; text: string; placement: TextPlacement; options: string[] }
  | { op: 'hide_text'; text_id: string }
  /** 设置数字变量：init 为具体值，init_ref 为创建时读取的 gamestate 快照值（二选一） */
  | { op: 'declare'; var_id: string; init?: number; init_ref?: string }
  /** 修改数字变量：param 为具体值，param_ref 为当前读取的 gamestate 值（二选一）；除法向下取整 */
  | {
      op: 'change';
      var_id: string;
      operator: '+' | '-' | '*' | '/' | '=';
      param?: number;
      param_ref?: string;
    }
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
  /** 纯状态触发器上一次求值结果（边沿触发用；旧存档缺失按空对象处理） */
  stateWatch?: Record<string, boolean>;
  pending: PendingTrigger[];
  /** 被接受的 HUMAN 玩家意图数 */
  intentSeq: number;
  /** END_TURN 次数（任何来源） */
  turnSeq: number;
  /** 下一次延时排期序号（确定性排序） */
  nextSerial: number;
  /** 触发器事务序号（任何来源的 applyIntent 事务） */
  transactionSeq: number;
  /** 最近一次成功执行的意图类型（旧存档缺省视为“无”） */
  lastIntentType?: TriggerIntentType;
  /** 触发器文本当前是否展示（textId → true；hide_text 时删除；旧存档缺省视为全部隐藏） */
  visibleTexts?: Record<string, boolean>;
  /** 触发器数字变量（declare 创建，change 修改；旧存档缺省视为空） */
  numberVars?: Record<string, number>;
  /** 选项文本已选下标（textId → index；选择后永久保留） */
  choiceValues?: Record<string, number>;
  /** 正在等待选择的选项文本（textId → 选项数量；选择后删除） */
  pendingChoices?: Record<string, number>;
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
