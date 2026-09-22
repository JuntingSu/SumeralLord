// addpoint.ts — 加点阶段算法（设计方案 §2.2，M=1 唯一方案；2026-09-20 修订）
// 规则1（防断电，割点型连兵）→ 规则2（防击杀，其余连兵）→ 规则3（E_te 引导饱和分配）。
// 规则1/2 威胁值统一为可达语义：能到达该兵周围（距离 1）的敌兵中，到达时进攻力最大值（2026-09-21 规则2 同规则1）。
// 规则1/2 全有或全无；规则3 逐点抽签（局面哈希做种子，同局面同分配）。
// 修订1（前中期限制）：非残局（回合数 < T 且无双方接触）时，只允许在"周围有空据点/空平原"的连兵上加点。
// 修订2（规则3，2026-09-20）：模拟打分改为"加当前全部剩余点数"；无限池 = 打分前三；
//   池外兵合计最多获得总加点的 15%（向下取整）；残局（回合数 ≥ T 或双方接触）无法直接到达敌方的兵不能进池。
import { TERRAIN, neighborsOf } from '@dl/shared';
import type { GameState, PlayerIntent } from '@dl/shared';
import { hashGameState } from '@dl/shared';
import { TILE_OWNER } from '@dl/shared';
import type { Board } from './board.js';
import { extractBoard, isImpassableTerrain } from './board.js';
import { battleReach, cutVertices, linkedSet, linkedSetAfterRemoval } from './battlefield.js';
import { evalTe, isLatePhase, type TeWeights } from './eval.js';
import { mulberry32 } from './rng.js';

export interface AddPointOptions {
  /** 无限池规模（默认 3：打分前三） */
  poolSize?: number;
  /** 池外兵合计上限比例（默认 0.15，向下取整） */
  nonPoolRatio?: number;
  /** 规则3 候选资格过滤（内部使用：前中期资格 / 后期直接可达） */
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

  // 前中期限制（修订1）：非残局（回合数 < T 且无双方接触）时，只允许在"周围有空据点/空平原"的连兵上加点；
  // 残局（修订2）：无法直接到达敌方的兵在规则3 下不能进入加点池
  const restrict = !isLatePhase(state);
  const rule3Eligible = (tile: number): boolean =>
    restrict ? hasEmptyLandNeighbor(b, tile) : canDirectlyReachEnemy(b, seat, enemy, tile);

  // ---- 规则1 + 规则2：统一候选集，排序 =（是否割点、断电规模降序）----
  const candidates = collectDefenseCandidates(b, seat, enemy).filter((c) =>
    restrict ? hasEmptyLandNeighbor(b, c.tile) : true,
  );
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
    intents.push(...saturateAssign(post12, turnStart, seat, weights, remaining, { ...opts, eligible: rule3Eligible }));
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

/**
 * 后期规则3 池资格（2026-09-20）：能否"直接到达敌方"——
 * 存在一条路径到达敌方兵（途中可经过空/野生/中立格），沿途遇到的友兵 ≤ 1 次
 * （遇到 1 次友兵仍算可到达；任何路径都先遇到 ≥2 次友兵 → 不可到达）。
 * 起点自身不计入友兵；山地/虚空/阻挡兵不可通过。
 */
export function canDirectlyReachEnemy(b: Board, seat: number, enemy: number, fromTile: number): boolean {
  if (enemy < 0) return false;
  const queue: Array<[number, number]> = [[fromTile, 0]]; // [tile, 已遇友兵次数]
  const visited = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    const [cur, cnt] = queue[head++];
    const key = `${cur}:${Math.min(cnt, 2)}`;
    if (visited.has(key)) continue;
    visited.add(key);
    for (const nb of neighborsOf(cur, b.geo)) {
      if (isImpassableTerrain(b.terrain[nb])) continue;
      const o = b.owner[nb];
      if (o === TILE_OWNER.BLOCKER) continue;
      if (o === enemy) return true; // 到达敌方兵
      if (o === seat) {
        if (cnt + 1 >= 2) continue; // 第 2 次友兵：该路径不可行
        queue.push([nb, cnt + 1]);
      } else {
        queue.push([nb, cnt]); // 空/野生/中立
      }
    }
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

/** 规则1（割点型连兵）∪ 规则2（其余连兵）：威胁值统一为可达语义——能到达该兵周围（距离 1）的敌兵中，
 * 到达时进攻力最大值（2026-09-21：规则2 由"贴脸威胁"改为与规则1 一致的可达威胁，去掉"须邻格有敌兵"对象门控） */
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
    for (const nb of neighborsOf(tile, geo)) {
      threat = Math.max(threat, reach[nb]);
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

/** 规则3（2026-09-20 修订）：模拟加当前全部剩余点数打分 → 打分前三为无限池 → 哈希种子逐点抽签
 * 池内兵按排名线性权重（越前越易抽中）；池外兵权重 1，合计最多获得总加点的 15%（向下取整）。
 */
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

  // 模拟打分：把当前全部剩余点数加给该兵后评估 E_te（ADD_POINT 只加兵力、无级联事件 → 直接构造模拟局面）
  const scored = linkedTiles.map((tile) => {
    const probe = probeAdd(state, tile, points);
    return { tile, value: evalTe(probe, turnStart, seat, weights) };
  });
  scored.sort((x, y) => y.value - x.value || x.tile - y.tile);
  const poolSize = Math.max(1, Math.min(opts?.poolSize ?? 3, linkedTiles.length));
  const pool = scored.slice(0, poolSize); // 打分前三为无限池
  const poolRank = new Map(pool.map((p, i) => [p.tile, i]));
  const poolWeight = (rank: number): number => pool.length - rank; // 线性递增（越前越易抽中）
  const nonPoolBudget = Math.floor(points * (opts?.nonPoolRatio ?? 0.15)); // 池外合计上限（向下取整）
  let nonPoolUsed = 0;

  // 局面哈希做种子的确定性 PRNG
  const rng = mulberry32(parseInt(hashGameState(state).slice(0, 8), 16) >>> 0);

  // 本地兵力跟踪（探测不改动 state；抽签在本地兵力上累加）
  const strength = new Map<number, number>();
  for (const tile of linkedTiles) strength.set(tile, b.strength[tile]);

  const intents: PlayerIntent[] = [];
  for (let p = 0; p < points; p++) {
    // 资格：池内兵恒可抽；池外兵权重 1（合计 ≤ 15%）
    const entries: Array<{ tile: number; weight: number }> = [];
    for (const [i, ps] of pool.entries()) {
      entries.push({ tile: ps.tile, weight: poolWeight(i) });
    }
    for (const tile of linkedTiles) {
      if (poolRank.has(tile)) continue;
      if (nonPoolUsed >= nonPoolBudget) continue;
      entries.push({ tile, weight: 1 });
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
    if (!poolRank.has(picked)) nonPoolUsed++;
    intents.push({ intentType: 'ADD_POINT', coordinate: picked, amount: 1 });
  }
  return intents;
}

/** 模拟加点：构造该兵兵力 +amount 的模拟局面（不改动原状态） */
function probeAdd(state: GameState, tile: number, amount: number): GameState {
  const tiles = state.tiles.slice();
  const t = tiles[tile];
  const s = t.soldier!;
  tiles[tile] = { ...t, soldier: { ...s, strength: s.strength + amount } };
  return { ...state, tiles };
}
