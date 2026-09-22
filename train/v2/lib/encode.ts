// encode.ts — v2 状态编码（决策定稿 §3）：变长全格 token + CLS 全局特征
//
// 每格 token 14 维（当前行动方相对视角）：
//   [0..4]  地形 one-hot（平原/据点/海洋/山地/虚空）
//   [5]     兵力（原值；空 = 0）
//   [6..10] 归属 one-hot（空/我方/敌方/野生/阻挡）
//   [11]    连断（1 = 连兵；空 = 0）
//   [12]    移动力（1 = 有；空 = 0）
//   [13]    剩余反击次数（min(counter, 2)，2 表示据点 ∞）
//
// CLS token 14 维：
//   [0]     回合数
//   [1..4]  阶段 one-hot（PREPARE/ACTION/ADD_POINT/END）
//   [5]     行动方座次（绝对座次，1v1 为 1/2）
//   [6]     我方总兵力
//   [7]     敌方总兵力
//   [8]     我方连兵数
//   [9]     敌方连兵数
//   [10]    我方据点数
//   [11]    敌方据点数
//   [12]    我方当前可支配点数
//   [13]    敌方当前可支配点数
import { isStrongholdTerrain, TERRAIN, TILE_OWNER } from '@dl/shared';
import type { GameState, Phase, SoldierState } from '@dl/shared';

export const TILE_FEATURES = 14;
export const CLS_FEATURES = 14;

const TERRAIN_ORDER = [TERRAIN.PLAIN, TERRAIN.CITY, TERRAIN.OCEAN, TERRAIN.MOUNTAIN, TERRAIN.VOID] as const;
const PHASE_ORDER: readonly Phase[] = ['PREPARE', 'ACTION', 'ADD_POINT', 'END'];

/** 当前行动方视角的敌方座次（1v1：另一存活势力；无则 -1） */
export function otherSeat(state: GameState, seat: number): number {
  for (const f of state.forces) {
    if (f.exists && f.alive && f.seat !== seat) return f.seat;
  }
  return -1;
}

/** 归属类别（相对视角）：0 空 / 1 我方 / 2 敌方 / 3 野生 / 4 阻挡 */
function ownerCategory(owner: number, seat: number, enemy: number): number {
  if (owner === seat) return 1;
  if (owner === TILE_OWNER.WILD) return 3;
  if (owner === TILE_OWNER.BLOCKER) return 4;
  return 2; // 其他势力（1v1 中即敌方）
}

export interface EncodedState {
  /** CLS 全局特征（CLS_FEATURES 维） */
  cls: number[];
  /** 每格 token（长度 = 格子数，每项 TILE_FEATURES 维） */
  tiles: number[][];
}

export function encodeState(state: GameState): EncodedState {
  const seat = state.currentSeat;
  const enemy = otherSeat(state, seat);
  return {
    cls: encodeCls(state, seat, enemy),
    tiles: state.tiles.map((t) => encodeTile(t.terrain, t.soldier, seat, enemy)),
  };
}

function encodeTile(terrain: number, soldier: SoldierState | null, seat: number, enemy: number): number[] {
  const v = new Array<number>(TILE_FEATURES).fill(0);
  const ti = TERRAIN_ORDER.indexOf(terrain as (typeof TERRAIN_ORDER)[number]);
  if (ti >= 0) v[ti] = 1;
  if (soldier) {
    v[5] = soldier.strength;
    v[6 + ownerCategory(soldier.owner, seat, enemy)] = 1;
    v[11] = soldier.isLinked ? 1 : 0;
    v[12] = soldier.hasMovement ? 1 : 0;
    v[13] = Math.min(soldier.counter, 2); // 2 = 据点 ∞
  } else {
    v[6] = 1; // 归属 = 空
  }
  return v;
}

function encodeCls(state: GameState, seat: number, enemy: number): number[] {
  const v = new Array<number>(CLS_FEATURES).fill(0);
  v[0] = state.turn;
  const pi = PHASE_ORDER.indexOf(state.phase);
  if (pi >= 0) v[1 + pi] = 1;
  v[5] = seat;

  const agg = (s: number) => {
    let strength = 0;
    let linked = 0;
    let stronghold = 0;
    let points = 0;
    const f = state.forces.find((x) => x.seat === s);
    points = f?.points ?? 0;
    for (const t of state.tiles) {
      const so = t.soldier;
      if (!so || so.owner !== s) continue;
      strength += so.strength;
      if (so.isLinked) linked++;
      if (isStrongholdTerrain(t.terrain)) stronghold++;
    }
    return { strength, linked, stronghold, points };
  };
  const mine = agg(seat);
  const theirs = enemy >= 0 ? agg(enemy) : { strength: 0, linked: 0, stronghold: 0, points: 0 };
  v[6] = mine.strength;
  v[7] = theirs.strength;
  v[8] = mine.linked;
  v[9] = theirs.linked;
  v[10] = mine.stronghold;
  v[11] = theirs.stronghold;
  v[12] = mine.points;
  v[13] = theirs.points;
  return v;
}
