// actions.ts — v2 原子动作空间与合法掩码（决策定稿 §3/§5）
//
// 动作索引布局（nTiles = 地图格子数）：
//   [0, nTiles×6)          每格 6 方向（移动/进攻共用：目标为敌兵时 reducer 自动转进攻）
//   [nTiles×6, nTiles×38)  每格 32 个加点档（+1..+32，掩码过滤超出剩余点数的档位）
//   [nTiles×38]            全局切换阶段（SWITCH_PHASE）
//
// 掩码与 reducer 的意图校验一一对应（每个掩码合法动作必然被 applyIntent 接受），
// 由 actions.test.ts 的对拍测试保证。
import { isFullBreak, neighborsOf, TILE_OWNER } from '@dl/shared';
import type { GameState, PlayerIntent } from '@dl/shared';

export const DIRS_PER_TILE = 6;
export const ADD_AMOUNT_MAX = 32;
export const ACTIONS_PER_TILE = DIRS_PER_TILE + ADD_AMOUNT_MAX; // 38

/** 动作空间总大小（给定格子数；+1 = 全局切换阶段） */
export function actionCount(nTiles: number): number {
  return nTiles * ACTIONS_PER_TILE + 1;
}

/** 方向动作索引（dir ∈ [0, 6)，对应邻居表顺序） */
export function dirActionIndex(tile: number, dir: number): number {
  return tile * ACTIONS_PER_TILE + dir;
}

/** 加点动作索引（amount ∈ [1, 32]） */
export function addActionIndex(tile: number, amount: number): number {
  return tile * ACTIONS_PER_TILE + DIRS_PER_TILE + (amount - 1);
}

/** 切换阶段动作索引 */
export function switchActionIndex(nTiles: number): number {
  return nTiles * ACTIONS_PER_TILE;
}

/** 同队判定：座位相等或队伍号相同；中立兵（野生/阻挡）与任何势力不同队 */
export function sameTeam(state: GameState, a: number, b: number): boolean {
  if (a === b) return true;
  const fa = state.forces.find((f) => f.seat === a);
  const fb = state.forces.find((f) => f.seat === b);
  return fa !== undefined && fb !== undefined && fa.team === fb.team;
}

/** 合法动作掩码（1 = 合法），长度 actionCount(nTiles)；与 reducer 校验语义一致 */
export function legalMask(state: GameState): Uint8Array {
  const n = state.tiles.length;
  const mask = new Uint8Array(actionCount(n));
  const seat = state.currentSeat;
  const geo = { rows: state.rows, columns: state.columns, cylindrical: state.cylindrical };

  if (state.phase === 'ACTION') {
    for (let t = 0; t < n; t++) {
      const s = state.tiles[t].soldier;
      if (!s || s.owner !== seat) continue;
      // 无移动力 / 兵力 1 连兵（永无移动力）→ 不可行动
      if (!s.hasMovement || (s.isLinked && s.strength === 1)) continue;
      const nbs = neighborsOf(t, geo);
      for (let d = 0; d < nbs.length; d++) {
        const nb = nbs[d];
        if (isFullBreak(state.tiles[nb].terrain)) continue; // 全断不可进入
        const ts = state.tiles[nb].soldier;
        if (ts && sameTeam(state, seat, ts.owner)) continue; // 同队不可进入/进攻
        mask[dirActionIndex(t, d)] = 1;
      }
    }
  } else if (state.phase === 'ADD_POINT') {
    const force = state.forces.find((f) => f.seat === seat);
    if (force && force.points > 0) {
      const maxAmt = Math.min(ADD_AMOUNT_MAX, force.points);
      for (let t = 0; t < n; t++) {
        const s = state.tiles[t].soldier;
        if (!s || s.owner !== seat || !s.isLinked) continue; // 只能给本势力连兵加点
        for (let amt = 1; amt <= maxAmt; amt++) mask[addActionIndex(t, amt)] = 1;
      }
    }
  }

  // 切换阶段：行动/加点阶段恒合法
  if (state.phase === 'ACTION' || state.phase === 'ADD_POINT') {
    mask[switchActionIndex(n)] = 1;
  }
  return mask;
}

/** 动作索引 → 意图（调用方须保证掩码合法性）。
 * 布局为每格交错：tile 的 [0..5] 为方向、[6..37] 为加点，非连续区间。 */
export function actionToIntent(state: GameState, idx: number): PlayerIntent {
  const n = state.tiles.length;
  if (idx === switchActionIndex(n)) return { intentType: 'SWITCH_PHASE' };
  const geo = { rows: state.rows, columns: state.columns, cylindrical: state.cylindrical };
  const tile = Math.floor(idx / ACTIONS_PER_TILE);
  const per = idx % ACTIONS_PER_TILE;
  if (per < DIRS_PER_TILE) {
    return { intentType: 'MOVE', from: tile, to: neighborsOf(tile, geo)[per] };
  }
  return { intentType: 'ADD_POINT', coordinate: tile, amount: per - DIRS_PER_TILE + 1 };
}

/**
 * 意图 → 动作索引（actionToIntent 的逆映射；标注/示范转换用）。
 * MOVE 与 ATTACK 映射到同一索引（移动进敌格自动转进攻，动作空间不区分）。
 * ADD_POINT 金额 > 32 时返回 null（调用方拆分为多个 ≤32 的步骤）；其余非法形状返回 null。
 */
export function intentToAction(state: GameState, intent: PlayerIntent): number | null {
  const geo = { rows: state.rows, columns: state.columns, cylindrical: state.cylindrical };
  switch (intent.intentType) {
    case 'MOVE':
    case 'ATTACK': {
      const nbs = neighborsOf(intent.from, geo);
      const dir = nbs.indexOf(intent.to);
      if (dir < 0) return null; // 非邻格：不合法
      return dirActionIndex(intent.from, dir);
    }
    case 'ADD_POINT': {
      if (intent.amount < 1 || intent.amount > ADD_AMOUNT_MAX) return null;
      return addActionIndex(intent.coordinate, intent.amount);
    }
    case 'SWITCH_PHASE':
      return switchActionIndex(state.tiles.length);
    default:
      return null;
  }
}

/** 合法动作索引列表（掩码中为 1 的索引，升序） */
export function legalActionList(state: GameState): number[] {
  const mask = legalMask(state);
  const out: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i] === 1) out.push(i);
  return out;
}

/** 中立归属（野生/阻挡）——掩码辅助判定 */
export function isNeutralOwner(owner: number): boolean {
  return owner === TILE_OWNER.WILD || owner === TILE_OWNER.BLOCKER;
}
