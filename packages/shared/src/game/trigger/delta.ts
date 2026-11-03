// 增量 diff 追踪与事件链阶段/回合转换提取。
// 触发器条件只看“本步骤实际改了什么”；StepDirty 在每次写状态前记录 before 值。
import type { ForceState, GameEvent, GameState, Phase, TileState } from '../types.js';
import type { TriggerDelta, WorldTransition } from './types.js';

export interface StepDirty {
  enabled: boolean;
  tiles: Set<number>;
  forces: Set<number>;
  beforeTiles: Map<number, TileState>;
  beforeForces: Map<number, ForceState>;
}

export function createStepDirty(enabled: boolean): StepDirty {
  return {
    enabled,
    tiles: new Set(),
    forces: new Set(),
    beforeTiles: new Map(),
    beforeForces: new Map(),
  };
}

export function resetStepDirty(dirty: StepDirty): void {
  dirty.tiles.clear();
  dirty.forces.clear();
  dirty.beforeTiles.clear();
  dirty.beforeForces.clear();
}

function cloneTile(t: TileState): TileState {
  return { terrain: t.terrain, soldier: t.soldier ? { ...t.soldier } : null };
}

function sameSoldier(a: TileState['soldier'], b: TileState['soldier']): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.owner === b.owner &&
    a.strength === b.strength &&
    a.isLinked === b.isLinked &&
    a.hasMovement === b.hasMovement &&
    a.counter === b.counter
  );
}

function sameTile(a: TileState, b: TileState): boolean {
  return a.terrain === b.terrain && sameSoldier(a.soldier, b.soldier);
}

function sameForce(a: ForceState, b: ForceState): boolean {
  return (
    a.seat === b.seat &&
    a.team === b.team &&
    a.name === b.name &&
    a.flag === b.flag &&
    a.playerId === b.playerId &&
    a.isAI === b.isAI &&
    a.computer === b.computer &&
    a.exists === b.exists &&
    a.alive === b.alive &&
    a.points === b.points
  );
}

/** 写状态前调用：首次触及时保存该地块 before 快照 */
export function trackTile(dirty: StepDirty, state: GameState, index: number): void {
  if (!dirty.enabled) return;
  dirty.tiles.add(index);
  if (!dirty.beforeTiles.has(index)) dirty.beforeTiles.set(index, cloneTile(state.tiles[index]));
}

/** 写状态前调用：首次触及时保存该势力 before 快照 */
export function trackForce(dirty: StepDirty, state: GameState, seat: number): void {
  if (!dirty.enabled) return;
  dirty.forces.add(seat);
  if (!dirty.beforeForces.has(seat)) {
    const f = state.forces.find((x) => x.seat === seat);
    if (f) dirty.beforeForces.set(seat, { ...f });
  }
}

/** 取出本步骤实际变化并清空追踪；beforeState 供 diff.before 使用（条件只用 tiles/forces） */
export function takeDelta(dirty: StepDirty, state: GameState, beforeState: GameState): TriggerDelta {
  const tiles: TriggerDelta['tiles'] = [];
  for (const index of [...dirty.tiles].sort((a, b) => a - b)) {
    const before = dirty.beforeTiles.get(index);
    if (!before) continue;
    const after = state.tiles[index];
    if (!sameTile(before, after)) {
      tiles.push({ index, before: cloneTile(before), after: cloneTile(after) });
    }
  }
  const forces: TriggerDelta['forces'] = [];
  for (const seat of [...dirty.forces].sort((a, b) => a - b)) {
    const before = dirty.beforeForces.get(seat);
    const after = state.forces.find((f) => f.seat === seat);
    if (!before || !after) continue;
    if (!sameForce(before, after)) forces.push({ seat, before: { ...before }, after: { ...after } });
  }
  resetStepDirty(dirty);
  return { before: beforeState, after: state, tiles, forces };
}

export interface TransitionScan {
  transitions: WorldTransition[];
  /** 下次继续扫描的 chain 下标 */
  nextIndex: number;
  /** 本段新增的 END_TURN 次数（turnSeq 用） */
  turnSeqDelta: number;
  /** 扫描结束时的游标，供后续追加事件续扫 */
  cursor: TransitionCursor;
}

export interface TransitionCursor {
  turn: number;
  seat: number;
  phase: Phase;
}

/**
 * 从 chain[startIndex] 起提取阶段/回合转换。
 * SWITCH_PHASE 同时产生 PHASE_END 与 PHASE_START；END_TURN 产生 TURN_CHANGE，
 * 全局 turn 增加时额外产生 TURN_START。一次意图链可含多个转换。
 */
export function collectTransitions(
  chain: GameEvent[],
  startIndex: number,
  initial: TransitionCursor,
): TransitionScan {
  let turn = initial.turn;
  let seat = initial.seat;
  let phase = initial.phase;
  let turnSeqDelta = 0;
  const transitions: WorldTransition[] = [];
  for (let i = startIndex; i < chain.length; i++) {
    const e = chain[i];
    if (e.kind === 'SWITCH_PHASE') {
      transitions.push({ kind: 'PHASE_END', seat: e.seat, phase: e.from, turn, eventIndex: i });
      transitions.push({ kind: 'PHASE_START', seat: e.seat, phase: e.to, turn, eventIndex: i });
      seat = e.seat;
      phase = e.to;
    } else if (e.kind === 'END_TURN') {
      const prevTurn = turn;
      turn = e.turn;
      seat = e.toSeat;
      phase = 'PREPARE';
      turnSeqDelta += 1;
      transitions.push({ kind: 'TURN_CHANGE', seat: e.toSeat, phase, turn, eventIndex: i });
      if (turn !== prevTurn) {
        transitions.push({ kind: 'TURN_START', seat: e.toSeat, phase, turn, eventIndex: i });
      }
    }
  }
  return { transitions, nextIndex: chain.length, turnSeqDelta, cursor: { turn, seat, phase } };
}
