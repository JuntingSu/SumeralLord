// 对局状态逆 diff（PVE 悔棋用）：只记录一次意图造成的实际变化项，
// 悔棋时把 before 值写回当前状态，不需要重放意图或保存完整快照。
import type { ForceState, GameState, Phase, SoldierState, TileState } from './types.js';
import type { TriggerRuntime } from './trigger/types.js';

export interface GameStateDiff {
  /** 只包含发生变化的 tile；before 为深拷贝 */
  tiles: Array<{ index: number; before: TileState }>;
  /** 只包含发生变化的 force；before 为拷贝 */
  forces: Array<{ seat: number; before: ForceState }>;
  /** 标量 before（一局内不变的 seed/timeSettings/行列不记录） */
  turn: number;
  currentSeat: number;
  phase: Phase;
  finished: boolean;
  winners: string[] | null;
  winningTeam: number | null;
  /** 战役触发器运行态 before（普通对局 null） */
  triggerRuntime: TriggerRuntime | null;
  controlledSeat: number | null;
  humanPlayerId: number | null;
  turnOrder: number[];
  fogOverrides: { enabled?: boolean; revealed: number[]; hidden: number[] } | null;
  triggerMode: boolean;
}

function cloneSoldier(s: SoldierState | null): SoldierState | null {
  return s ? { ...s } : null;
}

function cloneRuntime(r: TriggerRuntime | null): TriggerRuntime | null {
  return r
    ? {
        ...r,
        firedCounts: { ...r.firedCounts },
        stateWatch: { ...(r.stateWatch ?? {}) },
        pending: r.pending.map((p) => ({ ...p })),
      }
    : null;
}

function cloneFog(
  f: { enabled?: boolean; revealed: number[]; hidden: number[] } | null,
): { enabled?: boolean; revealed: number[]; hidden: number[] } | null {
  return f ? { ...f, revealed: [...f.revealed], hidden: [...f.hidden] } : null;
}

function cloneTile(t: TileState): TileState {
  return { terrain: t.terrain, soldier: cloneSoldier(t.soldier) };
}

function sameSoldier(a: SoldierState | null, b: SoldierState | null): boolean {
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

/** 比较前后状态，生成逆 diff（只存变化项的 before） */
export function diffGameState(before: GameState, after: GameState): GameStateDiff {
  const tiles: GameStateDiff['tiles'] = [];
  for (let i = 0; i < before.tiles.length; i++) {
    if (!sameTile(before.tiles[i], after.tiles[i])) {
      tiles.push({ index: i, before: cloneTile(before.tiles[i]) });
    }
  }
  const afterForceBySeat = new Map(after.forces.map((f) => [f.seat, f]));
  const forces: GameStateDiff['forces'] = [];
  for (const f of before.forces) {
    const next = afterForceBySeat.get(f.seat);
    if (!next || !sameForce(f, next)) forces.push({ seat: f.seat, before: { ...f } });
  }
  return {
    tiles,
    forces,
    turn: before.turn,
    currentSeat: before.currentSeat,
    phase: before.phase,
    finished: before.finished,
    winners: before.winners ? [...before.winners] : null,
    winningTeam: before.winningTeam,
    triggerRuntime: cloneRuntime(before.triggerRuntime),
    controlledSeat: before.controlledSeat,
    humanPlayerId: before.humanPlayerId,
    turnOrder: [...before.turnOrder],
    fogOverrides: cloneFog(before.fogOverrides),
    triggerMode: before.triggerMode,
  };
}

/** 把逆 diff 应用到当前状态（当前状态应为该意图完成后的状态） */
export function applyInverseDiff(current: GameState, diff: GameStateDiff): GameState {
  const tiles = current.tiles.slice();
  for (const t of diff.tiles) tiles[t.index] = cloneTile(t.before);
  const forces = current.forces.map((f) => ({ ...f }));
  for (const f of diff.forces) {
    const index = forces.findIndex((x) => x.seat === f.seat);
    if (index >= 0) forces[index] = { ...f.before };
  }
  return {
    ...current,
    tiles,
    forces,
    turn: diff.turn,
    currentSeat: diff.currentSeat,
    phase: diff.phase,
    finished: diff.finished,
    winners: diff.winners ? [...diff.winners] : null,
    winningTeam: diff.winningTeam,
    triggerRuntime: cloneRuntime(diff.triggerRuntime),
    controlledSeat: diff.controlledSeat,
    humanPlayerId: diff.humanPlayerId,
    turnOrder: [...diff.turnOrder],
    fogOverrides: cloneFog(diff.fogOverrides),
    triggerMode: diff.triggerMode,
  };
}
