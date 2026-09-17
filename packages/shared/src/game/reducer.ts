// 权威 reducer：意图 → 事件链（规则 v2 §8 全事件全集）。
// 纯函数、全整数运算、迭代顺序确定（线性 index 升序 / 固定邻居表序），跨端确定性（P5/P7）。
// 级联语义（§1.4）：子事件同步处理完毕后父事件才继续——实现为同步递归，chain 按执行序记录。
import type {
  ApplyResult,
  ConsensusReport,
  ForceState,
  GameEvent,
  GameState,
  InitStateInput,
  InitStateResult,
  IntentEnvelope,
  Phase,
  RejectReason,
  SoldierState,
} from './types.js';
import { TERRAIN } from '../types.js';
import {
  TERRAIN_PROPS,
  isFullBreak,
  isFullLink,
  isStrongholdTerrain,
  isNeutralOwner,
  isBlockerOwner,
} from './constants.js';
import type { BoardGeometry } from './coord.js';
import { neighborsOf, areAdjacent } from './coord.js';
import { hexDistance } from './distance.js';

// ---------- 内部上下文 ----------

interface Ctx {
  state: GameState;
  geo: BoardGeometry;
  chain: GameEvent[];
  consensus: ConsensusReport[];
}

function cloneState(s: GameState): GameState {
  return {
    ...s,
    forces: s.forces.map((f) => ({ ...f })),
    tiles: s.tiles.map((t) => ({ terrain: t.terrain, soldier: t.soldier ? { ...t.soldier } : null })),
    timeSettings: { ...s.timeSettings },
  };
}

function forceOf(state: GameState, seat: number): ForceState | undefined {
  return state.forces.find((f) => f.seat === seat);
}

/** 队伍判定（§5）：中立兵（野生/阻挡）不与任何势力同队 */
function sameTeam(state: GameState, a: number, b: number): boolean {
  if (isNeutralOwner(a) || isNeutralOwner(b)) return false;
  const fa = forceOf(state, a);
  const fb = forceOf(state, b);
  return !!fa && !!fb && fa.team === fb.team;
}

/** 连通判定（§9）：中立兵之间按 owner 相等参与连断级联 */
function sameConnectivityOwner(a: number, b: number): boolean {
  return a === b;
}

export function linkedCountOf(state: GameState, seat: number): number {
  let n = 0;
  for (const t of state.tiles) {
    if (t.soldier && t.soldier.owner === seat && t.soldier.isLinked) n++;
  }
  return n;
}

export function strongholdCountOf(state: GameState, seat: number): number {
  let n = 0;
  for (const t of state.tiles) {
    if (t.soldier && t.soldier.owner === seat && isStrongholdTerrain(t.terrain)) n++;
  }
  return n;
}

function hasAliveHumanForce(state: GameState): boolean {
  return state.forces.some((f) => f.exists && f.alive && !f.isAI);
}

/** 当前势力是否有可行动的兵（行动阶段自动切换判定；与意图层可行动判定一致：兵力 1 连兵不可行动） */
function hasMovableSoldier(ctx: Ctx, seat: number): boolean {
  for (const t of ctx.state.tiles) {
    const s = t.soldier;
    if (s && s.owner === seat && s.hasMovement && !(s.isLinked && s.strength === 1)) return true;
  }
  return false;
}

/** 行动阶段自动跳过（补充规则）：当前势力无任何可行动兵 → 代玩家发起一次跳过阶段事件（ACTION → ADD_POINT）。
 *  触发时机：每次玩家事件链结算后判断一次；回合初进入行动阶段同样复用本判定。 */
function autoSkipActionPhase(ctx: Ctx, seat: number): void {
  if (ctx.state.phase !== 'ACTION' || ctx.state.currentSeat !== seat) return;
  if (hasMovableSoldier(ctx, seat)) return;
  switchPhaseEventCore(ctx);
}

// ---------- 二级事件（§8.2） ----------

/** 兵生成（§8.2.1）。soldier 为完整属性；落地时按地形强制兵种，随后发起重连事件 */
function spawnEvent(ctx: Ctx, tile: number, soldier: SoldierState): void {
  const terrain = ctx.state.tiles[tile].terrain;
  const s: SoldierState = { ...soldier };
  const conn = TERRAIN_PROPS[terrain]?.connectivity;
  if (conn === 'HALF') s.isLinked = false;
  else if (conn === 'FULL_LINK') s.isLinked = true;
  ctx.state.tiles[tile].soldier = s;
  ctx.chain.push({ level: 2, kind: 'SPAWN', tile, soldier: { ...s } });
  rejoinEvent(ctx, tile);
}

/** 兵更新（§8.2.2）。兵力归 0 → 转兵消失；断→连发重连、连→断发断连；地形兵种强制（§4.1：半断→断、全接→连） */
function updateEvent(ctx: Ctx, tile: number, patch: Partial<SoldierState>): void {
  const cur = ctx.state.tiles[tile].soldier;
  if (!cur) return;
  const after: SoldierState = { ...cur, ...patch };
  const conn = TERRAIN_PROPS[ctx.state.tiles[tile].terrain]?.connectivity;
  if (conn === 'HALF') after.isLinked = false;
  else if (conn === 'FULL_LINK') after.isLinked = true;
  if (after.strength <= 0) {
    despawnEvent(ctx, tile);
    return;
  }
  const unchanged =
    after.owner === cur.owner &&
    after.strength === cur.strength &&
    after.isLinked === cur.isLinked &&
    after.hasMovement === cur.hasMovement &&
    after.counter === cur.counter;
  if (unchanged) return;
  ctx.state.tiles[tile].soldier = after;
  ctx.chain.push({ level: 2, kind: 'UPDATE', tile, before: { ...cur }, after: { ...after } });
  if (cur.isLinked !== after.isLinked) {
    if (after.isLinked) rejoinEvent(ctx, tile);
    else breakEvent(ctx, tile, after.owner);
  }
}

/** 兵消失（§8.2.3）。据点删兵 → 势力清除（校验据点数）；随后发起断连事件 */
function despawnEvent(ctx: Ctx, tile: number): void {
  const cur = ctx.state.tiles[tile].soldier;
  if (!cur) return;
  ctx.state.tiles[tile].soldier = null;
  ctx.chain.push({ level: 2, kind: 'DESPAWN', tile, soldier: { ...cur } });
  if (isStrongholdTerrain(ctx.state.tiles[tile].terrain) && !isNeutralOwner(cur.owner)) {
    forceClearEvent(ctx, cur.owner, { checkStronghold: true, reason: 'no_stronghold' });
  }
  breakEvent(ctx, tile, cur.owner);
}

// ---------- 三级事件（§8.3） ----------

/** 重连（§8.3.1）：目标地块及周围同势力兵若连断并存，将断兵全部变连（级联传播）。
 *  实现澄清（§4.1 连兵性）：只有与连兵【直接相邻】的兵才变连——连兵链不能含断兵，
 *  海洋（半断）等永远断兵的兵不构成链桥，不能把桥另一侧的兵一并判连。 */
function rejoinEvent(ctx: Ctx, tile: number): void {
  ctx.chain.push({ level: 3, kind: 'REJOIN', tile });
  const cur = ctx.state.tiles[tile].soldier;
  if (!cur) return;
  const owner = cur.owner;
  const group = [tile, ...neighborsOf(tile, ctx.geo)].filter((t) => {
    const s = ctx.state.tiles[t].soldier;
    return s !== null && sameConnectivityOwner(s.owner, owner);
  });
  if (!group.some((t) => ctx.state.tiles[t].soldier!.isLinked)) return;
  for (const t of [...group].sort((a, b) => a - b)) {
    const s = ctx.state.tiles[t].soldier;
    if (s && sameConnectivityOwner(s.owner, owner) && !s.isLinked) {
      const hasLinkedNeighbor = neighborsOf(t, ctx.geo).some((n) => {
        const ns = ctx.state.tiles[n].soldier;
        return ns !== null && sameConnectivityOwner(ns.owner, owner) && ns.isLinked;
      });
      if (hasLinkedNeighbor) updateEvent(ctx, t, { isLinked: true });
    }
  }
}

/** 断连（§8.3.2）：删除 p 的兵后判断周围连兵环图是否分裂；分裂则对每个分支发起断连判定。
 *  环图 T 的边 = 物理相邻（规则 8.3.2 环边 12..61）——邻居表序并非环序（表序 i 与 i+1 未必物理相邻），
 *  故连通分支按 areAdjacent 判定；地图边缘邻居少于 6 时按实际邻接关系判定。
 *  实现澄清：p 位于全接地形（据点）时，即使环图未分裂，剩余网络也可能失去唯一锚点（§4.1 连兵性本质），
 *  故锚点删除对每个连通分支（含单分支）都发断连判定；判定幂等，多余发起无副作用。 */
function breakEvent(ctx: Ctx, tile: number, owner: number): void {
  // 环图 T 节点：p 的邻居中有同势力连兵的地块（§8.3.2 第 2 步，与地形无关）
  const kept: number[] = [];
  for (const n of neighborsOf(tile, ctx.geo)) {
    const s = ctx.state.tiles[n].soldier;
    if (s !== null && sameConnectivityOwner(s.owner, owner) && s.isLinked) kept.push(n);
  }
  // 连通分支：每分支取 index 最小节点为代表，发起断连判定
  let branches: number[] = [];
  if (kept.length > 0) {
    const components = connectedComponents(kept, (a, b) => areAdjacent(a, b, ctx.geo));
    if (components.length >= 2) {
      branches = components.map((c) => Math.min(...c));
    } else if (isFullLink(ctx.state.tiles[tile].terrain)) {
      // 锚点（据点兵）被删：单分支也可能失去全接连通，发起判定
      branches = [Math.min(...components[0])];
    }
    branches.sort((a, b) => a - b);
  }
  ctx.chain.push({ level: 3, kind: 'BREAK', tile, branches });
  for (const q of branches) breakJudgeEvent(ctx, q);
}

/** 小集合连通分量（节点数 ≤ 6，断连事件环图 T 用；边由 adjacent 判定） */
function connectedComponents<T>(nodes: T[], adjacent: (a: T, b: T) => boolean): T[][] {
  const comps: T[][] = [];
  const visited = new Set<T>();
  for (const start of nodes) {
    if (visited.has(start)) continue;
    const comp: T[] = [];
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      comp.push(cur);
      for (const n of nodes) {
        if (!visited.has(n) && adjacent(cur, n)) {
          visited.add(n);
          queue.push(n);
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

/** 断连判定（§8.4.1）：BFS 判断连兵区域是否仍连通到全接地形；未连到则全域断兵-1、归零删兵 */
function breakJudgeEvent(ctx: Ctx, tile: number): void {
  const start = ctx.state.tiles[tile].soldier;
  if (!start) {
    ctx.chain.push({ level: 4, kind: 'BREAK_JUDGE', tile, connected: true, region: [] });
    return;
  }
  const owner = start.owner;
  const region: number[] = [];
  const visited = new Set<number>([tile]);
  const queue: number[] = [tile];
  let connected = false;
  while (queue.length > 0) {
    const cur = queue.shift()!;
    region.push(cur);
    if (isFullLink(ctx.state.tiles[cur].terrain)) {
      connected = true;
      break;
    }
    for (const n of neighborsOf(cur, ctx.geo)) {
      if (visited.has(n)) continue;
      const s = ctx.state.tiles[n].soldier;
      if (s !== null && sameConnectivityOwner(s.owner, owner) && s.isLinked) {
        visited.add(n);
        queue.push(n);
      }
    }
  }
  ctx.chain.push({ level: 4, kind: 'BREAK_JUDGE', tile, connected, region: [...region].sort((a, b) => a - b) });
  if (connected) return;
  // 直接修改（不走兵更新/兵消失事件，避免递归，§8.4.1）
  for (const t of [...region].sort((a, b) => a - b)) {
    const s = ctx.state.tiles[t].soldier;
    if (!s || !sameConnectivityOwner(s.owner, owner) || !s.isLinked) continue;
    s.isLinked = false;
    s.strength -= 1;
    if (s.strength <= 0) {
      ctx.state.tiles[t].soldier = null;
      // 防御性条款：删除据点性地块上的兵 → 对该势力发起势力清除（实际全接地形必连兵，正常流程不可达）
      if (isStrongholdTerrain(ctx.state.tiles[t].terrain) && !isNeutralOwner(s.owner)) {
        forceClearEvent(ctx, s.owner, { checkStronghold: true, reason: 'no_stronghold' });
      }
    }
  }
}

// ---------- 四级事件（§8.4） ----------

function forceClearEvent(
  ctx: Ctx,
  seat: number,
  opts: { checkStronghold: boolean; reason: 'no_stronghold' | 'surrender' | 'timeout' },
): void {
  const f = forceOf(ctx.state, seat);
  if (!f || !f.exists || !f.alive) return;
  if (opts.checkStronghold && strongholdCountOf(ctx.state, seat) > 0) return;
  f.alive = false;
  f.points = 0;
  ctx.chain.push({ level: 4, kind: 'FORCE_CLEAR', seat, reason: opts.reason });
  ctx.consensus.push({ payload: { kind: 'FORCE_CLEAR', seat, reason: opts.reason }, nodeSeat: seat });
  // 删除全部兵（升序，走兵消失事件链条以维持据点数与断连判定正确性）
  for (let i = 0; i < ctx.state.tiles.length; i++) {
    const s = ctx.state.tiles[i].soldier;
    if (s && s.owner === seat) despawnEvent(ctx, i);
  }
  if (ctx.state.currentSeat === seat) endTurnEvent(ctx);
  victoryJudgeEvent(ctx);
}

function victoryJudgeEvent(ctx: Ctx): void {
  if (ctx.state.finished) return;
  const aliveForces = ctx.state.forces.filter((f) => f.exists && f.alive);
  const teams = [...new Set(aliveForces.map((f) => f.team))];
  // 规则 §8.4.3：存活势力全为同队 → 结束。
  // M4 扩展（防 AI 卡死）：无存活人类势力时也结束（仅剩 AI 的轮转无法推进；单队则照常判胜，否则平局 -1）。
  // 训练模式（allowAiOnly）：AI-only 对局继续轮转，由实际胜负收尾，不在此处判平。
  if (teams.length > 1 && (hasAliveHumanForce(ctx.state) || ctx.state.allowAiOnly)) return;
  const winningTeam = teams.length === 1 ? teams[0] : -1;
  const winners: string[] = [];
  const losers: string[] = [];
  for (const f of ctx.state.forces) {
    if (!f.exists || f.playerId === null) continue;
    if (f.team === winningTeam) winners.push(String(f.playerId));
    else losers.push(String(f.playerId));
  }
  ctx.state.finished = true;
  ctx.state.winners = winners;
  ctx.state.winningTeam = winningTeam;
  ctx.chain.push({ level: 4, kind: 'VICTORY', winningTeam, winners, losers });
  ctx.consensus.push({ payload: { kind: 'VICTORY', winningTeam, winners, losers }, nodeSeat: 0 });
}

// ---------- 一级事件（§8.1） ----------

/** 移动事件（§8.1.1）。完整前置判定；进攻成功进占复用本事件（无效则自然不进占）。
 *  opts.skipBreakDeduction：断兵移动时跳过复制 -1（断兵进攻成功 → 完整进占，§8.1.2）。 */
function moveEventCore(ctx: Ctx, from: number, to: number, opts?: { skipBreakDeduction?: boolean }): boolean {
  if (ctx.state.phase !== 'ACTION') return false;
  const origin = ctx.state.tiles[from].soldier;
  if (!origin || !origin.hasMovement) return false;
  if (origin.isLinked && origin.strength === 1) return false; // 兵力 1 连兵始终无移动力
  if (isFullBreak(ctx.state.tiles[to].terrain)) return false;
  const target = ctx.state.tiles[to].soldier;
  if (target) return false; // 同队无效；非同队由意图层转进攻，子事件不应遇到
  if (hexDistance(from, to, ctx.geo) > (TERRAIN_PROPS[ctx.state.tiles[to].terrain]?.moveDistance ?? 0)) return false;

  ctx.chain.push({ level: 1, kind: 'MOVE', from, to });
  const mover: SoldierState = { ...origin };
  if (mover.isLinked) {
    spawnEvent(ctx, to, mover); // ① 生成复制
    updateEvent(ctx, to, { strength: mover.strength - 1 }); // ② 复制 -1
    updateEvent(ctx, from, { strength: 1 }); // ③ 原兵变 1
  } else if (mover.strength !== 1) {
    spawnEvent(ctx, to, mover);
    if (!opts?.skipBreakDeduction) updateEvent(ctx, to, { strength: mover.strength - 1 });
    despawnEvent(ctx, from);
  } else {
    spawnEvent(ctx, to, { ...mover, strength: 1 });
    updateEvent(ctx, to, { hasMovement: false });
    despawnEvent(ctx, from);
  }
  applyInactiveJudgment(ctx, from, to);
  return true;
}

/** 移动力判断（§3.3）：海洋-进入失活 / 据点接触失活（对生成兵） */
function applyInactiveJudgment(ctx: Ctx, from: number, to: number): void {
  const gen = ctx.state.tiles[to].soldier;
  if (!gen || !gen.hasMovement) return;
  let lose = false;
  const toTerrain = ctx.state.tiles[to].terrain;
  if (TERRAIN_PROPS[toTerrain]?.oceanEnterInactive && ctx.state.tiles[from].terrain === TERRAIN.OCEAN) {
    lose = true;
  }
  if (!lose) {
    for (const n of neighborsOf(to, ctx.geo)) {
      if (!TERRAIN_PROPS[ctx.state.tiles[n].terrain]?.contactInactive) continue;
      const occ = ctx.state.tiles[n].soldier;
      if (occ && !sameTeam(ctx.state, gen.owner, occ.owner)) {
        lose = true;
        break;
      }
    }
  }
  if (lose) updateEvent(ctx, to, { hasMovement: false });
}

/** 进攻事件（§8.1.2） */
function attackEventCore(ctx: Ctx, from: number, to: number): boolean {
  if (ctx.state.phase !== 'ACTION') return false;
  const attacker = ctx.state.tiles[from].soldier;
  if (!attacker || !attacker.hasMovement) return false;
  if (attacker.isLinked && attacker.strength === 1) return false;
  const defender = ctx.state.tiles[to].soldier;
  if (!defender || sameTeam(ctx.state, attacker.owner, defender.owner)) return false;
  if (hexDistance(from, to, ctx.geo) > (TERRAIN_PROPS[ctx.state.tiles[to].terrain]?.moveDistance ?? 0)) return false;

  ctx.chain.push({ level: 1, kind: 'ATTACK', from, to });
  const power = attacker.isLinked ? attacker.strength - 1 : attacker.strength;
  if (power >= defender.strength) {
    // 进攻成功：反击伤害 → 删防守 → 进占（移动事件）
    if (defender.counter > 0) {
      updateEvent(ctx, from, { strength: attacker.strength - defender.strength });
    }
    despawnEvent(ctx, to);
    // 断兵进攻成功 → 进占移动不扣兵力（完整进占，§8.1.2）：损失已由反击结算体现，进占不应再扣复制 -1
    const moved = moveEventCore(ctx, from, to, {
      skipBreakDeduction: !attacker.isLinked,
    });
    if (moved) {
      const occupant = ctx.state.tiles[to].soldier;
      if (occupant && sameConnectivityOwner(occupant.owner, attacker.owner) && !occupant.isLinked && occupant.hasMovement) {
        updateEvent(ctx, to, { hasMovement: false }); // 断兵进攻后仍是断兵（§4.3 失去情形 5）
      }
    }
  } else {
    // 进攻失败
    updateEvent(ctx, to, { strength: defender.strength - power });
    const defNow = ctx.state.tiles[to].soldier;
    if (!defNow) return true;
    if (defNow.counter === 0) {
      updateEvent(ctx, from, { hasMovement: false });
    } else {
      despawnEvent(ctx, from);
      updateEvent(ctx, to, { counter: defNow.counter - 1 });
    }
  }
  return true;
}

/** 切换阶段事件（§8.1.4 + §6.1 阶段内容） */
function switchPhaseEventCore(ctx: Ctx): void {
  const seat = ctx.state.currentSeat;
  const from = ctx.state.phase;
  let to: Phase;
  switch (from) {
    case 'PREPARE':
      to = 'ACTION';
      ctx.state.phase = 'ACTION';
      break;
    case 'ACTION':
      to = 'ADD_POINT';
      ctx.state.phase = 'ADD_POINT';
      break;
    case 'ADD_POINT':
      to = 'END';
      ctx.state.phase = 'END';
      ctx.chain.push({ level: 1, kind: 'SWITCH_PHASE', seat, from, to });
      // 结束阶段内容：清除该势力所有兵移动力（升序）
      for (let i = 0; i < ctx.state.tiles.length; i++) {
        const s = ctx.state.tiles[i].soldier;
        if (s && s.owner === seat && s.hasMovement) updateEvent(ctx, i, { hasMovement: false });
      }
      endTurnEvent(ctx);
      return;
    case 'END':
    default:
      return; // 不可达（END 在事件内即转出）
  }
  ctx.chain.push({ level: 1, kind: 'SWITCH_PHASE', seat, from, to });
}

/** 结束回合事件（§6.2）：找次大存活 seat，末位回绕全局轮次 +1，进入其准备阶段 */
function endTurnEvent(ctx: Ctx): void {
  const fromSeat = ctx.state.currentSeat;
  const aliveSeats = ctx.state.forces.filter((f) => f.exists && f.alive).map((f) => f.seat);
  let next: number | null = null;
  const greater = aliveSeats.filter((s) => s > fromSeat).sort((a, b) => a - b);
  if (greater.length > 0) next = greater[0];
  else {
    ctx.state.turn += 1;
    const wrap = aliveSeats.filter((s) => s !== fromSeat).sort((a, b) => a - b);
    if (wrap.length > 0) next = wrap[0];
  }
  if (next === null) {
    // 无存活势力：记录后由随后的胜利判定收尾（平局）
    ctx.chain.push({ level: 1, kind: 'END_TURN', fromSeat, toSeat: fromSeat, turn: ctx.state.turn });
    ctx.state.phase = 'END';
    return;
  }
  ctx.state.currentSeat = next;
  ctx.state.phase = 'PREPARE';
  ctx.chain.push({ level: 1, kind: 'END_TURN', fromSeat, toSeat: next, turn: ctx.state.turn });
  if (!hasAliveHumanForce(ctx.state) && !ctx.state.allowAiOnly) {
    // 仅剩 AI/无存活人类：轮转无法推进（AI 即时完成回合会死循环），留给胜利判定结束对局。
    // 训练模式（allowAiOnly）：放行轮转，由外部驱动（如 AI bot/训练脚本）推进各 AI 回合。
    ctx.state.phase = 'END';
    return;
  }
  runPreparePhaseContent(ctx);
}

/** 准备阶段内容（§6.1）：点数发放 → 反击刷新 → 移动力发放 → 切入行动阶段；AI 轮到即自动跳过（D1；D3：难度 1~3 同 255） */
function runPreparePhaseContent(ctx: Ctx): void {
  const seat = ctx.state.currentSeat;
  const force = forceOf(ctx.state, seat);
  if (!force || !force.exists || !force.alive) return;
  // a. 连兵数量等量点数
  force.points += linkedCountOf(ctx.state, seat);
  // b. 所有不属于该势力的兵刷新反击为地块值（阻挡兵除外，含野生）
  for (let i = 0; i < ctx.state.tiles.length; i++) {
    const s = ctx.state.tiles[i].soldier;
    if (!s || s.owner === seat || isBlockerOwner(s.owner)) continue;
    const terrainCounter = TERRAIN_PROPS[ctx.state.tiles[i].terrain]?.counter ?? 0;
    if (s.counter !== terrainCounter) updateEvent(ctx, i, { counter: terrainCounter });
  }
  // c. 该势力所有兵发放移动力（兵力 1 连兵除外）
  for (let i = 0; i < ctx.state.tiles.length; i++) {
    const s = ctx.state.tiles[i].soldier;
    if (!s || s.owner !== seat) continue;
    if (s.isLinked && s.strength === 1) continue;
    if (!s.hasMovement) updateEvent(ctx, i, { hasMovement: true });
  }
  // d. 切入行动阶段
  switchPhaseEventCore(ctx);
  // 补充规则：进入行动阶段后当前势力无任何可行动兵 → 代玩家切换至加点阶段（复用统一判定）
  autoSkipActionPhase(ctx, seat);
  // AI 回合（难度 1~3 / 255）：不再由 reducer 派生完成——回合停在 ACTION / ADD_POINT，
  // 由提交方客户端（planAiTurn）以显式意图提交推进（AI 意图入流，回放直接应用记录意图）。
}

// ---------- 意图入口（P5 契约 §11.2） ----------

export function applyIntent(state: GameState, envelope: IntentEnvelope): ApplyResult {
  if (state.finished) return { ok: false, state, reason: 'NO_GAME' };
  const ctx: Ctx = {
    state: cloneState(state),
    geo: { rows: state.rows, columns: state.columns, cylindrical: state.cylindrical },
    chain: [],
    consensus: [],
  };
  const { actor, intent } = envelope;
  const s = ctx.state;
  const inBounds = (i: number) => i >= 0 && i < s.tiles.length;
  const actorIsCurrent = actor.kind === 'PLAYER' && actor.seat === s.currentSeat;

  switch (intent.intentType) {
    case 'MOVE':
    case 'ATTACK': {
      if (!actorIsCurrent) return reject(state, 'NOT_YOUR_TURN');
      if (s.phase !== 'ACTION') return reject(state, 'WRONG_PHASE');
      if (!inBounds(intent.from) || !inBounds(intent.to)) return reject(state, 'OUT_OF_BOUNDS');
      const origin = s.tiles[intent.from].soldier;
      const isAttack = intent.intentType === 'ATTACK';
      const illegal = isAttack ? 'ILLEGAL_ATTACK' : 'ILLEGAL_MOVE';
      if (!origin || origin.owner !== actor.seat) return reject(state, illegal);
      if (!origin.hasMovement || (origin.isLinked && origin.strength === 1)) return reject(state, illegal);
      if (isFullBreak(s.tiles[intent.to].terrain)) return reject(state, illegal);
      const target = s.tiles[intent.to].soldier;
      const maxDist = TERRAIN_PROPS[s.tiles[intent.to].terrain]?.moveDistance ?? 0;
      if (!isAttack && target && !sameTeam(s, origin.owner, target.owner)) {
        // §8.1.1 第 5 条：目标有非同队兵 → 转进攻
        const executed = attackEventCore(ctx, intent.from, intent.to);
        return executed ? ok(ctx) : reject(state, 'ILLEGAL_ATTACK');
      }
      if (target && sameTeam(s, origin.owner, target.owner)) return reject(state, illegal);
      if (!target && isAttack) return reject(state, illegal);
      if (hexDistance(intent.from, intent.to, ctx.geo) > maxDist) return reject(state, illegal);
      const executed = isAttack ? attackEventCore(ctx, intent.from, intent.to) : moveEventCore(ctx, intent.from, intent.to);
      // 事件链结算后统一判定：当前势力无任何可行动兵 → 代玩家自动跳过行动阶段
      if (executed) autoSkipActionPhase(ctx, actor.seat);
      return executed ? ok(ctx) : reject(state, illegal);
    }
    case 'ADD_POINT': {
      if (!actorIsCurrent) return reject(state, 'NOT_YOUR_TURN');
      if (s.phase !== 'ADD_POINT') return reject(state, 'WRONG_PHASE');
      if (!inBounds(intent.coordinate)) return reject(state, 'OUT_OF_BOUNDS');
      const force = forceOf(s, s.currentSeat);
      const target = s.tiles[intent.coordinate].soldier;
      if (!force || !target || target.owner !== s.currentSeat || !target.isLinked) {
        return reject(state, 'ILLEGAL_MOVE'); // 非当前势力连兵（枚举固定，借用 ILLEGAL_MOVE）
      }
      if (force.points < intent.amount) return reject(state, 'NO_POINTS');
      ctx.chain.push({ level: 1, kind: 'ADD_POINT', seat: s.currentSeat, coordinate: intent.coordinate, amount: intent.amount });
      updateEvent(ctx, intent.coordinate, { strength: target.strength + intent.amount });
      force.points -= intent.amount;
      // 补充规则：点数用尽 → 代玩家切换阶段结束回合
      if (force.points === 0) switchPhaseEventCore(ctx);
      // 事件链结算后统一判定（点数未用尽时保持加点阶段，行动阶段判定在此为空操作）
      autoSkipActionPhase(ctx, actor.seat);
      return ok(ctx);
    }
    case 'SWITCH_PHASE': {
      if (!actorIsCurrent) return reject(state, 'NOT_YOUR_TURN');
      if (s.phase !== 'ACTION' && s.phase !== 'ADD_POINT') return reject(state, 'WRONG_PHASE');
      switchPhaseEventCore(ctx);
      // 事件链结算后统一判定（本事件必然离开行动阶段，此处为空操作）
      autoSkipActionPhase(ctx, actor.seat);
      return ok(ctx);
    }
    case 'SURRENDER': {
      const force = forceOf(s, intent.seat);
      if (!force || !force.exists) return reject(state, 'SEAT_CLEARED');
      if (!force.alive) return reject(state, 'SEAT_CLEARED');
      const reason = intent.reason ?? 'voluntary';
      if (actor.kind === 'PLAYER') {
        if (intent.seat !== actor.seat) return reject(state, 'NOT_YOUR_TURN'); // 玩家只能投降自己
      } else if (reason !== 'timeout') {
        return reject(state, 'NOT_YOUR_TURN'); // 服务器仅可代发超时投降
      }
      ctx.chain.push({ level: 1, kind: 'SURRENDER', seat: intent.seat, reason });
      forceClearEvent(ctx, intent.seat, {
        checkStronghold: false,
        reason: reason === 'timeout' ? 'timeout' : 'surrender',
      });
      return ok(ctx);
    }
  }
}

function reject(state: GameState, reason: RejectReason): ApplyResult {
  return { ok: false, state, reason };
}

function ok(ctx: Ctx): ApplyResult {
  return { ok: true, state: ctx.state, chain: ctx.chain, consensus: ctx.consensus };
}

// ---------- 开局（§6.3 / §6.4） ----------

export function initState(input: InitStateInput): InitStateResult {
  const { map, seatAssignments, timeSettings } = input;
  const forces: ForceState[] = [...map.player_list]
    .sort((a, b) => a.seat - b.seat)
    .map((p) => {
      const assign = seatAssignments.find((a) => a.seat === p.seat);
      return {
        seat: p.seat,
        team: p.team,
        name: p.name,
        flag: p.flag,
        playerId: assign?.playerId ?? null,
        isAI: assign?.isAI ?? false,
        computer: assign?.computer ?? p.computer,
        exists: true,
        alive: true,
        points: 0,
      };
    });
  const tiles = map.battlefield.map(([terrain, belongs, strength]) => {
    const validOwner = !isNeutralOwner(belongs) ? belongs >= 1 && belongs <= 127 : true;
    const soldier: SoldierState | null =
      strength > 0 && validOwner
        ? {
            owner: belongs,
            strength,
            isLinked: false, // 先按断兵置入（§6.3）
            hasMovement: false,
            counter: isBlockerOwner(belongs) ? 0 : (TERRAIN_PROPS[terrain]?.counter ?? 0),
          }
        : null;
    return { terrain, soldier };
  });
  const state: GameState = {
    rows: map.row,
    columns: map.column,
    cylindrical: map.cylindrical_map,
    seed: input.seed,
    allowAiOnly: input.allowAiOnly ?? false,
    turn: 1,
    currentSeat: 0,
    phase: 'PREPARE',
    forces,
    tiles,
    timeSettings: { ...timeSettings },
    finished: false,
    winners: null,
    winningTeam: null,
  };
  const ctx: Ctx = {
    state,
    geo: { rows: map.row, columns: map.column, cylindrical: map.cylindrical_map },
    chain: [],
    consensus: [],
  };
  ctx.chain.push({ level: 1, kind: 'INIT' });

  // 初始化事件（§8.1.6）：全接地块的兵变连，级联重连整网（升序确定）
  for (let i = 0; i < tiles.length; i++) {
    const s = tiles[i].soldier;
    if (s && !s.isLinked && isFullLink(tiles[i].terrain)) updateEvent(ctx, i, { isLinked: true });
  }

  // 无主势力删兵（§6.4）：无玩家扮演且未被 AI 接管 → 删全部兵、不进轮转/胜负/共识（等同从未存在）
  for (const f of forces) {
    if (f.playerId !== null || f.isAI) continue;
    f.exists = false;
    f.alive = false;
    f.points = 0;
    for (let i = 0; i < tiles.length; i++) {
      const s = tiles[i].soldier;
      if (s && s.owner === f.seat) {
        tiles[i].soldier = null;
        ctx.chain.push({ level: 2, kind: 'DESPAWN', tile: i, soldier: { ...s } });
      }
    }
  }

  // 回合起点：座次最小的存在势力；无任何存在势力 → 直接终局（空局）
  const startSeat = forces.filter((f) => f.exists).map((f) => f.seat).sort((a, b) => a - b)[0];
  if (startSeat === undefined) {
    state.finished = true;
    state.winners = [];
    state.winningTeam = -1;
    return { state, chain: ctx.chain };
  }
  state.currentSeat = startSeat;
  runPreparePhaseContent(ctx);
  return { state, chain: ctx.chain };
}
