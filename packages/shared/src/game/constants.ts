// 地形属性表与对局常量（规则 v2 §3）
import { TERRAIN, TILE_OWNER } from '../types.js';

/** 据点反击次数 ∞（每次反击 -1，实际对局不可能耗尽；JSON 安全整数） */
export const COUNTER_INFINITE = 1_000_000_000;

export type Connectivity = 'FULL_BREAK' | 'HALF' | 'NORMAL' | 'FULL_LINK';

export interface TerrainProps {
  name: string;
  /** 连通性（§3.2）：全断不可存在兵不可通过；半断永为断兵；可接不限；全接永为连兵 */
  connectivity: Connectivity;
  /** 据点性：拥有该势力兵时计入据点数 */
  isStronghold: boolean;
  /** 地形反击次数（准备阶段刷新值；阻挡兵除外永不刷新） */
  counter: number;
  /** 移动距离上限（当前可进入地形均为 1=邻格） */
  moveDistance: number;
  /** 海洋-进入失活：从海洋出发进入该地形失去移动力 */
  oceanEnterInactive: boolean;
  /** 接触失活：非同队兵移动到该地块邻格时失去移动力 */
  contactInactive: boolean;
}

/** 地形属性表（§3.1）。编码 2（原王城）已废弃空缺，不在此出现 */
export const TERRAIN_PROPS: Record<number, TerrainProps> = {
  [TERRAIN.PLAIN]: {
    name: '平原',
    connectivity: 'NORMAL',
    isStronghold: false,
    counter: 1,
    moveDistance: 1,
    oceanEnterInactive: true,
    contactInactive: false,
  },
  [TERRAIN.CITY]: {
    name: '据点',
    connectivity: 'FULL_LINK',
    isStronghold: true,
    counter: COUNTER_INFINITE,
    moveDistance: 1,
    oceanEnterInactive: true,
    contactInactive: true,
  },
  [TERRAIN.OCEAN]: {
    name: '海洋',
    connectivity: 'HALF',
    isStronghold: false,
    counter: 1,
    moveDistance: 1,
    oceanEnterInactive: false,
    contactInactive: false,
  },
  [TERRAIN.MOUNTAIN]: {
    name: '山地',
    connectivity: 'FULL_BREAK',
    isStronghold: false,
    counter: 0,
    moveDistance: 0,
    oceanEnterInactive: false,
    contactInactive: false,
  },
  [TERRAIN.VOID]: {
    name: '虚空',
    connectivity: 'FULL_BREAK',
    isStronghold: false,
    counter: 0,
    moveDistance: 0,
    oceanEnterInactive: false,
    contactInactive: false,
  },
};

export const isFullBreak = (terrain: number): boolean => TERRAIN_PROPS[terrain]?.connectivity === 'FULL_BREAK';
export const isHalf = (terrain: number): boolean => TERRAIN_PROPS[terrain]?.connectivity === 'HALF';
export const isFullLink = (terrain: number): boolean => TERRAIN_PROPS[terrain]?.connectivity === 'FULL_LINK';
export const isStrongholdTerrain = (terrain: number): boolean => TERRAIN_PROPS[terrain]?.isStronghold === true;

/** 中立兵归属（不属于任何势力：无座次、不轮转、无点数） */
export const isNeutralOwner = (owner: number): boolean =>
  owner === TILE_OWNER.WILD || owner === TILE_OWNER.BLOCKER;

/** 阻挡兵（owner=255）：永远没有反击次数，这是它与野生兵的唯一区别（§9） */
export const isBlockerOwner = (owner: number): boolean => owner === TILE_OWNER.BLOCKER;
