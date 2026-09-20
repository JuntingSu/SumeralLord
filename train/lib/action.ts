// action.ts — 行动阶段三段式算法（行动文档 v1.5 原样实现；候选 top-4 按训练设计方案 §2.1）
// 结构：①前置行为段（进攻据点，判定一次）→ ②基础行为段（5 种行为 DFS + 规则1/2 链推进 + 原点剪枝 + top-2）
// → ③防守行为段（每条候选路径独立下海批准）。所有结算走真实 reducer（applyIntent），与正式规则一致。
//
// 工程保险（文档"终止性"只保证有限，不保证低开销；组合爆炸时优雅降级）：
// - maxChainsPerOrigin：单原点链枚举上限（锁兵分叉/消耗战选 B 的分支展开上限）
// - maxLeaves：单次行动搜索叶子（完整方案）上限，超出后前沿原点直接按当前路径记为方案
// - maxApplies：单次行动搜索 reducer 应用总预算
import {
  TERRAIN,
  TILE_OWNER,
  applyIntent,
  hexDistance,
  isFullBreak,
  isStrongholdTerrain,
  neighborsOf,
} from '@dl/shared';
import type { GameState, PlayerIntent } from '@dl/shared';
import { evalApe } from './eval.js';
import { attackPowerOf } from './board.js';

export interface ActionPlan {
  /** 完整意图序列：前置链（若成立）+ 基础行为意图 + 防守意图 */
  intents: PlayerIntent[];
  /** 方案 E_ape（基础行为段叶子得分；防守段不改变得分语义） */
  score: number;
  /** 方案叶子局面（行动意图应用完毕的状态；供加点组装与 MCTS 复用） */
  leaf: GameState;
}

export interface PlanActionOptions {
  /** 候选方案数（训练环境 top-4） */
  candidates?: number;
  /** 单行为链枚举上限（锁兵分叉/消耗战选 B 的分支展开上限） */
  maxChainsPerOrigin?: number;
  maxLeaves?: number;
  maxApplies?: number;
}

interface Ctx {
  seat: number;
  turnStart: GameState;
  applies: number;
  maxApplies: number;
  leaves: number;
  maxLeaves: number;
  maxChainsPerBehavior: number;
}

type BehaviorKind = 'spread' | 'adjacent' | 'ocean' | 'suicide' | 'exchange';

interface Behavior {
  kind: BehaviorKind;
  fromTile: number;
  intents: PlayerIntent[];
  /** 自杀/兑换的目标敌兵格 */
  targetTile?: number;
}

interface Chain {
  state: GameState;
  intents: PlayerIntent[];
}

const isLand = (t: number): boolean => t === TERRAIN.PLAIN || t === TERRAIN.CITY;

function sameTeamOf(state: GameState, a: number, b: number): boolean {
  if (a < 1 || a > 127 || b < 1 || b > 127) return false;
  const fa = state.forces.find((f) => f.seat === a);
  const fb = state.forces.find((f) => f.seat === b);
  return !!fa && !!fb && fa.team === fb.team;
}

/** 是否可合法进攻的目标（非同队：敌方势力兵或中立兵） */
function isAttackableTarget(state: GameState, seat: number, targetOwner: number): boolean {
  return !sameTeamOf(state, seat, targetOwner);
}

// ---------- reducer 应用 ----------

function applyOne(ctx: Ctx, state: GameState, intent: PlayerIntent): GameState | null {
  ctx.applies++;
  const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: ctx.seat }, intent });
  return r.ok ? r.state : null;
}

/** 顺序应用意图序列；被拒绝的意图跳过（与对局流语义一致：无效意图自然失效） */
function applyAll(ctx: Ctx, state: GameState, intents: PlayerIntent[]): GameState {
  let cur = state;
  for (const intent of intents) {
    const next = applyOne(ctx, cur, intent);
    if (next) cur = next;
  }
  return cur;
}

// ---------- 行为枚举 ----------

interface OceanRouteNode {
  tile: number;
  /** 抵达该格后的兵力（断兵） */
  strength: number;
  /** 移动力：兵力 1 断兵移动后失去移动力；失去移动力后不能再走/攻 */
  hasMovement: boolean;
  path: PlayerIntent[];
}

/**
 * 水路 BFS（远海进攻/兑换/自杀-远海共用）：分层精确步数，支持"绕路烧兵"的等兵力到达。
 * 起点：陆地兵 → 相邻空海洋（下海：连兵 S−2 / 断兵 S−1）；海洋兵 → 自身格（0 步）。
 * 扩展：空海洋 → 相邻空海洋（搬迁 −1/步）。每层记录 (tile, strength, path)。
 */
function oceanRoutes(ctx: Ctx, state: GameState, fromTile: number): OceanRouteNode[] {
  const soldier = state.tiles[fromTile].soldier!;
  const geo = { rows: state.rows, columns: state.columns, cylindrical: state.cylindrical };
  const maxLayers = Math.min(soldier.strength + 1, 48);
  const nodes: OceanRouteNode[] = [];
  const seen = new Set<string>(); // tile:strength 去重（入队前去重 → 每层 ≤ 海洋格×兵力值，多项式规模）
  let frontier: OceanRouteNode[] = [];
  const addNode = (node: OceanRouteNode, bucket: OceanRouteNode[]): void => {
    const key = `${node.tile}:${node.strength}`;
    if (seen.has(key)) return;
    seen.add(key);
    nodes.push(node);
    bucket.push(node);
  };

  if (state.tiles[fromTile].terrain === TERRAIN.OCEAN) {
    addNode({ tile: fromTile, strength: soldier.strength, hasMovement: soldier.hasMovement, path: [] }, frontier);
  } else {
    for (const nb of neighborsOf(fromTile, geo)) {
      if (state.tiles[nb].terrain !== TERRAIN.OCEAN) continue;
      if (state.tiles[nb].soldier) continue; // 下海目标必须为空海洋
      // 连兵下海：复制 −1、原格留 1（地形半断直接生成断兵，不走连→断 −1——以 reducer 实测为准）
      // 断兵下海：整体搬迁 −1；兵力 1 断兵下海后失去移动力
      const s0 = soldier.isLinked ? soldier.strength - 1 : soldier.strength === 1 ? 1 : soldier.strength - 1;
      if (s0 < 1) continue;
      addNode(
        {
          tile: nb,
          strength: s0,
          hasMovement: s0 >= 2, // 兵力 1 断兵下海后失去移动力
          path: [{ intentType: 'MOVE', from: fromTile, to: nb }],
        },
        frontier,
      );
    }
  }
  let layer = frontier.length > 0 && frontier[0].path.length === 0 ? 0 : 1;
  // layer 语义：已消耗的海洋步数（0 = 兵力已在海洋；1 = 第一步下海完成）
  while (frontier.length > 0 && layer <= maxLayers) {
    const next: OceanRouteNode[] = [];
    for (const node of frontier) {
      if (!node.hasMovement) continue;
      for (const nb of neighborsOf(node.tile, geo)) {
        if (state.tiles[nb].terrain !== TERRAIN.OCEAN) continue;
        if (state.tiles[nb].soldier) continue; // 路途只经空海洋
        const s1 = node.strength - 1;
        if (s1 < 1) continue;
        addNode(
          {
            tile: nb,
            strength: s1,
            hasMovement: s1 >= 2,
            path: [...node.path, { intentType: 'MOVE', from: node.tile, to: nb }],
          },
          next,
        );
      }
    }
    frontier = next;
    layer++;
  }
  return nodes;
}

/** 海洋路径枚举结果：按目标聚合的最短路由（远海/自杀用）与等兵力路由（兑换用） */
interface OceanTarget {
  targetTile: number;
  /** 最短路径（最大到达兵力） */
  best: OceanRouteNode;
  /** 等兵力路径（兑换：到达兵力恰等于 X 兵力） */
  exact?: OceanRouteNode;
}

function oceanTargets(ctx: Ctx, state: GameState, fromTile: number, routes: OceanRouteNode[]): OceanTarget[] {
  const geo = { rows: state.rows, columns: state.columns, cylindrical: state.cylindrical };
  const byTarget = new Map<number, OceanTarget>();
  for (const node of routes) {
    for (const nb of neighborsOf(node.tile, geo)) {
      const t = state.tiles[nb];
      if (!t.soldier) continue;
      if (!isAttackableTarget(state, ctx.seat, t.soldier.owner)) continue;
      if (t.terrain !== TERRAIN.OCEAN && t.terrain !== TERRAIN.PLAIN) continue; // 目标：海洋敌兵 / 沿海平原敌兵
      let entry = byTarget.get(nb);
      if (!entry) {
        entry = { targetTile: nb, best: node };
        byTarget.set(nb, entry);
      } else if (node.strength > entry.best.strength) {
        entry.best = node; // 更强到达 → 更短路径
      }
    }
  }
  return [...byTarget.values()];
}

/** 枚举某局面下（可选锁兵）的全部合法基础行为 */
function enumerateBehaviors(ctx: Ctx, state: GameState, lockedTile: number | null): Behavior[] {
  const geo = { rows: state.rows, columns: state.columns, cylindrical: state.cylindrical };
  const behaviors: Behavior[] = [];
  const phaseOk = state.phase === 'ACTION';
  if (!phaseOk) return behaviors;
  // 水路 BFS 缓存（同一枚举内每兵至多算一次；自杀条件②复用）
  const routeCache = new Map<number, OceanRouteNode[]>();
  const routesOf = (tile: number): OceanRouteNode[] => {
    let r = routeCache.get(tile);
    if (!r) {
      r = oceanRoutes(ctx, state, tile);
      routeCache.set(tile, r);
    }
    return r;
  };

  for (let tile = 0; tile < state.tiles.length; tile++) {
    if (lockedTile !== null && tile !== lockedTile) continue;
    const s = state.tiles[tile].soldier;
    if (!s || s.owner !== ctx.seat || !s.hasMovement) continue;
    if (s.isLinked && s.strength === 1) continue;

    // --- 铺场：连兵 或 兵力1断兵 → 相邻空平原/空据点 ---
    if (s.isLinked || s.strength === 1) {
      for (const nb of neighborsOf(tile, geo)) {
        const t = state.tiles[nb];
        if (t.soldier) continue;
        if (t.terrain !== TERRAIN.PLAIN && t.terrain !== TERRAIN.CITY) continue;
        behaviors.push({ kind: 'spread', fromTile: tile, intents: [{ intentType: 'MOVE', from: tile, to: nb }] });
      }
    }

    // --- 就近进攻：连兵 → 相邻陆地敌兵，进攻成功（进攻力 ≥ 兵力）---
    if (s.isLinked) {
      for (const nb of neighborsOf(tile, geo)) {
        const t = state.tiles[nb];
        if (!t.soldier) continue;
        if (!isAttackableTarget(state, ctx.seat, t.soldier.owner)) continue;
        if (t.terrain !== TERRAIN.PLAIN && t.terrain !== TERRAIN.CITY) continue;
        if (attackPowerOf(s.strength, true) >= t.soldier.strength) {
          behaviors.push({ kind: 'adjacent', fromTile: tile, intents: [{ intentType: 'ATTACK', from: tile, to: nb }], targetTile: nb });
        }
      }
    }

    // --- 远海进攻 / 兑换 / 自杀(远海)：水路相关（仅邻海或已在海洋的兵）---
    const nearOcean =
      state.tiles[tile].terrain === TERRAIN.OCEAN ||
      neighborsOf(tile, geo).some((nb) => state.tiles[nb].terrain === TERRAIN.OCEAN);
    if (nearOcean) {
      const routes = routesOf(tile);
      const targets = oceanTargets(ctx, state, tile, routes);
      for (const { targetTile, best } of targets) {
        const target = state.tiles[targetTile].soldier!;
        const arrivalPower = best.strength; // 海洋兵为断兵，进攻力 = 兵力
        if (state.tiles[targetTile].terrain === TERRAIN.OCEAN) {
          // 远海进攻（目标海洋）：进攻力 > 兵力（严格）；等于归兑换
          if (arrivalPower > target.strength) {
            behaviors.push({
              kind: 'ocean',
              fromTile: tile,
              intents: [...best.path, { intentType: 'ATTACK', from: best.tile, to: targetTile }],
              targetTile,
            });
          }
        } else {
          // 远海进攻（目标沿海平原）：进攻力 ≥ 兵力（含同归于尽）
          if (arrivalPower >= target.strength) {
            behaviors.push({
              kind: 'ocean',
              fromTile: tile,
              intents: [...best.path, { intentType: 'ATTACK', from: best.tile, to: targetTile }],
              targetTile,
            });
          }
        }
      }
      // 兑换：目标位于海洋；最短水路进攻成功 且 存在等兵力到达路线
      for (const { targetTile, best, exact } of targets) {
        const target = state.tiles[targetTile].soldier!;
        if (state.tiles[targetTile].terrain !== TERRAIN.OCEAN) continue;
        if (best.strength < target.strength) continue; // 条件①：最短水路进攻成功
        const exactRoute =
          exact ??
          routes.find(
            (r) =>
              neighborsOf(r.tile, geo).includes(targetTile) && r.strength === target.strength && r.hasMovement,
          );
        if (exactRoute) {
          behaviors.push({
            kind: 'exchange',
            fromTile: tile,
            intents: [...exactRoute.path, { intentType: 'ATTACK', from: exactRoute.tile, to: targetTile }],
            targetTile,
          });
        }
      }
      // 自杀（远海方式）：到达后进攻力 < X 兵力（必然失败）
      for (const { targetTile, best } of targets) {
        const target = state.tiles[targetTile].soldier!;
        if (best.strength >= target.strength) continue; // 会成功 → 非自杀
        const oldOk = suicideConditionHolds(ctx, state, tile, best.strength, targetTile, routesOf);
        const newOk = oceanSuicideNewCase(ctx, state, tile, targetTile, best);
        if (!oldOk && !newOk) continue;
        behaviors.push({
          kind: 'suicide',
          fromTile: tile,
          intents: [...best.path, { intentType: 'ATTACK', from: best.tile, to: targetTile }],
          targetTile,
        });
      }
    }

    // --- 自杀（就近方式）：A 已邻 X，进攻力 < X 兵力 ---
    {
      const sPower = attackPowerOf(s.strength, s.isLinked);
      for (const nb of neighborsOf(tile, geo)) {
        const t = state.tiles[nb];
        if (!t.soldier) continue;
        if (!isAttackableTarget(state, ctx.seat, t.soldier.owner)) continue;
        if (sPower >= t.soldier.strength) continue; // 会成功（就近进攻已覆盖）
        if (suicideConditionHolds(ctx, state, tile, s.strength, nb, routesOf)) {
          behaviors.push({ kind: 'suicide', fromTile: tile, intents: [{ intentType: 'ATTACK', from: tile, to: nb }], targetTile: nb });
        }
      }
    }
  }
  return behaviors;
}

/** 自杀条件②：存在其他我方兵 B 能对 X 发起合法进攻，且所有此类 B 到达兵力 > A 到达兵力 */
function suicideConditionHolds(
  ctx: Ctx,
  state: GameState,
  aTile: number,
  aArrivalStrength: number,
  xTile: number,
  routesOf: (tile: number) => OceanRouteNode[],
): boolean {
  const geo = { rows: state.rows, columns: state.columns, cylindrical: state.cylindrical };
  let hasOther = false;
  for (let tile = 0; tile < state.tiles.length; tile++) {
    if (tile === aTile) continue;
    const s = state.tiles[tile].soldier;
    if (!s || s.owner !== ctx.seat || !s.hasMovement) continue;
    if (s.isLinked && s.strength === 1) continue;
    let arrival = -1;
    if (neighborsOf(tile, geo).includes(xTile)) {
      arrival = s.strength; // 就近：无移动损耗
    } else if (state.tiles[tile].terrain === TERRAIN.OCEAN || neighborsOf(tile, geo).some((nb) => state.tiles[nb].terrain === TERRAIN.OCEAN)) {
      // 远海方式可达 X 周围（合法进攻不论成败）：取最大到达兵力
      for (const r of routesOf(tile)) {
        if (neighborsOf(r.tile, geo).includes(xTile) && r.hasMovement) arrival = Math.max(arrival, r.strength);
      }
    }
    if (arrival < 0) continue;
    hasOther = true;
    if (arrival <= aArrivalStrength) return false; // 存在到达兵力 ≤ A 的 B → 条件②不成立
  }
  return hasOther;
}

/**
 * 海洋断兵自杀新情形（2026-09-20）：该兵是海洋断兵，且发起必败进攻后，
 * 出现进攻前不能、进攻后能对 X 进行远海进攻/自杀的我方兵（X 被削弱或航道打通）→ 允许自杀。
 * 等价于海洋版的"消耗战开瓶器"：A 的牺牲为后续远海进攻/自杀铺路。
 */
function oceanSuicideNewCase(
  ctx: Ctx,
  state: GameState,
  aTile: number,
  xTile: number,
  best: OceanRouteNode,
): boolean {
  const a = state.tiles[aTile].soldier!;
  if (a.isLinked || state.tiles[aTile].terrain !== TERRAIN.OCEAN) return false; // 须为海洋断兵
  // 模拟 A 的必败进攻（到达 + ATTACK，走真实 reducer）
  const post = applyAll(ctx, state, [...best.path, { intentType: 'ATTACK', from: best.tile, to: xTile }]);
  if (!post || !post.tiles[xTile].soldier) return false; // A 必败 → X 应存活
  // 检查是否存在 B：进攻前不能、进攻后能对 X 远海进攻/自杀
  for (let bTile = 0; bTile < state.tiles.length; bTile++) {
    if (bTile === aTile) continue;
    const s = state.tiles[bTile].soldier;
    if (!s || s.owner !== ctx.seat) continue;
    const pre = canOceanActOn(ctx, state, bTile, xTile);
    const postAbility = canOceanActOn(ctx, post, bTile, xTile);
    if (postAbility !== 'none' && pre === 'none') return true; // 新获得能力
  }
  return false;
}

/** B 能否对 X 发起远海进攻（成功）或自杀（必败）：'none' | 'ocean' | 'suicide' */
function canOceanActOn(
  ctx: Ctx,
  state: GameState,
  bTile: number,
  xTile: number,
): 'none' | 'ocean' | 'suicide' {
  const geo = { rows: state.rows, columns: state.columns, cylindrical: state.cylindrical };
  const s = state.tiles[bTile].soldier;
  if (!s || s.owner !== ctx.seat || !s.hasMovement) return 'none';
  if (s.isLinked && s.strength === 1) return 'none';
  const nearOcean =
    state.tiles[bTile].terrain === TERRAIN.OCEAN ||
    neighborsOf(bTile, geo).some((nb) => state.tiles[nb].terrain === TERRAIN.OCEAN);
  if (!nearOcean) return 'none';
  const target = state.tiles[xTile].soldier;
  if (!target || !isAttackableTarget(state, ctx.seat, target.owner)) return 'none';
  const xTerrain = state.tiles[xTile].terrain;
  if (xTerrain !== TERRAIN.OCEAN && xTerrain !== TERRAIN.PLAIN) return 'none';
  // 最强到达兵力：已在海洋且邻 X 可直接进攻；否则走水路
  let bestArrival = -1;
  if (state.tiles[bTile].terrain === TERRAIN.OCEAN && neighborsOf(bTile, geo).includes(xTile)) {
    bestArrival = Math.max(bestArrival, s.strength);
  }
  const routes = oceanRoutes(ctx, state, bTile);
  for (const r of routes) {
    if (r.hasMovement && neighborsOf(r.tile, geo).includes(xTile)) {
      bestArrival = Math.max(bestArrival, r.strength);
    }
  }
  if (bestArrival < 0) return 'none';
  if (xTerrain === TERRAIN.OCEAN ? bestArrival > target.strength : bestArrival >= target.strength) {
    return 'ocean'; // 远海进攻（沿海平原含同归于尽）
  }
  return 'suicide'; // 到达兵力 < X → 可自杀（必败）
}

// ---------- 链推进（规则1 / 规则2 a/b/c） ----------

interface ChainNode {
  state: GameState;
  intents: PlayerIntent[];
  /** 上一行为类型 */
  kind: BehaviorKind;
  /** 自杀/兑换的目标格 */
  targetTile?: number;
  /** 规则1 锁兵格 */
  lockedTile: number | null;
  /** 兑换分支：紧邻一次限制是否已用 */
  exchangeFollowupUsed: boolean;
  /** 自杀消耗战已使用兵格（A 与失败的 B） */
  usedTiles: Set<number>;
}

/** 行为执行后"仍有移动力的生成兵"（规则1 锁定对象）：检查意图终点格 */
function operatedMover(state: GameState, seat: number, behavior: Behavior): number | null {
  const last = behavior.intents[behavior.intents.length - 1];
  if (last.intentType !== 'MOVE' && last.intentType !== 'ATTACK') return null;
  const s = state.tiles[last.to].soldier;
  if (s && s.owner === seat && s.hasMovement) return last.to;
  return null;
}

/** 收集某原点某首行为的全部终止链（锁兵分叉 / 消耗战 / 兑换分支按分支展开，带工程上限） */
function expandChains(ctx: Ctx, origin: GameState, first: Behavior): Chain[] {
  const out: Chain[] = [];
  const firstState = applyAll(ctx, origin, first.intents);
  const node: ChainNode = {
    state: firstState,
    intents: [...first.intents],
    kind: first.kind,
    targetTile: first.targetTile,
    lockedTile: operatedMover(firstState, ctx.seat, first),
    exchangeFollowupUsed: false,
    usedTiles: new Set(first.kind === 'suicide' ? [first.fromTile] : []),
  };
  expandChainNode(ctx, node, out);
  return out;
}

function expandChainNode(ctx: Ctx, node: ChainNode, out: Chain[]): void {
  if (out.length >= ctx.maxChainsPerBehavior || ctx.applies >= ctx.maxApplies) {
    out.push({ state: node.state, intents: node.intents });
    return;
  }
  if (node.intents.length > 200) {
    out.push({ state: node.state, intents: node.intents });
    return;
  }

  // 规则1：锁兵延续
  if (node.lockedTile !== null) {
    const locked = node.lockedTile;
    const soldier = node.state.tiles[locked].soldier;
    if (!soldier || soldier.owner !== ctx.seat || !soldier.hasMovement) {
      out.push({ state: node.state, intents: node.intents });
      return;
    }
    const options = enumerateBehaviors(ctx, node.state, locked);
    if (options.length === 0) {
      out.push({ state: node.state, intents: node.intents }); // 锁兵无可执行行为 → 链终止
      return;
    }
    for (const opt of options) {
      const next = applyAll(ctx, node.state, opt.intents);
      expandChainNode(ctx, {
        state: next,
        intents: [...node.intents, ...opt.intents],
        kind: opt.kind,
        targetTile: opt.targetTile,
        lockedTile: operatedMover(next, ctx.seat, opt),
        exchangeFollowupUsed: node.exchangeFollowupUsed,
        usedTiles: node.usedTiles,
      }, out);
      if (out.length >= ctx.maxChainsPerBehavior || ctx.applies >= ctx.maxApplies) return;
    }
    return;
  }

  // 规则2 分派
  switch (node.kind) {
    case 'spread':
    case 'adjacent':
    case 'ocean':
      out.push({ state: node.state, intents: node.intents }); // a) 链终止
      return;
    case 'suicide': {
      // b) 消耗战循环：补刀列表分支展开（每个可用的 B 一条链；失败的 B 继续递归消耗）
      const X = node.targetTile!;
      const L = patchList(ctx, node.state, X, node.usedTiles);
      if (L.length === 0) {
        out.push({ state: node.state, intents: node.intents });
        return;
      }
      for (const b of L) {
        const next = applyAll(ctx, node.state, b.intents);
        const used = new Set(node.usedTiles);
        used.add(b.fromTile);
        const lastFrom = b.intents[b.intents.length - 1].intentType === 'ATTACK' ? (b.intents[b.intents.length - 1] as { from: number }).from : b.fromTile;
        const xDead = !next.tiles[X].soldier || next.tiles[X].soldier!.owner === ctx.seat;
        if (xDead) {
          // X 被成功攻击：解除限制；B 仍有移动力 → 规则1 锁 B 继续 → 最终回规则2 终止
          const mover = operatedMover(next, ctx.seat, { kind: 'adjacent', fromTile: b.fromTile, intents: b.intents, targetTile: X });
          expandChainNode(ctx, {
            state: next,
            intents: [...node.intents, ...b.intents],
            kind: 'adjacent',
            lockedTile: mover,
            exchangeFollowupUsed: node.exchangeFollowupUsed,
            usedTiles: used,
          }, out);
        } else {
          // B 进攻失败（死亡或失去移动力）→ 移出 L，回到补刀列表
          if (next.tiles[lastFrom].soldier) used.add(lastFrom);
          expandChainNode(ctx, {
            state: next,
            intents: [...node.intents, ...b.intents],
            kind: 'suicide',
            targetTile: X,
            lockedTile: null,
            exchangeFollowupUsed: node.exchangeFollowupUsed,
            usedTiles: used,
          }, out);
        }
        if (out.length >= ctx.maxChainsPerBehavior || ctx.applies >= ctx.maxApplies) return;
      }
      return;
    }
    case 'exchange': {
      // c) 兑换分支：紧邻一次只能是 兑换/远海进攻/自杀
      if (node.exchangeFollowupUsed) {
        out.push({ state: node.state, intents: node.intents });
        return;
      }
      const all = enumerateBehaviors(ctx, node.state, null);
      const allowed = all.filter((b) => b.kind === 'exchange' || b.kind === 'ocean' || b.kind === 'suicide');
      if (allowed.length === 0) {
        out.push({ state: node.state, intents: node.intents });
        return;
      }
      for (const opt of allowed) {
        const next = applyAll(ctx, node.state, opt.intents);
        expandChainNode(ctx, {
          state: next,
          intents: [...node.intents, ...opt.intents],
          kind: opt.kind,
          targetTile: opt.targetTile,
          lockedTile: operatedMover(next, ctx.seat, opt),
          exchangeFollowupUsed: true,
          usedTiles: node.usedTiles,
        }, out);
        if (out.length >= ctx.maxChainsPerBehavior || ctx.applies >= ctx.maxApplies) return;
      }
      return;
    }
  }
}

/**
 * 补刀列表（自杀消耗战）：L = { B | 未使用，存在仅由铺场/就近进攻构成的合法序列到达 X 周围，
 * 全程可行动，到达后能对 X 发起合法进攻（不要求成功）}。按到达兵力降序（选最强补刀）。
 */
interface PatchCandidate {
  fromTile: number;
  /** 到达 X 周围时的兵力 */
  arrivalStrength: number;
  /** 到达 X 周围时的所在格 */
  arrivalTile: number;
  /** 推进意图 + 到达格对 X 的 ATTACK */
  intents: PlayerIntent[];
}

function patchList(ctx: Ctx, state: GameState, xTile: number, used: Set<number>): PatchCandidate[] {
  if (!state.tiles[xTile].soldier) return [];
  const out: PatchCandidate[] = [];
  for (let tile = 0; tile < state.tiles.length; tile++) {
    if (used.has(tile)) continue;
    const s = state.tiles[tile].soldier;
    if (!s || s.owner !== ctx.seat || !s.hasMovement) continue;
    const cand = patchApproach(ctx, state, tile, xTile);
    if (cand) out.push(cand);
  }
  out.sort((a, b) => b.arrivalStrength - a.arrivalStrength || a.fromTile - b.fromTile);
  return out;
}

/** B 的铺场/就近进攻 BFS：到达 X 邻格并可合法进攻 X；返回最强到达兵力与意图路径 */
function patchApproach(ctx: Ctx, state: GameState, startTile: number, xTile: number): PatchCandidate | null {
  const geo = { rows: state.rows, columns: state.columns, cylindrical: state.cylindrical };
  interface BfsNode {
    state: GameState;
    tile: number;
    intents: PlayerIntent[];
  }
  const visited = new Set<string>();
  let frontier: BfsNode[] = [{ state, tile: startTile, intents: [] }];
  let best: PatchCandidate | null = null;
  let expansions = 0;
  const maxExpansions = 240; // 工程：单兵补刀 BFS 预算
  while (frontier.length > 0 && expansions < maxExpansions) {
    const next: BfsNode[] = [];
    for (const node of frontier) {
      expansions++;
      const s = node.state.tiles[node.tile].soldier;
      if (!s || s.owner !== ctx.seat || !s.hasMovement) continue;
      // 目标判定：已邻 X 且可合法进攻（到达后能对 X 发起合法进攻，不要求成功）
      if (neighborsOf(node.tile, geo).includes(xTile)) {
        const arrivalStrength = s.strength;
        if (!best || arrivalStrength > best.arrivalStrength) {
          best = { fromTile: startTile, arrivalTile: node.tile, arrivalStrength, intents: [...node.intents] };
        }
        continue; // 已在 X 周围：不再推进（进攻 X 由循环主体执行）
      }
      const key = `${node.tile}:${s.strength}`;
      if (visited.has(key)) continue;
      visited.add(key);
      // 铺场：移动到相邻空平原/空据点
      for (const nb of neighborsOf(node.tile, geo)) {
        const t = node.state.tiles[nb];
        if (t.soldier) continue;
        if (t.terrain !== TERRAIN.PLAIN && t.terrain !== TERRAIN.CITY) continue;
        const nextState = applyOne(ctx, node.state, { intentType: 'MOVE', from: node.tile, to: nb });
        if (!nextState) continue;
        next.push({ state: nextState, tile: nb, intents: [...node.intents, { intentType: 'MOVE', from: node.tile, to: nb }] });
      }
      // 就近进攻：攻击相邻敌兵且进攻成功（失败则无法继续推进）
      if (s.isLinked) {
        for (const nb of neighborsOf(node.tile, geo)) {
          const t = node.state.tiles[nb];
          if (!t.soldier) continue;
          if (!isAttackableTarget(node.state, ctx.seat, t.soldier.owner)) continue;
          if (attackPowerOf(s.strength, true) < t.soldier.strength) continue;
          const nextState = applyOne(ctx, node.state, { intentType: 'ATTACK', from: node.tile, to: nb });
          if (!nextState) continue;
          next.push({ state: nextState, tile: nb, intents: [...node.intents, { intentType: 'ATTACK', from: node.tile, to: nb }] });
        }
      }
    }
    frontier = next;
  }
  if (best) {
    // 补刀意图 = 推进路径 + 到达格对 X 的进攻
    best.intents = [...best.intents, { intentType: 'ATTACK', from: best.arrivalTile, to: xTile }];
  }
  return best;
}

// ---------- 前置行为（进攻据点） ----------

/** 前置判定与执行：返回前置意图链（若成立）与根原点局面 */
function preempt(ctx: Ctx, state: GameState): { intents: PlayerIntent[]; state: GameState } {
  const geo = { rows: state.rows, columns: state.columns, cylindrical: state.cylindrical };
  let bestTarget: number | null = null;
  let bestAttackers: number[] = [];
  let bestSum = -1;
  for (let tile = 0; tile < state.tiles.length; tile++) {
    const t = state.tiles[tile];
    if (!isStrongholdTerrain(t.terrain)) continue;
    const defender = t.soldier;
    if (!defender || !isAttackableTarget(state, ctx.seat, defender.owner)) continue;
    const attackers: number[] = [];
    let sum = 0;
    for (const nb of neighborsOf(tile, geo)) {
      const s = state.tiles[nb].soldier;
      if (!s || s.owner !== ctx.seat || !s.hasMovement) continue;
      attackers.push(nb);
      sum += attackPowerOf(s.strength, s.isLinked);
    }
    if (attackers.length > 0 && sum > defender.strength && sum > bestSum) {
      // 多个敌方据点满足时取进攻力总和最大者（文档未规定；确定性取最大）
      bestTarget = tile;
      bestAttackers = attackers;
      bestSum = sum;
    }
  }
  if (bestTarget === null) return { intents: [], state };
  bestAttackers.sort((a, b) => {
    const sa = state.tiles[a].soldier!;
    const sb = state.tiles[b].soldier!;
    return sb.strength - sa.strength || a - b;
  });
  const target = bestTarget;
  const intents: PlayerIntent[] = bestAttackers.map((t) => ({ intentType: 'ATTACK' as const, from: t, to: target }));
  const after = applyAll(ctx, state, intents);
  return { intents, state: after };
}

// ---------- 防守行为段 ----------

/** 下海候选批准 + 冲突排除；返回追加的防守意图列表 */
function defenseIntents(ctx: Ctx, leaf: GameState, baseScore: number): PlayerIntent[] {
  if (leaf.phase !== 'ACTION' || leaf.finished) return [];
  const geo = { rows: leaf.rows, columns: leaf.columns, cylindrical: leaf.cylindrical };
  const approved: Array<{ to: number; intent: PlayerIntent }> = [];
  for (let tile = 0; tile < leaf.tiles.length; tile++) {
    const s = leaf.tiles[tile].soldier;
    if (!s || s.owner !== ctx.seat || !s.hasMovement) continue;
    for (const nb of neighborsOf(tile, geo)) {
      const t = leaf.tiles[nb];
      if (t.terrain !== TERRAIN.OCEAN || t.soldier) continue; // 空海洋格
      const sim = applyOne(ctx, leaf, { intentType: 'MOVE', from: tile, to: nb });
      if (!sim) continue;
      if (evalApe(sim, ctx.turnStart, ctx.seat) > baseScore) {
        approved.push({ to: nb, intent: { intentType: 'MOVE', from: tile, to: nb } });
      }
    }
  }
  // 冲突：目标格相同 → 冲突意图全部排除
  const byTarget = new Map<number, number>();
  for (const a of approved) byTarget.set(a.to, (byTarget.get(a.to) ?? 0) + 1);
  return approved.filter((a) => byTarget.get(a.to) === 1).map((a) => a.intent);
}

// ---------- 主入口 ----------

/** 行动阶段候选方案生成（top-N，训练环境 N=4） */
export function planActionPhase(state: GameState, seat: number, opts?: PlanActionOptions): ActionPlan[] {
  const nCandidates = opts?.candidates ?? 4;
  const ctx: Ctx = {
    seat,
    turnStart: state,
    applies: 0,
    maxApplies: opts?.maxApplies ?? 12_000,
    leaves: 0,
    maxLeaves: opts?.maxLeaves ?? 100,
    maxChainsPerBehavior: opts?.maxChainsPerOrigin ?? 4,
  };

  // ① 前置行为段
  const pre = preempt(ctx, state);
  const rootOrigin = pre.state;
  const prefix = pre.intents;

  // ② 基础行为段 DFS
  const plans: InternalPlan[] = [];
  searchOrigin(ctx, rootOrigin, prefix, plans);

  // ③ 汇总 top-N
  plans.sort((a, b) => b.score - a.score || a.intents.length - b.intents.length || cmpIntents(a.intents, b.intents));
  const top = plans.slice(0, nCandidates);

  // ④ 防守行为段：对每条候选路径执行（基线 = 该路径方案 E_ape）
  return top.map((p) => {
    const defense = defenseIntents(ctx, p.leaf, p.score);
    return { intents: [...p.intents, ...defense], score: p.score, leaf: p.leaf };
  });
}

interface InternalPlan {
  intents: PlayerIntent[];
  score: number;
  leaf: GameState;
}

function cmpIntents(a: PlayerIntent[], b: PlayerIntent[]): number {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** 基础行为段搜索：枚举原点行为 → 链推进 → top-2 递归；叶子记录方案 */
function searchOrigin(ctx: Ctx, origin: GameState, path: PlayerIntent[], plans: InternalPlan[]): void {
  const recordLeaf = (): void => {
    ctx.leaves++;
    plans.push({ intents: [...path], score: evalApe(origin, ctx.turnStart, ctx.seat), leaf: origin });
  };
  if (ctx.leaves >= ctx.maxLeaves || ctx.applies >= ctx.maxApplies || origin.finished) {
    recordLeaf();
    return;
  }
  const behaviors = enumerateBehaviors(ctx, origin, null);
  if (behaviors.length === 0) {
    recordLeaf();
    return;
  }
  // 原点级剪枝（v1.4）：存在自杀/兑换 → 仅保留该二类分支（不应用于规则1 锁兵状态）
  const hasSuicideOrExchange = behaviors.some((b) => b.kind === 'suicide' || b.kind === 'exchange');
  const branches = hasSuicideOrExchange
    ? behaviors.filter((b) => b.kind === 'suicide' || b.kind === 'exchange')
    : behaviors;

  // 逐行为展开，仅保留 running top-2（避免全量链状态驻留导致内存膨胀）
  let top2: Array<Chain & { score: number }> = [];
  for (const b of branches) {
    for (const chain of expandChains(ctx, origin, b)) {
      const scored = { ...chain, score: evalApe(chain.state, ctx.turnStart, ctx.seat) };
      if (top2.length < 2) {
        top2.push(scored);
        top2.sort((x, y) => y.score - x.score || x.intents.length - y.intents.length || cmpIntents(x.intents, y.intents));
      } else if (
        scored.score > top2[1].score ||
        (scored.score === top2[1].score &&
          (scored.intents.length < top2[1].intents.length ||
            (scored.intents.length === top2[1].intents.length && cmpIntents(scored.intents, top2[1].intents) < 0)))
      ) {
        top2[1] = scored;
        top2.sort((x, y) => y.score - x.score || x.intents.length - y.intents.length || cmpIntents(x.intents, y.intents));
      }
    }
    if (ctx.applies >= ctx.maxApplies || ctx.leaves >= ctx.maxLeaves) break;
  }
  if (top2.length === 0) {
    recordLeaf();
    return;
  }
  for (const c of top2) {
    searchOrigin(ctx, c.state, [...path, ...c.intents], plans);
  }
}
