// pool.ts — 对手池管理（决策定稿 §6：保留最近 20 个 checkpoint，每局随机抽对手）
// 池状态持久化在 runs/weights/pool.json。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

export const POOL_MAX = 20;

export interface PoolState {
  /** checkpoint id 列表（含当前生效版本；id = 版本号字符串，如 'v3'） */
  pool: string[];
  /** 当前生效版本（最近被门限接受的） */
  current: string;
}

export function loadPool(weightsDir: string): PoolState {
  const file = path.join(weightsDir, 'pool.json');
  if (existsSync(file)) {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as PoolState;
    return { pool: raw.pool ?? [], current: raw.current ?? '' };
  }
  return { pool: ['v0'], current: 'v0' };
}

export function savePool(weightsDir: string, state: PoolState): void {
  mkdirSync(weightsDir, { recursive: true });
  writeFileSync(path.join(weightsDir, 'pool.json'), JSON.stringify(state, null, 2));
}

/** 抽取两个对手（独立随机，允许相同——自对弈可打自己）；池空时兜底 v0 */
export function drawOpponents(state: PoolState, rng: () => number = Math.random): [string, string] {
  const pool = state.pool.length > 0 ? state.pool : ['v0'];
  const pick = () => pool[Math.floor(rng() * pool.length)];
  return [pick(), pick()];
}

/** 接受新版本：加入池尾（成为 current），裁剪至 POOL_MAX */
export function acceptVersion(state: PoolState, version: string): void {
  state.pool = [...state.pool.filter((v) => v !== version), version];
  if (state.pool.length > POOL_MAX) state.pool = state.pool.slice(-POOL_MAX);
  state.current = version;
}
