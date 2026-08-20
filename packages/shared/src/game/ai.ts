// AI 策略层（A 延伸路线，D1/D3 拍板）：策略纯函数入 shared，由 reducer 内建调用。
// v1（2026-08-20 用户拍板）：难度 1~3 与 255 统一按休闲处理——planAiTurn 恒返回 skip
// （轮到即自动完成回合，不产生意图，对局永不因 AI 卡死）。
// 同时预留战场信息接口（buildAiView / listAiActions）：未来难度策略的输入视图与行动枚举。
// 本文件在确定性 lint 作用域内：策略实现必须保持纯函数（零随机、整数运算、全序排序）。
import type { GameState, ForceState, Phase, SoldierState } from './types.js';
import type { PlayerIntent } from '../protocol.js';
import { TERRAIN_PROPS, isFullBreak, isStrongholdTerrain, isNeutralOwner } from './constants.js';
import type { BoardGeometry } from './coord.js';
import { neighborsOf } from './coord.js';
import { hexDistance } from './distance.js';

/** AI 难度（与 AI_LEVEL / 地图 player_list[].computer 对齐） */
export type AiLevel = 1 | 2 | 3 | 255;

/** 单个兵位的战场信息（AI 决策用只读数据） */
export interface AiTileInfo {
  tile: number;
  terrain: number;
  strength: number;
  isLinked: boolean;
  hasMovement: boolean;
  /** 剩余反击次数（据点为 COUNTER_INFINITE） */
  counter: number;
  isStronghold: boolean;
}

/** 单个势力的战场摘要 */
export interface AiForceInfo {
  seat: number;
  team: number;
  name: string;
  computer: AiLevel;
  isAI: boolean;
  alive: boolean;
  points: number;
  strongholdCount: number;
  linkedCount: number;
  totalStrength: number;
  /** 该势力全部兵（线性 index 升序） */
  soldiers: AiTileInfo[];
}

/** AI 战场信息视图：未来难度策略的输入。纯函数构建，内容为该势力视角的全部可见信息 */
export interface AiBattlefieldView {
  seat: number;
  computer: AiLevel;
  turn: number;
  phase: Phase;
  currentSeat: number;
  rows: number;
  columns: number;
  cylindrical: boolean;
  me: AiForceInfo;
  /** 其他存在势力（seat 升序） */
  others: AiForceInfo[];
  /** 中立兵（野生/阻挡，index 升序） */
  neutralSoldiers: AiTileInfo[];
}

function tileInfo(state: GameState, index: number, soldier: SoldierState): AiTileInfo {
  return {
    tile: index,
    terrain: state.tiles[index].terrain,
    strength: soldier.strength,
    isLinked: soldier.isLinked,
    hasMovement: soldier.hasMovement,
    counter: soldier.counter,
    isStronghold: isStrongholdTerrain(state.tiles[index].terrain),
  };
}

/** 队伍判定（与 reducer 同语义）：中立兵不与任何势力同队 */
function sameTeam(state: GameState, a: number, b: number): boolean {
  if (isNeutralOwner(a) || isNeutralOwner(b)) return false;
  const fa = state.forces.find((f) => f.seat === a);
  const fb = state.forces.find((f) => f.seat === b);
  return !!fa && !!fb && fa.team === fb.team;
}

/**
 * 构建 AI 战场信息视图（获取战场信息的方法，纯函数）。
 * seat 不存在时返回 null；me/others 只含 exists 势力。
 */
export function buildAiView(state: GameState, seat: number): AiBattlefieldView | null {
  const me = state.forces.find((f) => f.seat === seat);
  if (!me || !me.exists) return null;

  const forceInfo = (f: ForceState): AiForceInfo => {
    const soldiers: AiTileInfo[] = [];
    let strongholdCount = 0;
    let linkedCount = 0;
    let totalStrength = 0;
    for (let i = 0; i < state.tiles.length; i++) {
      const s = state.tiles[i].soldier;
      if (!s || s.owner !== f.seat) continue;
      soldiers.push(tileInfo(state, i, s));
      totalStrength += s.strength;
      if (s.isLinked) linkedCount += 1;
      if (isStrongholdTerrain(state.tiles[i].terrain)) strongholdCount += 1;
    }
    return {
      seat: f.seat,
      team: f.team,
      name: f.name,
      computer: f.computer as AiLevel,
      isAI: f.isAI,
      alive: f.alive,
      points: f.points,
      strongholdCount,
      linkedCount,
      totalStrength,
      soldiers,
    };
  };

  const others: AiForceInfo[] = [];
  for (const f of state.forces) {
    if (!f.exists || f.seat === seat) continue;
    others.push(forceInfo(f));
  }
  const neutralSoldiers: AiTileInfo[] = [];
  for (let i = 0; i < state.tiles.length; i++) {
    const s = state.tiles[i].soldier;
    if (s && isNeutralOwner(s.owner)) neutralSoldiers.push(tileInfo(state, i, s));
  }
  return {
    seat,
    computer: me.computer as AiLevel,
    turn: state.turn,
    phase: state.phase,
    currentSeat: state.currentSeat,
    rows: state.rows,
    columns: state.columns,
    cylindrical: state.cylindrical,
    me: forceInfo(me),
    others,
    neutralSoldiers,
  };
}

/** 合法行动选项（MOVE 仅列空目标；ATTACK 仅列非同队目标；与 reducer 前置判定一致） */
export interface AiActionOption {
  kind: 'MOVE' | 'ATTACK';
  from: number;
  to: number;
}

/** 枚举 seat 当前可执行的合法行动（只读，不修改状态；非其回合/非行动阶段返回空） */
export function listAiActions(state: GameState, seat: number): AiActionOption[] {
  const options: AiActionOption[] = [];
  if (state.finished || state.currentSeat !== seat || state.phase !== 'ACTION') return options;
  const geo: BoardGeometry = { rows: state.rows, columns: state.columns, cylindrical: state.cylindrical };
  for (let from = 0; from < state.tiles.length; from++) {
    const s = state.tiles[from].soldier;
    if (!s || s.owner !== seat || !s.hasMovement) continue;
    if (s.isLinked && s.strength === 1) continue;
    for (const to of neighborsOf(from, geo)) {
      if (isFullBreak(state.tiles[to].terrain)) continue;
      const maxDist = TERRAIN_PROPS[state.tiles[to].terrain]?.moveDistance ?? 0;
      if (hexDistance(from, to, geo) > maxDist) continue;
      const target = state.tiles[to].soldier;
      if (!target) options.push({ kind: 'MOVE', from, to });
      else if (!sameTeam(state, s.owner, target.owner)) options.push({ kind: 'ATTACK', from, to });
    }
  }
  return options;
}

/** AI 回合决策结果：v1 恒 skip；未来难度策略返回 intents（由 reducer 按序演算） */
export type AiTurnPlan = { kind: 'skip' } | { kind: 'intents'; intents: PlayerIntent[] };

/**
 * AI 回合决策入口（reducer 内建调用，D1/D3）。
 * v1（2026-08-20 拍板）：难度 1~3 与 255 统一跳过行动+加点阶段（等效连续切阶段至回合结束）。
 * 未来难度策略实现：以 buildAiView / listAiActions 为输入演算，返回 intents 计划；
 * 策略必须是纯函数（确定性 lint 同样约束本文件），难度语义需与全序 tie-break 一同设计。
 */
export function planAiTurn(state: GameState, seat: number): AiTurnPlan {
  // v1：忽略战场信息，恒跳过（难度 1~3 与 255 行为一致）
  void state;
  void seat;
  return { kind: 'skip' };
}
