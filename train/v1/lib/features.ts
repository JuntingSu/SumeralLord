// features.ts — E_te 6 特征与 E_ape 4 特征（设计方案 §3.1 / §3.2，逐条对应文档）
// 全部为纯函数：输入 GameState 双快照 + 视角 seat，输出特征向量；不改状态。
import { TILE_OWNER, neighborsOf } from '@dl/shared';
import type { GameState } from '@dl/shared';
import type { Board } from './board.js';
import { extractBoard, hexDistanceTo, isImpassableTerrain, otherSeat, soldiersOf, strongholdTilesOf } from './board.js';
import {
  battleReach,
  cutVertices,
  linkedSet,
  linkedSetAfterRemoval,
  protectionCost,
  threatenedNeighborCount,
} from './battlefield.js';

/** 边界兵组合上限（特征3：组合上限 4） */
const COMBO_MAX_SIZE = 4;
/** 边界兵数量保护上限（超出按兵力升序截断——敌方偏好便宜目标；文档未规定，防组合爆炸） */
const BOUNDARY_MAX = 20;
/** 组合总数保护上限（按组合规模升序枚举，超出截断） */
const COMBO_MAX_TOTAL = 4096;
/** 特征4：敌方最近连兵数 N=4（不含断兵） */
const RELIABILITY_N = 4;

/**
 * E_te 特征（回合结束评价）。双快照：(回合结束局面 end, 该回合开始局面 start)。
 * 返回 [f1 子力差值, f2 连兵差值, f3 网络脆弱性, f4 网络可靠性, f5 我方威胁性, f6 叫杀得分]。
 */
export function teFeatures(end: GameState, start: GameState, seat: number): number[] {
  const bEnd = extractBoard(end);
  const bStart = extractBoard(start);
  const enemy = otherSeat(end, seat);

  // f1 子力差值（单快照可算）：我总兵力 − sqrt(敌总兵力 × (敌总兵力 + 敌连兵数))
  const myTotal = totalStrength(bEnd, seat);
  const enTotal = totalStrength(bEnd, enemy);
  const enLinked = linkedCount(bEnd, enemy);
  const f1 = myTotal - Math.sqrt(enTotal * (enTotal + enLinked));

  // f2 连兵差值（双快照）：(回合末我连兵 − 敌连兵) − (回合初我连兵 − 敌连兵)
  const f2 =
    linkedCount(bEnd, seat) - enLinked - (linkedCount(bStart, seat) - linkedCount(bStart, enemy));

  // f3 网络脆弱性：敌方可达网络内我方边界兵，组合（≤4）模拟被吃，取连兵减少量最大值
  const f3 = fragilityValue(bEnd, seat, enemy);

  // f4 网络可靠性：敌方最近 N=4 连兵（不含断兵），强化后单兵连续进攻链，max(连兵减少²/总兵力损失)
  const f4 = reliabilityValue(bEnd, seat, enemy);

  // f5 我方威胁性：我方连兵可达区域 Σ max(0, 1 − d/B)，d = 该格到最近敌方据点距离
  const f5 = threatValue(bEnd, seat, enemy);

  // f6 叫杀得分：我方兵距敌据点 1 且敌方下回合可加点总数（= 敌连兵数）< 该兵兵力
  const f6 = killShot(bEnd, seat, enemy) ? 1 : 0;

  return [f1, f2, f3, f4, f5, f6];
}

function totalStrength(b: Board, seat: number): number {
  let sum = 0;
  for (let i = 0; i < b.size; i++) if (b.owner[i] === seat) sum += b.strength[i];
  return sum;
}

function linkedCount(b: Board, seat: number): number {
  let n = 0;
  for (let i = 0; i < b.size; i++) if (b.owner[i] === seat && b.linked[i] === 1) n++;
  return n;
}

/** 特征 3：网络脆弱性 */
function fragilityValue(b: Board, seat: number, enemy: number): number {
  const reach = battleReach(b, enemy);
  // 网络内我方兵 → 剪枝到边界兵（周围有不在该网络内的友兵者）
  const boundary: number[] = [];
  for (let t = 0; t < b.size; t++) {
    if (b.owner[t] !== seat || reach[t] < 0) continue;
    let isBoundary = false;
    for (const nb of neighborsOf(t, b.geo)) {
      if (b.owner[nb] === seat && reach[nb] < 0) {
        isBoundary = true;
        break;
      }
    }
    if (isBoundary) boundary.push(t);
  }
  if (boundary.length === 0) return 0;
  if (boundary.length > BOUNDARY_MAX) {
    boundary.sort((a, c) => b.strength[a] - b.strength[c] || a - c);
    boundary.length = BOUNDARY_MAX;
  }
  const linkedBefore = linkedCount(b, seat);
  let maxLoss = 0;
  let combos = 0;
  // 按组合规模升序枚举（1..4），超出总数上限截断
  for (let size = 1; size <= COMBO_MAX_SIZE && combos < COMBO_MAX_TOTAL; size++) {
    for (const combo of combinations(boundary.length, size)) {
      if (combos >= COMBO_MAX_TOTAL) break;
      combos++;
      const removed = new Set(combo.map((i) => boundary[i]));
      const after = linkedSetAfterRemoval(b, seat, removed);
      const loss = linkedBefore - after.size;
      if (loss > maxLoss) maxLoss = loss;
    }
  }
  return maxLoss;
}

/** 特征 4：网络可靠性。敌方强化连兵的单兵连续进攻链：贪心吃最弱可吃目标（确定性）。 */
function reliabilityValue(b: Board, seat: number, enemy: number): number {
  const myTiles = soldiersOf(b, seat);
  if (myTiles.length === 0) return 0;
  // 敌方连兵（不含断兵），按距我方兵最近排序取前 N
  const candidates: Array<{ tile: number; dist: number }> = [];
  for (let t = 0; t < b.size; t++) {
    if (b.owner[t] !== enemy || b.linked[t] !== 1) continue;
    let minD = Infinity;
    for (const m of myTiles) minD = Math.min(minD, hexDistanceTo(b, t, m));
    candidates.push({ tile: t, dist: minD });
  }
  candidates.sort((a, c) => a.dist - c.dist || a.tile - c.tile);
  const picked = candidates.slice(0, RELIABILITY_N);
  if (picked.length === 0) return 0;

  const enLinked = linkedCount(b, enemy);
  const linkedBefore = linkedCount(b, seat);
  let maxValue = 0;
  for (const { tile } of picked) {
    // 子局面：该敌兵增加"敌方当前连兵数"兵力（模拟敌方下回合集中加点）
    const S = b.strength[tile] + enLinked;
    const owner = Int16Array.from(b.owner);
    const strength = Int16Array.from(b.strength);
    const removed = new Set<number>();
    let cur = tile;
    let s = S;
    let totalCost = 0;
    for (;;) {
      const power = s - 1; // 连兵进攻力
      let bestX = Infinity;
      let bestTile = -1;
      for (const nb of neighborsOf(cur, b.geo)) {
        if (owner[nb] !== seat) continue;
        const x = strength[nb];
        if (x <= power && x < bestX) {
          bestX = x;
          bestTile = nb;
        }
      }
      if (bestTile < 0) break; // 无可吃目标
      totalCost += bestX + 1; // 消耗 = 目标兵力 + 1（反击照常结算的简化）
      s = s - bestX - 1;
      owner[bestTile] = -1;
      removed.add(bestTile);
      cur = bestTile;
    }
    if (totalCost === 0) continue;
    const after = linkedSetAfterRemoval(b, seat, removed);
    const loss = linkedBefore - after.size;
    const value = (loss * loss) / totalCost;
    if (value > maxValue) maxValue = value;
  }
  return maxValue;
}

/** 特征 5：我方威胁性（2026-09-20 重定义）
 * d = 该兵"兵力 1000、不考虑敌方任何兵"走到最近敌方据点周围时的兵力下降值
 *  （统一消耗 = 每步 1；敌方兵无视（按空格消耗）；阻挡兵/山地/虚空不可通过；敌方兵格不阻碍）。
 * 特征值 = Σ (4·(地图长+地图宽) − d) × 该兵兵力；不可达按 d = 4(L+W)（贡献 0）。
 */
function threatValue(b: Board, seat: number, enemy: number): number {
  const strongholds = strongholdTilesOf(b, enemy);
  if (strongholds.length === 0) return 0;
  // 目标种子：敌方据点周围（距离 1）的全部格；多源 BFS 求每格到最近目标的步数
  const size = b.size;
  const dist = new Int32Array(size).fill(-1);
  const queue: number[] = [];
  for (const sp of strongholds) {
    for (const nb of neighborsOf(sp, b.geo)) {
      if (dist[nb] < 0) {
        dist[nb] = 0;
        queue.push(nb);
      }
    }
  }
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    for (const nb of neighborsOf(cur, b.geo)) {
      if (dist[nb] >= 0) continue;
      if (isImpassableTerrain(b.terrain[nb])) continue; // 山地/虚空
      if (b.owner[nb] === TILE_OWNER.BLOCKER) continue; // 阻挡兵不可通过
      dist[nb] = dist[cur] + 1;
      queue.push(nb);
    }
  }
  const cap = 4 * (b.geo.rows + b.geo.columns);
  let sum = 0;
  for (let t = 0; t < size; t++) {
    if (b.owner[t] !== seat) continue;
    const d = dist[t] < 0 ? cap : dist[t];
    sum += (cap - Math.min(d, cap)) /cap * b.strength[t];
  }
  return sum;
}

/** 特征 6：叫杀得分 */
function killShot(b: Board, seat: number, enemy: number): boolean {
  const enLinked = linkedCount(b, enemy);
  for (const sp of strongholdTilesOf(b, enemy)) {
    for (const nb of neighborsOf(sp, b.geo)) {
      if (b.owner[nb] === seat && enLinked < b.strength[nb]) return true;
    }
  }
  return false;
}

function combinations(n: number, k: number): Iterable<number[]> {
  return {
    *[Symbol.iterator]() {
      if (k > n) return;
      const idx = Array.from({ length: k }, (_, i) => i);
      for (;;) {
        yield [...idx];
        let i = k - 1;
        while (i >= 0 && idx[i] === n - k + i) i--;
        if (i < 0) return;
        idx[i]++;
        for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
      }
    },
  };
}

/**
 * E_ape 特征（行动阶段排序工具，权重固定）。双快照：(行动后/链终止局面 post, 行动阶段开始局面 start)。
 * 返回 [f1 兵力差净变化, f2 可靠连兵差净变化, f3 我方坏型数, f4 我方威胁程度]。
 */
export function apeFeatures(post: GameState, start: GameState, seat: number): number[] {
  const bPost = extractBoard(post);
  const bStart = extractBoard(start);
  const enemy = otherSeat(post, seat);

  // f1 兵力差净变化：(行动后我 − 敌总兵力) − (回合初我 − 敌总兵力)
  const f1 =
    totalStrength(bPost, seat) -
    totalStrength(bPost, enemy) -
    (totalStrength(bStart, seat) - totalStrength(bStart, enemy));

  // f2 可靠连兵差净变化：排除仅在行动后快照执行（回合初用原始连兵数）；敌方连兵数不排除
  const myEffective = effectiveLinkedCount(bPost, seat);
  const f2 =
    myEffective -
    linkedCount(bPost, enemy) -
    (linkedCount(bStart, seat) - linkedCount(bStart, enemy));

  // f3 我方坏型数：Σ 割点型连兵 × max(0, 1 − 0.2x)，x = 防护 BFS 最小总代价（带威胁排除）
  let f3 = 0;
  for (const cut of cutVertices(bPost, seat, { excludeThreatened: true })) {
    const x = protectionCost(bPost, seat, cut);
    const factor = x === Infinity ? 0 : Math.max(0, 1 - 0.2 * x);
    f3 += factor;
  }

  // f4 我方威胁程度：2 − d/B，d = min(我方兵 × 敌方据点的 hexDistance)
  const strongholds = strongholdTilesOf(bPost, enemy);
  let f4 = 0;
  if (strongholds.length > 0) {
    const bigB = Math.max(bPost.geo.rows, bPost.geo.columns);
    let d = bigB;
    for (let t = 0; t < bPost.size; t++) {
      if (bPost.owner[t] !== seat) continue;
      for (const sp of strongholds) d = Math.min(d, hexDistanceTo(bPost, t, sp));
    }
    f4 = 2 - d / bigB;
  }

  return [f1, f2, f3, f4];
}

/** 有效连兵数：排除"周围有 ≥2 个威胁性敌兵"的我方连兵（仅行动后快照调用） */
function effectiveLinkedCount(b: Board, seat: number): number {
  let n = 0;
  for (const t of linkedSet(b, seat)) {
    if (threatenedNeighborCount(b, seat, t) < 2) n++;
  }
  return n;
}
