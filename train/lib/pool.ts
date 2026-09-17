// 图池工具（M4）：地图落盘、b 估计、CI 过滤、池管理
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { MapFullData } from '@dl/shared';
import { generateTrainMap } from './mapgen.js';
import { createRng } from './rng.js';

export interface BRecord {
  mapId: string;
  mapSeed: string;
  rows: number;
  columns: number;
  strongholdsPerSide: number;
  /** 先手（seat1）胜率估计 */
  bHat: number;
  /** 先手胜局数 / 总局数 */
  wins: number;
  games: number;
  /** 终局/截断统计 */
  finished: number;
  truncated: number;
  se: number;
  /** 终局局回合分布（M5 标定用） */
  resolvedMedianTurns: number | null;
  resolvedP90Turns: number | null;
}

export const ACCEPT_LOW = 0.2;
export const ACCEPT_HIGH = 0.8;
/** N=200 时 SE≈3.5%，单侧 95%（1.64·SE）过滤阈值 */
export const CI_Z = 1.64;

export function seOf(bHat: number, n: number): number {
  return Math.sqrt((bHat * (1 - bHat)) / n);
}

/** CI 过滤：剔除 b̂ 出 [低−z·SE, 高+z·SE] 之外（有把握病态才剔除） */
export function isDegenerate(bHat: number, n: number): boolean {
  const se = seOf(bHat, n);
  return bHat > ACCEPT_HIGH + CI_Z * se || bHat < ACCEPT_LOW - CI_Z * se;
}

/** 点估计口径入池判定（补齐轮用）：0.2 < b̂ < 0.8 */
export function passesBand(bHat: number): boolean {
  return bHat > ACCEPT_LOW && bHat < ACCEPT_HIGH;
}

const MAP_DIR = 'train/data/maps';

export function mapFile(mapId: string): string {
  return path.join(MAP_DIR, `${mapId}.json`);
}

export function saveMap(map: MapFullData): void {
  mkdirSync(MAP_DIR, { recursive: true });
  writeFileSync(mapFile(map.id), JSON.stringify(map));
}

export function loadMap(mapId: string): MapFullData {
  return JSON.parse(readFileSync(mapFile(mapId), 'utf8')) as MapFullData;
}

export function mapIdOf(seed: string, index: number): string {
  return `pool_${seed}_${index}`;
}

export interface PoolRecord {
  b: BRecord[];
  extreme: BRecord[];
  rejected: BRecord[];
}

/** 生成一张训练图（尺寸/据点采样由 seed 决定） */
export function makePoolMap(mapSeed: string, index: number, strongholdsPerSide?: 1 | 2): MapFullData {
  const rng = createRng(mapSeed);
  const sh: 1 | 2 = strongholdsPerSide ?? (rng() % 2 === 0 ? 1 : 2);
  return generateTrainMap(mapSeed, undefined, sh);
}
