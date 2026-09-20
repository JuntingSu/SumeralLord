// addpoint.ts — 加点阶段算法（设计方案 §2.2，M=1 唯一方案；2026-09-20 修订：前中期加点限制）
// 规则1（防断电，可达威胁）→ 规则2（防击杀，邻格威胁）→ 规则3（E_te 引导饱和分配）。
// 规则1/2 全有或全无；规则3 逐点抽签（局面哈希做种子，同局面同分配）。
// 修订：回合数 < T（前中期）时，只允许在"周围有空据点/空平原"的连兵上加点的候选集过滤，
// 规则的优先级与分配机制沿用原方案；回合数 ≥ T（残局）恢复全部连兵可加点。
import { TERRAIN, neighborsOf } from '@dl/shared';
import type { GameState, PlayerIntent } from '@dl/shared';
import { hashGameState } from '@dl/shared';
import type { Board } from './board.js';
import { attackPowerOf, extractBoard } from './board.js';
import { battleReach, cutVertices, linkedSet, linkedSetAfterRemoval } from './battlefield.js';
import { evalTe, phaseThreshold, type TeWeights } from './eval.js';

export interface AddPointOptions {
  /** 无限加点池比例（默认 0.2，向上取整） */
  poolRatio?: number;
  /** 前中期候选资格过滤（内部使用） */
  eligible?: (tile: number) => boolean;
}

interface DefenseCandidate {
  tile: number;
  isCut: boolean;
  /** 断电规模：被吃后我方连兵减少量（含自身） */
  deLinkScale: number;
  /** 威胁进攻力 */
  threat: number;
  /** 所需防御点数（使兵力 > 威胁进攻力） */
  need: number;
}

/**
 * 加点意图序列（在 ADD_POINT 相位逐条应用；点数用尽由 reducer 自动切阶段）。
 * state：行动后局面（本轮加点对象）；turnStart：回合开始局面（E_te 双快照基准）。
 */
export function planAddPoints(
  state: GameState,
  turnStart: GameState,
  seat: number,
  weights: TeWeights,
  opts?: AddPointOptions,
): PlayerIntent[] {
  const force = state.forces.find((f) => f.seat === seat);
  const points = force?.points ?? 0;
  if (points <= 0) return [];
  const b = extractBoard(state);
  const enemy = state.forces.find((f) => f.exists && f.alive && f.seat !== seat)?.seat ?? -1;
  const intents: PlayerIntent[] = [];
  let remaining = points;

  // 前中期限制（2026-09-20）：回合数 < T 时，只允许在"周围有空据点/空平原"的连兵上加点
  const restrict = state.turn < phaseThreshold(state.rows, state.columns);
  const isEligible = (tile: number): boolean => !restrict || hasEmptyLandNeighbor(b, tile);

  // ---- 规则1 + 规则2：统一候选集，排序 =（是否割点、断电规模降序）----
  const candidates = collectDefenseCandidates(b, seat, enemy).filter((c) => isEligible(c.tile));
  const allocations: Array<{ tile: number; amount: number }> = [];
  for (const c of candidates) {
    if (c.need <= 0) continue;
    if (remaining < c.need) continue; // 全有或全无：不足则整兵跳过
    allocations.push({ tile: c.tile, amount: c.need });
    intents.push({ intentType: 'ADD_POINT', coordinate: c.tile, amount: c.need });
    remaining -= c.need;
  }

  // ---- 规则3：E_te 引导饱和分配（在规则1/2 分配后的局面探测；剩余点数逐点抽签）----
  if (remaining > 0) {
    const post12 = allocations.length > 0 ? applyAllocations(state, allocations) : state;
    intents.push(...saturateAssign(post12, turnStart, seat, weights, remaining, { ...opts, eligible: isEligible }));
  }
  return intents;
}

/** 周围（距离 1）有空据点/空平原 的兵（前中期加点候选资格） */
export function hasEmptyLandNeighbor(b: Board, tile: number): boolean {
  for (const nb of neighborsOf(tile, b.geo)) {
    const terrain = b.terrain[nb];
    if ((terrain === TERRAIN.PLAIN || terrain === TERRAIN.CITY) && b.owner[nb] < 0) return true;
  }
  return false;
}

/** 规则1/2 分配后的模拟局面（ADD_POINT 只加兵力、无级联事件 → 直接构兵） */
function applyAllocations(state: GameState, allocations: Array<{ tile: number; amount: number }>): GameState {
  const bump = new Map<number, number>();
  for (const a of allocations) bump.set(a.tile, (bump.get(a.tile) ?? 0) + a.amount);
  const tiles = state.tiles.map((t, i) => {
    const amount = bump.get(i);
    if (!amount || !t.soldier) return t;
    return { ...t, soldier: { ...t.soldier, strength: t.soldier.strength + amount } };
  });
  return { ...state, tiles };
}

/** 规则1（割点型连兵，可达威胁）∪ 规则2（邻格有敌兵的连兵，贴脸威胁） */
function collectDefenseCandidates(b: Board, seat: number, enemy: number): DefenseCandidate[] {
  const geo = b.geo;
  if (enemy < 0) return [];
  const cuts = new Set(cutVertices(b, seat, {})); // 规则1 防守对象：不做威胁排除
  const reach = battleReach(b, enemy); // 敌方可达网络（抵达后进攻力）
  const linkedBefore = linkedSet(b, seat).size;

  const out: DefenseCandidate[] = [];
  for (const tile of linkedSet(b, seat)) {
    const strength = b.strength[tile];
    const isCut = cuts.has(tile);
    let threat = 0;
    if (isCut) {
      // 可达语义：能移动到该兵周围的敌兵中进攻力最大值（复用战场消耗 BFS）
      for (const nb of neighborsOf(tile, geo)) {
        threat = Math.max(threat, reach[nb]);
      }
    } else {
      // 贴脸语义：邻格敌兵进攻力最大值
      let hasAdjEnemy = false;
      for (const nb of neighborsOf(tile, geo)) {
        const o = b.owner[nb];
        if (o >= 1 && o !== seat) {
          hasAdjEnemy = true;
          threat = Math.max(threat, attackPowerOf(b.strength[nb], b.linked[nb] === 1));
        }
      }
      if (!hasAdjEnemy) continue; // 规则2 对象须邻格有敌兵
    }
    if (threat < strength) continue; // 无需防御
    const after = linkedSetAfterRemoval(b, seat, new Set([tile]));
    const deLinkScale = linkedBefore - after.size;
    out.push({ tile, isCut, deLinkScale, threat, need: threat + 1 - strength });
  }
  // 全局排序 =（是否割点、断电规模降序）；平局按 tile 升序（确定性）
  out.sort((x, y) => (x.isCut === y.isCut ? y.deLinkScale - x.deLinkScale || x.tile - y.tile : x.isCut ? -1 : 1));
  return out;
}

/** 规则3：逐连兵 +1 探测 E_te → top20% 无限池 → 哈希种子逐点抽签 */
function saturateAssign(
  state: GameState,
  turnStart: GameState,
  seat: number,
  weights: TeWeights,
  points: number,
  opts?: AddPointOptions,
): PlayerIntent[] {
  const b = extractBoard(state);
  const linkedTiles = [...linkedSet(b, seat)].filter((t) => opts?.eligible?.(t) ?? true);
  if (linkedTiles.length === 0) return []; // 无（可加点）连兵：交还点数（由调用方 SWITCH_PHASE）

  // 逐兵 +1 探测（ADD_POINT 只加兵力、无级联事件 → 直接构造模拟局面）
  const scored = linkedTiles.map((tile) => {
    const probe = probePlusOne(state, tile);
    return { tile, value: evalTe(probe, turnStart, seat, weights) };
  });
  scored.sort((x, y) => y.value - x.value || x.tile - y.tile);
  const poolSize = Math.ceil(linkedTiles.length * (opts?.poolRatio ?? 0.2));
  const pool = scored.slice(0, poolSize); // 按 E_te 值排序
  const poolRank = new Map(pool.map((p, i) => [p.tile, i]));
  const poolWeight = (rank: number): number => pool.length - rank; // 线性递增（越前越易抽中）

  // 局面哈希做种子的确定性 PRNG
  const rng = mulberry32(parseInt(hashGameState(state).slice(0, 8), 16) >>> 0);

  // 本地兵力跟踪（探测不改动 state；抽签在本地兵力上累加）
  const strength = new Map<number, number>();
  for (const tile of linkedTiles) strength.set(tile, b.strength[tile]);

  const intents: PlayerIntent[] = [];
  for (let p = 0; p < points; p++) {
    // 资格：池内兵恒可抽；非池兵仅兵力 < 2（升至 2 即出池），权重 1
    const entries: Array<{ tile: number; weight: number }> = [];
    for (const [i, ps] of pool.entries()) {
      entries.push({ tile: ps.tile, weight: poolWeight(i) });
    }
    for (const tile of linkedTiles) {
      if (poolRank.has(tile)) continue;
      const s = strength.get(tile)!;
      if (s < 2) entries.push({ tile, weight: 1 });
    }
    if (entries.length === 0) break;
    const total = entries.reduce((acc, e) => acc + e.weight, 0);
    let roll = rng() * total;
    let picked = entries[entries.length - 1].tile;
    for (const e of entries) {
      roll -= e.weight;
      if (roll < 0) {
        picked = e.tile;
        break;
      }
    }
    strength.set(picked, strength.get(picked)! + 1);
    intents.push({ intentType: 'ADD_POINT', coordinate: picked, amount: 1 });
  }
  return intents;
}

/** +1 探测：构造兵力 +1 的模拟局面（不改动原状态） */
function probePlusOne(state: GameState, tile: number): GameState {
  const tiles = state.tiles.slice();
  const t = tiles[tile];
  const s = t.soldier!;
  tiles[tile] = { ...t, soldier: { ...s, strength: s.strength + 1 } };
  return { ...state, tiles };
}

/** mulberry32：种子化 PRNG（加点抽签确定性随机源） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
