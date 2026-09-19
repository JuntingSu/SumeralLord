// battlefield.ts — 评估/加点共用的四个战场设施（设计方案 §3.1 / §3.2 / §10 阶段1）
// ①战场消耗 BFS ②割点判定（参数化威胁排除） ③断连模拟 ④0-1 防护 BFS
// 语义依据：战场 BFS 通用规则（连兵多步推进；有兵格消耗 = 防守方兵力+1，空格 = 1）；
// 默认项 3（野生 = 可通过消耗+1、阻挡 = 不可通过）；敌方断兵只能进攻一次（单步）。
import { TILE_OWNER, isStrongholdTerrain, neighborsOf } from '@dl/shared';
import type { Board } from './board.js';
import { attackPowerOf, isImpassableTerrain } from './board.js';

/**
 * ① 多源战场消耗 BFS：seat 方全部兵向外推进，返回每格"抵达后最大剩余进攻力"。
 * - 连兵源：多步推进（每步支付进格消耗）；断兵源：单步（只能进攻一次）；
 * - 进格消耗：空格（含空据点/海洋）= 1；野生兵格 = 1（可通过、消耗 +1 档）；
 *   敌方兵格 = 该兵兵力 + 1（反击照常结算的简化）；己方兵格 / 阻挡兵 / 全断地形 = 不可通过。
 * opts.linkedOnlySources：仅连兵作源（E_te 特征5：我方断兵不计入）。
 * 返回 Float64Array：-1 = 不可达，≥0 = 可达且剩余进攻力。
 */
export function battleReach(b: Board, seat: number, opts?: { linkedOnlySources?: boolean }): Float64Array {
  const best = new Float64Array(b.size).fill(-1);
  const heapRem: number[] = [];
  const heapTile: number[] = [];
  const push = (rem: number, tile: number): void => {
    heapRem.push(rem);
    heapTile.push(tile);
    let i = heapRem.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapRem[p] >= heapRem[i]) break;
      [heapRem[p], heapRem[i]] = [heapRem[i], heapRem[p]];
      [heapTile[p], heapTile[i]] = [heapTile[i], heapTile[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const rem = heapRem[0];
    const tile = heapTile[0];
    const lastR = heapRem.pop()!;
    const lastT = heapTile.pop()!;
    if (heapRem.length > 0) {
      heapRem[0] = lastR;
      heapTile[0] = lastT;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heapRem.length && heapRem[l] > heapRem[m]) m = l;
        if (r < heapRem.length && heapRem[r] > heapRem[m]) m = r;
        if (m === i) break;
        [heapRem[m], heapRem[i]] = [heapRem[i], heapRem[m]];
        [heapTile[m], heapTile[i]] = [heapTile[i], heapTile[m]];
        i = m;
      }
    }
    return [rem, tile];
  };

  /** 进入 tile 的消耗；不可进入返回 -1 */
  const enterCost = (tile: number): number => {
    if (isImpassableTerrain(b.terrain[tile])) return -1;
    const o = b.owner[tile];
    if (o === seat) return -1; // 己方兵格不可进入
    if (o === TILE_OWNER.BLOCKER) return -1; // 阻挡兵不可通过
    if (o === TILE_OWNER.WILD) return 1; // 野生：可通过、消耗 +1
    if (o >= 0) return b.strength[tile] + 1; // 敌方兵格（反击照常结算的简化）
    return 1; // 空格
  };

  const expand = (from: number, rem: number): void => {
    for (const nb of neighborsOf(from, b.geo)) {
      const cost = enterCost(nb);
      if (cost < 0) continue;
      const next = rem - cost;
      if (next >= 0 && next > best[nb]) {
        best[nb] = next;
        push(next, nb);
      }
    }
  };

  const linkedOnly = opts?.linkedOnlySources ?? false;
  for (let tile = 0; tile < b.size; tile++) {
    if (b.owner[tile] !== seat) continue;
    const power = attackPowerOf(b.strength[tile], b.linked[tile] === 1);
    if (b.linked[tile] === 1) {
      // 连兵源：多步推进
      if (power > best[tile]) {
        best[tile] = power;
        push(power, tile);
      }
    } else if (!linkedOnly) {
      // 断兵源：单步（只能进攻一次）；一步到位，不入堆（不得继续推进）
      if (power > best[tile]) best[tile] = power;
      for (const nb of neighborsOf(tile, b.geo)) {
        const cost = enterCost(nb);
        if (cost < 0) continue;
        const next = power - cost;
        if (next >= 0 && next > best[nb]) best[nb] = next;
      }
    }
  }

  while (heapRem.length > 0) {
    const [rem, tile] = pop();
    if (rem < best[tile]) continue; // 过期堆项
    expand(tile, rem);
  }
  return best;
}

/**
 * ③ 断连模拟：移除 removed 格上的兵后，seat 方仍为连兵的格集合。
 * 连兵性 = 位于全接地形（锚点，恒为连兵），或经同势力连兵链连通到锚点（断连判定 BFS 语义）。
 */
export function linkedSetAfterRemoval(b: Board, seat: number, removed: Set<number>): Set<number> {
  const result = new Set<number>();
  const queue: number[] = [];
  for (let i = 0; i < b.size; i++) {
    if (b.owner[i] === seat && !removed.has(i) && b.linked[i] === 1 && isStrongholdTerrain(b.terrain[i])) {
      result.add(i);
      queue.push(i);
    }
  }
  while (queue.length) {
    const cur = queue.pop()!;
    for (const nb of neighborsOf(cur, b.geo)) {
      if (removed.has(nb)) continue;
      if (b.owner[nb] === seat && b.linked[nb] === 1 && !result.has(nb)) {
        result.add(nb);
        queue.push(nb);
      }
    }
  }
  return result;
}

/** 当前（不移除）seat 方连兵格集合 */
export function linkedSet(b: Board, seat: number): Set<number> {
  return linkedSetAfterRemoval(b, seat, new Set());
}

/**
 * ② 割点型连兵：去除该兵即导致部分区域断电（脱离据点变断兵）的 seat 方连兵。
 * opts.excludeThreatened：跳过"周围有 ≥2 个威胁性敌兵"者（E_ape 坏型排除；加点规则1 不排除）。
 * 威胁性敌兵 = 兵力 ≥ 2 的敌方连兵 ∪ 任意敌方断兵（中立兵不计）。
 */
export function cutVertices(b: Board, seat: number, opts?: { excludeThreatened?: boolean }): number[] {
  const before = linkedSet(b, seat);
  const out: number[] = [];
  for (const tile of before) {
    if (opts?.excludeThreatened && threatenedNeighborCount(b, seat, tile) >= 2) continue;
    const after = linkedSetAfterRemoval(b, seat, new Set([tile]));
    // 去除自身外，仍有其他连兵脱离网络 → 割点
    if (after.size < before.size - 1) out.push(tile);
  }
  return out;
}

/** tile 周围的威胁性敌兵数量（E_ape 特征2/3 威胁排除） */
export function threatenedNeighborCount(b: Board, seat: number, tile: number): number {
  let n = 0;
  for (const nb of neighborsOf(tile, b.geo)) {
    const o = b.owner[nb];
    if (o < 0 || o === seat) continue;
    if (o === TILE_OWNER.WILD || o === TILE_OWNER.BLOCKER) continue; // 中立兵不算威胁性敌兵
    if (b.linked[nb] === 1 ? b.strength[nb] >= 2 : true) n++;
  }
  return n;
}

/** 敌方（非 seat 方势力）驻兵据点格 */
function isEnemyStrongholdTile(b: Board, tile: number, seat: number): boolean {
  return isStrongholdTerrain(b.terrain[tile]) && b.owner[tile] >= 1 && b.owner[tile] !== seat;
}

/**
 * ④ 0-1 防护 BFS（E_ape 特征3 的衰减 x）：从坏型所在格出发到任一"敌方驻兵据点格"的最小总代价。
 * - 不可通过：我方连兵、阻挡兵、山地/虚空；
 * - 代价 +1：我方断兵、野生兵；
 * - 代价 0：空格、海洋、敌方兵（无视敌方所有兵；敌方驻兵据点格即目标）。
 * 返回 Infinity = 不可达（factor = max(0, 1−0.2x) → 0）。
 */
export function protectionCost(b: Board, seat: number, fromTile: number): number {
  const dist = new Float64Array(b.size).fill(Infinity);
  dist[fromTile] = 0;
  // 小根堆 Dijkstra（代价 0/1；棋盘小，实现简单可靠优先）
  const heapD: number[] = [];
  const heapT: number[] = [];
  const push = (d: number, tile: number): void => {
    heapD.push(d);
    heapT.push(tile);
    let i = heapD.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapD[p] <= heapD[i]) break;
      [heapD[p], heapD[i]] = [heapD[i], heapD[p]];
      [heapT[p], heapT[i]] = [heapT[i], heapT[p]];
      i = p;
    }
  };
  const pop = (): [number, number] => {
    const d = heapD[0];
    const tile = heapT[0];
    const lastD = heapD.pop()!;
    const lastT = heapT.pop()!;
    if (heapD.length > 0) {
      heapD[0] = lastD;
      heapT[0] = lastT;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heapD.length && heapD[l] < heapD[m]) m = l;
        if (r < heapD.length && heapD[r] < heapD[m]) m = r;
        if (m === i) break;
        [heapD[m], heapD[i]] = [heapD[i], heapD[m]];
        [heapT[m], heapT[i]] = [heapT[i], heapT[m]];
        i = m;
      }
    }
    return [d, tile];
  };
  push(0, fromTile);
  let best = Infinity;
  while (heapD.length > 0) {
    const [d, cur] = pop();
    if (d > dist[cur]) continue; // 过期堆项
    if (cur !== fromTile && isEnemyStrongholdTile(b, cur, seat)) {
      if (d < best) best = d;
      continue; // 目标即终点
    }
    for (const nb of neighborsOf(cur, b.geo)) {
      if (isImpassableTerrain(b.terrain[nb])) continue;
      const o = b.owner[nb];
      if (o === seat && b.linked[nb] === 1) continue; // 我方连兵不可通过
      if (o === TILE_OWNER.BLOCKER) continue;
      const cost = o === seat || o === TILE_OWNER.WILD ? 1 : 0; // 我方断兵/野生 +1；空格/海洋/敌方兵 0
      const nd = d + cost;
      if (nd < dist[nb]) {
        dist[nb] = nd;
        push(nd, nb);
      }
    }
  }
  return best;
}
