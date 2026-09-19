// board.ts — 评估层共享的棋盘紧凑视图与基础查询（一次提取、多处复用）
import { TILE_OWNER, hexDistance, isFullBreak, isFullLink } from '@dl/shared';
import type { BoardGeometry, GameState, SoldierState } from '@dl/shared';

/** 棋盘紧凑视图：评估计算全部基于本视图（纯函数、不改 GameState） */
export interface Board {
  geo: BoardGeometry;
  size: number;
  terrain: Uint8Array;
  /** -1 = 无兵；其余 = owner（seat / 0 野生 / 255 阻挡） */
  owner: Int16Array;
  strength: Int16Array;
  /** 1 = 连兵 */
  linked: Uint8Array;
}

export function extractBoard(state: GameState): Board {
  const size = state.tiles.length;
  const terrain = new Uint8Array(size);
  const owner = new Int16Array(size).fill(-1);
  const strength = new Int16Array(size);
  const linked = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    const t = state.tiles[i];
    terrain[i] = t.terrain;
    const s = t.soldier;
    if (s) {
      owner[i] = s.owner;
      strength[i] = s.strength;
      linked[i] = s.isLinked ? 1 : 0;
    }
  }
  return { geo: { rows: state.rows, columns: state.columns, cylindrical: state.cylindrical }, size, terrain, owner, strength, linked };
}

/** 进攻力（战斗规则 v2 §4.4）：连兵 = 兵力 − 1，断兵 = 兵力 */
export function attackPowerOf(strength: number, linked: boolean): number {
  return linked ? strength - 1 : strength;
}

export function soldierAt(b: Board, tile: number): SoldierState | null {
  if (b.owner[tile] < 0) return null;
  return {
    owner: b.owner[tile],
    strength: b.strength[tile],
    isLinked: b.linked[tile] === 1,
    hasMovement: false,
    counter: 1,
  };
}

export function soldiersOf(b: Board, seat: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < b.size; i++) if (b.owner[i] === seat) out.push(i);
  return out;
}

export function totalStrengthOf(b: Board, seat: number): number {
  let sum = 0;
  for (let i = 0; i < b.size; i++) if (b.owner[i] === seat) sum += b.strength[i];
  return sum;
}

export function linkedCountOf(b: Board, seat: number): number {
  let n = 0;
  for (let i = 0; i < b.size; i++) if (b.owner[i] === seat && b.linked[i] === 1) n++;
  return n;
}

/** 敌方 seat（1v1：另一个存活势力） */
export function otherSeat(state: GameState, seat: number): number {
  for (const f of state.forces) {
    if (f.exists && f.alive && f.seat !== seat) return f.seat;
  }
  return -1;
}

/** 敌方据点格：地形具据点性且驻有敌方兵（据点数语义：有该势力兵的据点地块） */
export function strongholdTilesOf(b: Board, seat: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < b.size; i++) {
    if (isFullLink(b.terrain[i]) && b.owner[i] === seat) out.push(i);
  }
  return out;
}

/** 全断地形（山地/虚空）：不可存在兵、不可通过 */
export function isImpassableTerrain(terrain: number): boolean {
  return isFullBreak(terrain);
}

export function isBlocker(b: Board, tile: number): boolean {
  return b.owner[tile] === TILE_OWNER.BLOCKER;
}

/** 两格 hex 距离（滚筒地图按列 wrap 取最小，复用 shared 整数实现） */
export function hexDistanceTo(b: Board, a: number, c: number): number {
  return hexDistance(a, c, b.geo);
}
