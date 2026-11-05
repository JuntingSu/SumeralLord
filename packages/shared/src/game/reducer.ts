// 权威 reducer：意图 → 事件链（规则 v2 §8 全事件全集）。
// 纯函数、全整数运算、迭代顺序确定（线性 index 升序 / 固定邻居表序），跨端确定性（P5/P7）。
// 级联语义（§1.4）：子事件同步处理完毕后父事件才继续——实现为同步递归，chain 按执行序记录。
import type {
  Actor,
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
import type { TriggerDef, TriggerEffect, TriggerDelta } from './trigger/types.js';
import type { StepDirty } from './trigger/delta.js';
import { createStepDirty, resetStepDirty, takeDelta, trackForce, trackTile } from './trigger/delta.js';
import { runTriggerTransaction } from './trigger/engine.js';
import type { TriggerExecutor } from './trigger/engine.js';
import { resolveForceRef, resolveSpawnForceRef } from './trigger/resolve.js';

// ---------- 内部上下文 ----------

interface Ctx {
  state: GameState;
  geo: BoardGeometry;
  chain: GameEvent[];
  consensus: ConsensusReport[];
  /** 当前步骤变化追踪（triggerMode 关闭时 enabled=false，调用为 no-op） */
  stepDirty: StepDirty;
  /** 地图触发器定义（来自 GameState，普通对局为空） */
  triggers: TriggerDef[];
  /** 触发器效果内插入的意图各自产生的增量（供引擎驱动动作类触发器） */
  intentDeltas: TriggerDelta[];
}

function cloneState(s: GameState): GameState {
  return {
    ...s,
    forces: s.forces.map((f) => ({ ...f })),
    tiles: s.tiles.map((t) => ({ terrain: t.terrain, soldier: t.soldier ? { ...t.soldier } : null })),
    timeSettings: { ...s.timeSettings },
    turnOrder: [...s.turnOrder],
    fogOverrides: s.fogOverrides
      ? { ...s.fogOverrides, revealed: [...s.fogOverrides.revealed], hidden: [...s.fogOverrides.hidden] }
      : null,
    triggerRuntime: s.triggerRuntime
      ? {
          ...s.triggerRuntime,
          firedCounts: { ...s.triggerRuntime.firedCounts },
          stateWatch: { ...(s.triggerRuntime.stateWatch ?? {}) },
          pending: s.triggerRuntime.pending.map((p) => ({ ...p })),
        }
      : null,
    triggers: [...s.triggers],
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

// 阶段跳过不再由 reducer 自动发起：行动阶段由前端按「我方兵全部变灰」判定、
// 加点阶段由前端/AI 驱动按「点数耗尽」判定，再以显式 SWITCH_PHASE 意图推进。

// ---------- 二级事件（§8.2） ----------

/** 兵生成（§8.2.1）。soldier 为完整属性；落地时按地形强制兵种，随后发起重连事件 */
function spawnEvent(ctx: Ctx, tile: number, soldier: SoldierState): void {
  const terrain = ctx.state.tiles[tile].terrain;
  const s: SoldierState = { ...soldier };
  const conn = TERRAIN_PROPS[terrain]?.connectivity;
  if (conn === 'HALF') s.isLinked = false;
  else if (conn === 'FULL_LINK') s.isLinked = true;
  trackTile(ctx.stepDirty, ctx.state, tile);
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
  trackTile(ctx.stepDirty, ctx.state, tile);
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
  trackTile(ctx.stepDirty, ctx.state, tile);
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
    trackTile(ctx.stepDirty, ctx.state, t);
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
  opts: { checkStronghold: boolean; reason: 'no_stronghold' | 'surrender' | 'timeout' | 'trigger' },
): void {
  const f = forceOf(ctx.state, seat);
  if (!f || !f.exists || !f.alive) return;
  if (opts.checkStronghold && strongholdCountOf(ctx.state, seat) > 0) return;
  trackForce(ctx.stepDirty, ctx.state, seat);
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
  // 战役模式延迟到触发器事务末尾统一判定，给控制转移留出机会
  if (!ctx.state.triggerMode) victoryJudgeEvent(ctx);
}

function victoryJudgeEvent(ctx: Ctx): void {
  if (ctx.state.finished) return;
  // 演示模式不做自动胜负判定：势力被清除后仍可继续操作
  if (ctx.state.demo?.noVictory) return;
  const aliveForces = ctx.state.forces.filter((f) => f.exists && f.alive);
  const teams = [...new Set(aliveForces.map((f) => f.team))];
  // 规则 §8.4.3：存活势力全为同队 → 结束。
  // M4 扩展（防 AI 卡死）：无存活人类势力时也结束（仅剩 AI 的轮转无法推进；单队则照常判胜，否则平局 -1）
  if (teams.length > 1 && hasAliveHumanForce(ctx.state)) return;
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
function moveEventCore(
  ctx: Ctx,
  from: number,
  to: number,
  opts?: { skipBreakDeduction?: boolean; ignorePhase?: boolean; ignoreMovement?: boolean },
): boolean {
  if (!opts?.ignorePhase && ctx.state.phase !== 'ACTION') return false;
  const origin = ctx.state.tiles[from].soldier;
  if (!origin || (!opts?.ignoreMovement && !origin.hasMovement)) return false;
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
    despawnEvent(ctx, from); // ① 断兵移动先删原兵（§8.1.1：消失先于生成）
    spawnEvent(ctx, to, mover); // ② 生成复制
    if (!opts?.skipBreakDeduction) updateEvent(ctx, to, { strength: mover.strength - 1 }); // ③ 复制 -1
  } else {
    despawnEvent(ctx, from); // ① 断兵移动先删原兵（§8.1.1：消失先于生成）
    spawnEvent(ctx, to, { ...mover, strength: 1 }); // ② 生成兵力 1 断兵
    updateEvent(ctx, to, { hasMovement: false }); // ③ 生成兵失去移动力
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

/** 进攻事件（§8.1.2）。ignorePhase/ignoreMovement：触发器插入意图时放宽回合与移动力限制 */
function attackEventCore(
  ctx: Ctx,
  from: number,
  to: number,
  opts?: { ignorePhase?: boolean; ignoreMovement?: boolean },
): boolean {
  if (!opts?.ignorePhase && ctx.state.phase !== 'ACTION') return false;
  const attacker = ctx.state.tiles[from].soldier;
  if (!attacker || (!opts?.ignoreMovement && !attacker.hasMovement)) return false;
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
      ignorePhase: opts?.ignorePhase,
      ignoreMovement: opts?.ignoreMovement,
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

/** 结束回合事件（§6.2）：按 turnOrder 找下一个存活势力，末位回绕全局轮次 +1，进入其准备阶段 */
function endTurnEvent(ctx: Ctx): void {
  const fromSeat = ctx.state.currentSeat;
  const alive = new Set(
    ctx.state.forces.filter((f) => f.exists && f.alive).map((f) => f.seat),
  );
  const order = ctx.state.turnOrder.filter((s) => alive.has(s));
  let next: number | null = null;
  if (order.length > 0) {
    const idx = order.indexOf(fromSeat);
    if (idx < 0) {
      // 当前 seat 不在行动顺序（异常/重排边界）：退回数值顺序兜底
      const greater = order.filter((s) => s > fromSeat);
      if (greater.length > 0) next = greater[0];
      else {
        ctx.state.turn += 1;
        next = order[0];
      }
    } else if (idx === order.length - 1) {
      ctx.state.turn += 1;
      next = order.length > 1 ? order[0] : null;
    } else {
      next = order[idx + 1];
    }
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
  if (!hasAliveHumanForce(ctx.state) && !ctx.state.triggerMode && !ctx.state.demo) {
    // 仅剩 AI/无存活人类：轮转无法推进（AI 即时完成回合会死循环），留给胜利判定结束对局
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
  trackForce(ctx.stepDirty, ctx.state, seat);
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
  // d. 切入行动阶段（是否因无可行动兵而跳过由前端/AI 驱动显式发起）
  switchPhaseEventCore(ctx);
  // AI 回合（难度 1~3 / 255）：不再由 reducer 派生完成——回合停在 ACTION / ADD_POINT，
  // 由提交方客户端（planAiTurn）以显式意图提交推进（AI 意图入流，回放直接应用记录意图）。
}

// ---------- 战役触发器效果 ----------

function mergeTileList(a: number[], b: number[]): number[] {
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}

type InsertIntentEffect = Extract<
  TriggerEffect,
  { op: 'insert_move_intent' | 'insert_attack_intent' | 'insert_add_point_intent' }
>;

/** 把插入意图产生的增量合并回触发器整体的 StepDirty（保留最早的 before 快照） */
function mergeDirty(target: StepDirty, delta: TriggerDelta): void {
  for (const t of delta.tiles) {
    target.tiles.add(t.index);
    if (!target.beforeTiles.has(t.index)) target.beforeTiles.set(t.index, t.before);
  }
  for (const f of delta.forces) {
    target.forces.add(f.seat);
    if (!target.beforeForces.has(f.seat)) target.beforeForces.set(f.seat, f.before);
  }
}

/**
 * 以指定势力执行一次意图核心（触发器效果专用）：
 * - 允许任意势力、任意时刻执行（跳过 actor/回合/阶段校验）
 * - MOVE/ATTACK 忽略移动力与连断兵移动限制；地形、距离、兵力 1 连兵等规则照常
 * - ADD_POINT 目标归属/连兵/点数照常检查
 * - 子事件写入同一条 chain，改动计入当前触发器增量
 */
function executeInsertedIntent(ctx: Ctx, effect: InsertIntentEffect): boolean {
  const seat = resolveForceRef(ctx.state, effect.force);
  if (seat === null) return false;
  const state = ctx.state;
  const inBounds = (i: number) => i >= 0 && i < state.tiles.length;

  if (effect.op === 'insert_add_point_intent') {
    if (!inBounds(effect.coordinate) || !Number.isInteger(effect.amount) || effect.amount <= 0) return false;
    const force = forceOf(state, seat);
    const target = state.tiles[effect.coordinate].soldier;
    if (!force || !target || target.owner !== seat || !target.isLinked) return false;
    if (!state.demo?.infinitePoints && force.points < effect.amount) return false;
    ctx.chain.push({ level: 1, kind: 'ADD_POINT', seat, coordinate: effect.coordinate, amount: effect.amount });
    updateEvent(ctx, effect.coordinate, { strength: target.strength + effect.amount });
    trackForce(ctx.stepDirty, ctx.state, seat);
    if (!state.demo?.infinitePoints) force.points -= effect.amount;
    return true;
  }

  const { from, to } = effect;
  if (!inBounds(from) || !inBounds(to)) return false;
  const origin = state.tiles[from].soldier;
  if (!origin || origin.owner !== seat) return false;
  const opts = { ignorePhase: true, ignoreMovement: true };
  const target = state.tiles[to].soldier;
  if (effect.op === 'insert_attack_intent') {
    if (!target) return false;
    return attackEventCore(ctx, from, to, opts);
  }
  // 移动意图：目标有非同队兵时按普通意图规则转为进攻
  if (target && sameTeam(state, origin.owner, target.owner)) return false;
  if (target) return attackEventCore(ctx, from, to, opts);
  return moveEventCore(ctx, from, to, opts);
}

/** 执行插入意图并收集其独立增量（供引擎驱动动作类触发器） */
function runInsertedIntent(ctx: Ctx, effect: InsertIntentEffect): TriggerDelta | null {
  const before = ctx.state;
  const savedDirty = ctx.stepDirty;
  const intentDirty = createStepDirty(true);
  ctx.stepDirty = intentDirty;
  let ok = false;
  try {
    ok = executeInsertedIntent(ctx, effect);
  } finally {
    ctx.stepDirty = savedDirty;
  }
  const delta = takeDelta(intentDirty, ctx.state, before);
  if (!ok) return null;
  mergeDirty(savedDirty, delta);
  return delta.tiles.length > 0 || delta.forces.length > 0 ? delta : null;
}

function applyTriggerEffect(ctx: Ctx, effect: TriggerEffect): void {
  switch (effect.op) {
    case 'spawn_soldier': {
      const tile = ctx.state.tiles[effect.tile];
      if (!tile) return;
      const owner = resolveSpawnForceRef(ctx.state, effect.force);
      if (owner === null) return;
      const soldier: SoldierState = {
        owner,
        strength: effect.strength,
        isLinked: false,
        hasMovement: effect.movement,
        counter: TERRAIN_PROPS[tile.terrain]?.counter ?? 0,
      };
      if (tile.soldier) despawnEvent(ctx, effect.tile);
      spawnEvent(ctx, effect.tile, soldier);
      return;
    }
    case 'update_soldier': {
      const tile = ctx.state.tiles[effect.tile];
      const before = tile?.soldier;
      if (!tile || !before) return;
      const p = effect.patch;
      const patch: Partial<SoldierState> = {};
      if (p.strength !== 'unchanged') patch.strength = p.strength;
      if (p.owner !== 'unchanged') patch.owner = p.owner;
      if (p.movement !== 'unchanged') patch.hasMovement = p.movement;
      updateEvent(ctx, effect.tile, patch);
      if (
        p.owner !== 'unchanged' &&
        p.owner !== before.owner &&
        isStrongholdTerrain(tile.terrain) &&
        !isNeutralOwner(before.owner)
      ) {
        forceClearEvent(ctx, before.owner, { checkStronghold: true, reason: 'no_stronghold' });
      }
      return;
    }
    case 'remove_soldier':
      despawnEvent(ctx, effect.tile);
      return;
    case 'set_terrain': {
      const tile = ctx.state.tiles[effect.tile];
      if (!tile || tile.terrain === effect.terrain) return;
      trackTile(ctx.stepDirty, ctx.state, effect.tile);
      const from = tile.terrain;
      const to = effect.terrain;
      const wasStronghold = isStrongholdTerrain(from);
      if (isFullBreak(to) && tile.soldier) despawnEvent(ctx, effect.tile);
      ctx.state.tiles[effect.tile].terrain = to;
      ctx.chain.push({ level: 5, kind: 'TERRAIN_CHANGE', tile: effect.tile, from, to });
      const soldier = ctx.state.tiles[effect.tile].soldier;
      if (soldier) {
        const conn = TERRAIN_PROPS[to]?.connectivity;
        if (conn === 'FULL_LINK') {
          if (!soldier.isLinked) updateEvent(ctx, effect.tile, { isLinked: true });
          else rejoinEvent(ctx, effect.tile);
        } else if (conn === 'HALF') {
          if (soldier.isLinked) updateEvent(ctx, effect.tile, { isLinked: false });
        } else if (conn === 'NORMAL' && soldier.isLinked) {
          rejoinEvent(ctx, effect.tile);
        }
      }
      if (wasStronghold && !isStrongholdTerrain(to) && soldier && !isNeutralOwner(soldier.owner)) {
        forceClearEvent(ctx, soldier.owner, { checkStronghold: true, reason: 'no_stronghold' });
      }
      return;
    }
    case 'update_force': {
      const seat = resolveForceRef(ctx.state, effect.force);
      if (seat === null) return;
      const f = forceOf(ctx.state, seat);
      if (!f) return;
      trackForce(ctx.stepDirty, ctx.state, seat);
      const p = effect.patch;
      if (p.name !== 'unchanged') f.name = p.name;
      if (p.flag !== 'unchanged') f.flag = p.flag;
      if (p.team !== 'unchanged') f.team = p.team;
      if (p.points !== 'unchanged') f.points = p.points;
      if (p.computer !== 'unchanged') f.computer = p.computer;
      ctx.chain.push({ level: 5, kind: 'FORCE_UPDATE', seat, patch: { ...p } });
      return;
    }
    case 'clear_force': {
      const seat = resolveForceRef(ctx.state, effect.force);
      if (seat === null) return;
      forceClearEvent(ctx, seat, { checkStronghold: false, reason: 'trigger' });
      return;
    }
    case 'transfer_control': {
      // 把玩家当前势力的控制权交给新建的 AI 玩家：玩家势力转为 AI，玩家不再控制任何势力
      const fromSeat = ctx.state.controlledSeat;
      if (fromSeat === null) return;
      const prev = forceOf(ctx.state, fromSeat);
      if (!prev || !prev.exists) return;
      trackForce(ctx.stepDirty, ctx.state, prev.seat);
      prev.isAI = true;
      prev.playerId = null;
      prev.computer = effect.ai_level;
      ctx.state.controlledSeat = null;
      ctx.chain.push({
        level: 5,
        kind: 'CONTROL_CHANGE',
        fromSeat,
        toSeat: null,
        aiLevel: effect.ai_level,
      });
      return;
    }
    case 'set_turn_order':
      ctx.state.turnOrder = [...effect.order];
      ctx.chain.push({ level: 5, kind: 'TURN_ORDER_CHANGE', order: [...effect.order] });
      return;
    case 'set_fog': {
      const cur = ctx.state.fogOverrides ?? { revealed: [], hidden: [] };
      const enabled =
        effect.enabled === 'unchanged'
          ? cur.enabled
          : effect.enabled === 'flipped'
            ? !(cur.enabled ?? false)
            : effect.enabled;
      const next = {
        enabled,
        revealed: mergeTileList(cur.revealed, effect.reveal),
        hidden: mergeTileList(cur.hidden, effect.hide),
      };
      ctx.state.fogOverrides = next;
      ctx.chain.push({
        level: 5,
        kind: 'FOG_CHANGE',
        overrides: { ...next, revealed: [...next.revealed], hidden: [...next.hidden] },
      });
      return;
    }
    case 'show_text':
      ctx.chain.push({
        level: 5,
        kind: 'TRIGGER_TEXT_SHOW',
        textId: effect.text_id,
        text: effect.text,
        placement: effect.placement,
      });
      return;
    case 'hide_text':
      ctx.chain.push({ level: 5, kind: 'TRIGGER_TEXT_HIDE', textId: effect.text_id });
      return;
    case 'end_game': {
      if (ctx.state.finished) return;
      const winners: string[] = [];
      const losers: string[] = [];
      for (const f of ctx.state.forces) {
        if (!f.exists || f.playerId === null) continue;
        if (f.team === effect.winning_team) winners.push(String(f.playerId));
        else losers.push(String(f.playerId));
      }
      ctx.state.finished = true;
      ctx.state.winners = winners;
      ctx.state.winningTeam = effect.winning_team;
      ctx.chain.push({ level: 4, kind: 'VICTORY', winningTeam: effect.winning_team, winners, losers });
      ctx.consensus.push({
        payload: { kind: 'VICTORY', winningTeam: effect.winning_team, winners, losers },
        nodeSeat: 0,
      });
      return;
    }
    case 'insert_move_intent':
    case 'insert_attack_intent':
    case 'insert_add_point_intent': {
      const delta = runInsertedIntent(ctx, effect);
      if (delta) ctx.intentDeltas.push(delta);
      return;
    }
  }
}

function makeTriggerExecutor(ctx: Ctx): TriggerExecutor {
  return {
    execute(trigger) {
      const before = ctx.state;
      resetStepDirty(ctx.stepDirty);
      ctx.intentDeltas = [];
      for (const effect of trigger.effects) applyTriggerEffect(ctx, effect);
      return takeDelta(ctx.stepDirty, ctx.state, before);
    },
    takeIntentDeltas() {
      const out = ctx.intentDeltas;
      ctx.intentDeltas = [];
      return out;
    },
  };
}

/** 成功意图的收尾：triggerMode 下跑触发器事务，再返回 ok */
function finishIntent(ctx: Ctx, beforeState: GameState, actor: Actor): ApplyResult {
  const s = ctx.state;
  if (s.triggerMode && s.triggerRuntime) {
    const intentDelta = takeDelta(ctx.stepDirty, s, beforeState);
    runTriggerTransaction({
      state: s,
      chain: ctx.chain,
      intentDelta,
      human: actor.kind === 'PLAYER',
      transitionCursor: { turn: beforeState.turn, seat: beforeState.currentSeat, phase: beforeState.phase },
      executor: makeTriggerExecutor(ctx),
    });
    // 触发器可能已完成控制转移或改写队伍：事务末尾统一判定胜负
    victoryJudgeEvent(ctx);
  }
  return ok(ctx);
}

// ---------- 意图入口（P5 契约 §11.2） ----------

export function applyIntent(state: GameState, envelope: IntentEnvelope): ApplyResult {
  if (state.finished) return { ok: false, state, reason: 'NO_GAME' };
  const ctx: Ctx = {
    state: cloneState(state),
    geo: { rows: state.rows, columns: state.columns, cylindrical: state.cylindrical },
    chain: [],
    consensus: [],
    stepDirty: createStepDirty(state.triggerMode),
    triggers: state.triggers,
    intentDeltas: [],
  };
  const { actor, intent } = envelope;
  const s = ctx.state;
  const inBounds = (i: number) => i >= 0 && i < s.tiles.length;
  const actorIsCurrent =
    (actor.kind === 'PLAYER' || actor.kind === 'AI') && actor.seat === s.currentSeat;

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
        return executed ? finishIntent(ctx, state, actor) : reject(state, 'ILLEGAL_ATTACK');
      }
      if (target && sameTeam(s, origin.owner, target.owner)) return reject(state, illegal);
      if (!target && isAttack) return reject(state, illegal);
      if (hexDistance(intent.from, intent.to, ctx.geo) > maxDist) return reject(state, illegal);
      const executed = isAttack ? attackEventCore(ctx, intent.from, intent.to) : moveEventCore(ctx, intent.from, intent.to);
      return executed ? finishIntent(ctx, state, actor) : reject(state, illegal);
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
      if (!state.demo?.infinitePoints && force.points < intent.amount) return reject(state, 'NO_POINTS');
      ctx.chain.push({ level: 1, kind: 'ADD_POINT', seat: s.currentSeat, coordinate: intent.coordinate, amount: intent.amount });
      updateEvent(ctx, intent.coordinate, { strength: target.strength + intent.amount });
      trackForce(ctx.stepDirty, ctx.state, s.currentSeat);
      if (!state.demo?.infinitePoints) force.points -= intent.amount;
      // 点数耗尽后是否结束回合由前端/AI 驱动以显式 SWITCH_PHASE 发起（reducer 不自动切阶段）
      return finishIntent(ctx, state, actor);
    }
    case 'SWITCH_PHASE': {
      if (!actorIsCurrent) return reject(state, 'NOT_YOUR_TURN');
      if (s.phase !== 'ACTION' && s.phase !== 'ADD_POINT') return reject(state, 'WRONG_PHASE');
      switchPhaseEventCore(ctx);
      return finishIntent(ctx, state, actor);
    }
    case 'SURRENDER': {
      const force = forceOf(s, intent.seat);
      if (!force || !force.exists) return reject(state, 'SEAT_CLEARED');
      if (!force.alive) return reject(state, 'SEAT_CLEARED');
      const reason = intent.reason ?? 'voluntary';
      if (actor.kind === 'AI') return reject(state, 'NOT_YOUR_TURN'); // AI 不主动投降
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
      return finishIntent(ctx, state, actor);
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
  const hasTriggers = (map.triggers?.length ?? 0) > 0;
  const triggerMode = input.triggerMode === true && hasTriggers;
  const initialHuman = seatAssignments.find((a) => a.playerId !== null) ?? null;
  const controlledSeat = triggerMode ? (input.controlledSeat ?? initialHuman?.seat ?? null) : null;
  const humanPlayerId = triggerMode ? (input.humanPlayerId ?? initialHuman?.playerId ?? null) : null;
  const state: GameState = {
    rows: map.row,
    columns: map.column,
    cylindrical: map.cylindrical_map,
    seed: input.seed,
    turn: 1,
    currentSeat: 0,
    phase: 'PREPARE',
    forces,
    tiles,
    timeSettings: { ...timeSettings },
    finished: false,
    winners: null,
    winningTeam: null,
    triggerMode,
    triggerRuntime: triggerMode
      ? {
          schemaVersion: 2,
          firedCounts: {},
          stateWatch: {},
          pending: [],
          intentSeq: 0,
          turnSeq: 0,
          nextSerial: 1,
          transactionSeq: 0,
        }
      : null,
    controlledSeat,
    humanPlayerId,
    turnOrder: [],
    fogOverrides: null,
    triggers: map.triggers ? [...map.triggers] : [],
    demo: input.demo,
  };
  const ctx: Ctx = {
    state,
    geo: { rows: map.row, columns: map.column, cylindrical: map.cylindrical_map },
    chain: [],
    consensus: [],
    stepDirty: createStepDirty(triggerMode),
    triggers: state.triggers,
    intentDeltas: [],
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

  // 行动顺序：默认按 seat 升序（战役触发器可重排）；普通对局与既有行为一致
  state.turnOrder = forces.filter((f) => f.exists).map((f) => f.seat).sort((a, b) => a - b);

  // 回合起点：行动顺序首个存在势力；无任何存在势力 → 直接终局（空局）
  const startSeat = state.turnOrder[0];
  if (startSeat === undefined) {
    state.finished = true;
    state.winners = [];
    state.winningTeam = -1;
    return { state, chain: ctx.chain };
  }
  state.currentSeat = startSeat;
  runPreparePhaseContent(ctx);
  if (state.triggerMode && state.triggerRuntime && state.triggers.length > 0 && !state.finished) {
    runTriggerTransaction({
      state,
      chain: ctx.chain,
      intentDelta: { before: state, after: state, tiles: [], forces: [] },
      human: false,
      init: true,
      transitionCursor: { turn: 1, seat: startSeat, phase: 'PREPARE' },
      executor: makeTriggerExecutor(ctx),
    });
    victoryJudgeEvent(ctx);
  }
  return { state, chain: ctx.chain };
}
