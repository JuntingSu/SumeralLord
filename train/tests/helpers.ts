// helpers.ts — 单测用手工局面构造
import { TERRAIN_PROPS } from '@dl/shared';
import type { GameState, SoldierState, TileState } from '@dl/shared';

export function makeSoldier(
  owner: number,
  strength: number,
  isLinked: boolean,
  hasMovement = false,
): SoldierState {
  return { owner, strength, isLinked, hasMovement, counter: 1 };
}

export interface TileSpec {
  terrain: number;
  soldier?: SoldierState | null;
}

/** 构造 1v1 合成 GameState（绕过 initState，精确控制局面） */
export function makeState(opts: {
  rows: number;
  columns: number;
  tiles: TileSpec[];
  turn?: number;
  currentSeat?: number;
  phase?: GameState['phase'];
}): GameState {
  const tiles: TileState[] = opts.tiles.map((t) => ({
    terrain: t.terrain,
    soldier: t.soldier ?? null,
  }));
  if (tiles.length !== opts.rows * opts.columns) {
    throw new Error(`tiles 数量 ${tiles.length} != rows*columns ${opts.rows * opts.columns}`);
  }
  return {
    rows: opts.rows,
    columns: opts.columns,
    cylindrical: false,
    seed: 'test',
    turn: opts.turn ?? 1,
    currentSeat: opts.currentSeat ?? 1,
    phase: opts.phase ?? 'ACTION',
    forces: [
      { seat: 1, team: 1, name: 'A', flag: 1, playerId: 900001, isAI: false, computer: 2, exists: true, alive: true, points: 0 },
      { seat: 2, team: 2, name: 'B', flag: 2, playerId: 900002, isAI: false, computer: 2, exists: true, alive: true, points: 0 },
    ],
    tiles,
    timeSettings: { stepTime: 30, gameTime: 600, additionalTime: 10 },
    finished: false,
    winners: null,
    winningTeam: null,
  };
}

/** 地形便捷值（对齐 TERRAIN_PROPS counter） */
export function terrainCounter(terrain: number): number {
  return TERRAIN_PROPS[terrain]?.counter ?? 0;
}

/** 单行棋盘便捷构造：cells 依次为 tile 0..n-1（rows=1，邻接仅左右） */
export function lineState(cells: TileSpec[], turn = 1): GameState {
  return makeState({ rows: 1, columns: cells.length, tiles: cells, turn });
}
