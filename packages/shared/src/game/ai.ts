// AI 策略层（A 延伸路线 → 意图入流）：难度1 真实回合决策，AI 意图与玩家同构进入意图流。
// 决策由提交方客户端调用 planAiTurn 生成（reducer 不内建调用、不自动完成 AI 回合），
// 意图经 AI_INTENT_SUBMIT 提交、服务器广播、各端 reducer 以玩家同一路径应用，随日志持久化；
// 回放直接应用记录意图，无需运行 AI。难度 2/3/255 保持跳过语义（kind:'skip'，驱动侧展开为 SWITCH_PHASE）。
// 本文件在确定性 lint 作用域内：策略实现必须保持纯函数（零 Math.random、整数运算、全序排序），
// 随机性由服务器下发的 seed 派生（种子化 PRNG，同 seed 同局面 → 同决策）。
import type { GameState, ForceState, Phase, SoldierState } from './types.js';
import type { PlayerIntent } from '../protocol.js';
import { TERRAIN } from '../types.js';
import { TERRAIN_PROPS, isFullBreak, isStrongholdTerrain, isNeutralOwner } from './constants.js';
import type { BoardGeometry } from './coord.js';
import { neighborsOf, areAdjacent } from './coord.js';
import { hexDistance } from './distance.js';
import { fnv1a } from './hash.js';
import { applyIntent } from './reducer.js';

/** AI 难度（与 AI_LEVEL / 地图 player_list[].computer 对齐） */
export type AiLevel = 1 | 2 | 3 | 255;

/** 单个兵位的战场信息（AI 决策用只读数据） */
export interface AiTileInfo {
  tile: number;
  terrain: number;
  strength: number;
  isLinked: boolean;
  hasMovement: boolean;
  /** 剩余反击次数（据点为 COUNTER_INFINITE） */
  counter: number;
  isStronghold: boolean;
}

/** 单个势力的战场摘要 */
export interface AiForceInfo {
  seat: number;
  team: number;
  name: string;
  computer: AiLevel;
  isAI: boolean;
  alive: boolean;
  points: number;
  strongholdCount: number;
  linkedCount: number;
  totalStrength: number;
  /** 该势力全部兵（线性 index 升序） */
  soldiers: AiTileInfo[];
}

/** AI 战场信息视图：难度策略的输入。纯函数构建，内容为该势力视角的全部可见信息 */
export interface AiBattlefieldView {
  seat: number;
  computer: AiLevel;
  turn: number;
  phase: Phase;
  currentSeat: number;
  rows: number;
  columns: number;
  cylindrical: boolean;
  me: AiForceInfo;
  /** 其他存在势力（seat 升序） */
  others: AiForceInfo[];
  /** 中立兵（野生/阻挡，index 升序） */
  neutralSoldiers: AiTileInfo[];
}

function tileInfo(state: GameState, index: number, soldier: SoldierState): AiTileInfo {
  return {
    tile: index,
    terrain: state.tiles[index].terrain,
    strength: soldier.strength,
    isLinked: soldier.isLinked,
    hasMovement: soldier.hasMovement,
    counter: soldier.counter,
    isStronghold: isStrongholdTerrain(state.tiles[index].terrain),
  };
}

/** 队伍判定（与 reducer 同语义）：中立兵不与任何势力同队 */
function sameTeam(state: GameState, a: number, b: number): boolean {
  if (isNeutralOwner(a) || isNeutralOwner(b)) return false;
  const fa = state.forces.find((f) => f.seat === a);
  const fb = state.forces.find((f) => f.seat === b);
  return !!fa && !!fb && fa.team === fb.team;
}

/**
 * 构建 AI 战场信息视图（获取战场信息的方法，纯函数）。
 * seat 不存在时返回 null；me/others 只含 exists 势力。
 */
export function buildAiView(state: GameState, seat: number): AiBattlefieldView | null {
  const me = state.forces.find((f) => f.seat === seat);
  if (!me || !me.exists) return null;

  const forceInfo = (f: ForceState): AiForceInfo => {
    const soldiers: AiTileInfo[] = [];
    let strongholdCount = 0;
    let linkedCount = 0;
    let totalStrength = 0;
    for (let i = 0; i < state.tiles.length; i++) {
      const s = state.tiles[i].soldier;
      if (!s || s.owner !== f.seat) continue;
      soldiers.push(tileInfo(state, i, s));
      totalStrength += s.strength;
      if (s.isLinked) linkedCount += 1;
      if (isStrongholdTerrain(state.tiles[i].terrain)) strongholdCount += 1;
    }
    return {
      seat: f.seat,
      team: f.team,
      name: f.name,
      computer: f.computer as AiLevel,
      isAI: f.isAI,
      alive: f.alive,
      points: f.points,
      strongholdCount,
      linkedCount,
      totalStrength,
      soldiers,
    };
  };

  const others: AiForceInfo[] = [];
  for (const f of state.forces) {
    if (!f.exists || f.seat === seat) continue;
    others.push(forceInfo(f));
  }
  const neutralSoldiers: AiTileInfo[] = [];
  for (let i = 0; i < state.tiles.length; i++) {
    const s = state.tiles[i].soldier;
    if (s && isNeutralOwner(s.owner)) neutralSoldiers.push(tileInfo(state, i, s));
  }
  return {
    seat,
    computer: me.computer as AiLevel,
    turn: state.turn,
    phase: state.phase,
    currentSeat: state.currentSeat,
    rows: state.rows,
    columns: state.columns,
    cylindrical: state.cylindrical,
    me: forceInfo(me),
    others,
    neutralSoldiers,
  };
}

/** 合法行动选项（MOVE 仅列空目标；ATTACK 仅列非同队目标；与 reducer 前置判定一致） */
export interface AiActionOption {
  kind: 'MOVE' | 'ATTACK';
  from: number;
  to: number;
}

/** 枚举 seat 当前可执行的合法行动（只读，不修改状态；非其回合/非行动阶段返回空） */
export function listAiActions(state: GameState, seat: number): AiActionOption[] {
  const options: AiActionOption[] = [];
  if (state.finished || state.currentSeat !== seat || state.phase !== 'ACTION') return options;
  const geo: BoardGeometry = { rows: state.rows, columns: state.columns, cylindrical: state.cylindrical };
  for (let from = 0; from < state.tiles.length; from++) {
    const s = state.tiles[from].soldier;
    if (!s || s.owner !== seat || !s.hasMovement) continue;
    if (s.isLinked && s.strength === 1) continue;
    for (const to of neighborsOf(from, geo)) {
      if (isFullBreak(state.tiles[to].terrain)) continue;
      const maxDist = TERRAIN_PROPS[state.tiles[to].terrain]?.moveDistance ?? 0;
      if (hexDistance(from, to, geo) > maxDist) continue;
      const target = state.tiles[to].soldier;
      if (!target) options.push({ kind: 'MOVE', from, to });
      else if (!sameTeam(state, s.owner, target.owner)) options.push({ kind: 'ATTACK', from, to });
    }
  }
  return options;
}

/** AI 回合决策结果：难度1 返回 intents（提交入流）；难度 2/3/255 返回 skip（驱动侧展开为 SWITCH_PHASE） */
export type AiTurnPlan = { kind: 'skip' } | { kind: 'intents'; intents: PlayerIntent[] };

// ---------- 种子化确定性 PRNG（P7：零 Math.random，随机源来自服务器 seed） ----------

/** xorshift32（整数递推）；初值 = FNV-1a(seed)，非零兜底 */
function createRng(seed: string): () => number {
  let x = parseInt(fnv1a(seed), 16) >>> 0;
  if (x === 0) x = 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

// ---------- 难度1（普通难度）：状态Ⅰ / 状态Ⅱ ----------

const geoOf = (state: GameState): BoardGeometry => ({
  rows: state.rows,
  columns: state.columns,
  cylindrical: state.cylindrical,
});

/** 进攻力：连兵 = 兵力 − 1；断兵 = 兵力 */
function powerOf(s: SoldierState): number {
  return s.isLinked ? s.strength - 1 : s.strength;
}

/** 可动兵池（hasMovement 且非"兵力1连兵"，与 reducer 可动判定一致） */
function movablePool(state: GameState, seat: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < state.tiles.length; i++) {
    const s = state.tiles[i].soldier;
    if (!s || s.owner !== seat || !s.hasMovement) continue;
    if (s.isLinked && s.strength === 1) continue;
    out.push(i);
  }
  return out;
}

/** 该兵周围所有敌兵（非同队，含中立） */
function adjacentEnemies(state: GameState, tile: number, seat: number): number[] {
  const out: number[] = [];
  for (const n of neighborsOf(tile, geoOf(state))) {
    const s = state.tiles[n].soldier;
    if (s && !sameTeam(state, seat, s.owner)) out.push(n);
  }
  return out;
}

/** 排序（步骤1）：分层 → 兵力降序 → 坐标升序（含坐标交换例外），生成正序 */
function sortPool(state: GameState, seat: number, pool: number[]): number[] {
  const geo = geoOf(state);
  const tier = (t: number): number => {
    const s = state.tiles[t].soldier!;
    if (s.isLinked) return 0;
    return adjacentEnemies(state, t, seat).length > 0 ? 0 : 1;
  };
  // C 类兵（坐标交换例外）：该势力具有行动力的兵，兵力 > x 且有可移动方向（敌兵占据格也算方向）
  const cClass = (x: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < state.tiles.length; i++) {
      const s = state.tiles[i].soldier;
      if (!s || s.owner !== seat || !s.hasMovement || s.strength <= x) continue;
      let hasDir = false;
      for (const n of neighborsOf(i, geo)) {
        if (isFullBreak(state.tiles[n].terrain)) continue;
        const ns = state.tiles[n].soldier;
        if (!ns || !sameTeam(state, seat, ns.owner)) {
          hasDir = true;
          break;
        }
      }
      if (hasDir) out.push(i);
    }
    return out;
  };
  return [...pool].sort((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    const sa = state.tiles[a].soldier!;
    const sb = state.tiles[b].soldier!;
    if (sa.strength !== sb.strength) return sb.strength - sa.strength;
    const x = sa.strength;
    let invert = false;
    if (pool.filter((t) => state.tiles[t].soldier!.strength === x).length === 2) {
      const cs = cClass(x);
      if (cs.length === 1 && cs[0] > a && cs[0] > b) invert = true;
    }
    return invert ? b - a : a - b;
  });
}

// 步骤2 正攻判定α（正序）：周围存在无反击敌兵 → 进攻其中兵力最大者
function attackAlpha(state: GameState, seat: number, pool: number[]): PlayerIntent | null {
  for (const t of pool) {
    const noCounter = adjacentEnemies(state, t, seat).filter((e) => state.tiles[e].soldier!.counter === 0);
    if (noCounter.length === 0) continue;
    let best = noCounter[0];
    for (const e of noCounter) {
      if (state.tiles[e].soldier!.strength > state.tiles[best].soldier!.strength) best = e;
    }
    return { intentType: 'ATTACK', from: t, to: best };
  }
  return null;
}

// 步骤3 扩张判定（正序）：连兵且周围有空平原 → 随机移动到其中一个
function expand(state: GameState, pool: number[], rng: () => number): PlayerIntent | null {
  const geo = geoOf(state);
  for (const t of pool) {
    const s = state.tiles[t].soldier!;
    if (!s.isLinked) continue;
    const plains: number[] = [];
    for (const n of neighborsOf(t, geo)) {
      if (state.tiles[n].terrain === TERRAIN.PLAIN && state.tiles[n].soldier === null) plains.push(n);
    }
    if (plains.length === 0) continue;
    return { intentType: 'MOVE', from: t, to: plains[rng() % plains.length] };
  }
  return null;
}

// 步骤4 正攻判定β（正序）：存在相邻具反击敌兵兵力 ≤ 我进攻力 → 进攻其中兵力最小者
function attackBeta(state: GameState, seat: number, pool: number[]): PlayerIntent | null {
  for (const t of pool) {
    const myPower = powerOf(state.tiles[t].soldier!);
    const beatable = adjacentEnemies(state, t, seat).filter(
      (e) => state.tiles[e].soldier!.counter > 0 && state.tiles[e].soldier!.strength <= myPower,
    );
    if (beatable.length === 0) continue;
    let best = beatable[0];
    for (const e of beatable) {
      if (state.tiles[e].soldier!.strength < state.tiles[best].soldier!.strength) best = e;
    }
    return { intentType: 'ATTACK', from: t, to: best };
  }
  return null;
}

/** 地形连通图（半断/可接/全接，与兵占据无关）：a、b 是否连通 */
function terrainConnected(state: GameState, a: number, b: number): boolean {
  if (a === b) return true;
  const geo = geoOf(state);
  const visited = new Set<number>([a]);
  const queue: number[] = [a];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const n of neighborsOf(cur, geo)) {
      if (visited.has(n)) continue;
      if (isFullBreak(state.tiles[n].terrain)) continue;
      if (n === b) return true;
      visited.add(n);
      queue.push(n);
    }
  }
  return false;
}

/** 步骤5 目标据点：直线距离最近的敌对据点（连通图上可达；同距取坐标小者） */
function nearestReachableStronghold(state: GameState, from: number, seat: number): number | null {
  const geo = geoOf(state);
  let best: number | null = null;
  let bestDist = 0;
  for (let i = 0; i < state.tiles.length; i++) {
    const s = state.tiles[i].soldier;
    if (!s || !isStrongholdTerrain(state.tiles[i].terrain)) continue;
    if (sameTeam(state, seat, s.owner)) continue;
    if (!terrainConnected(state, from, i)) continue;
    const d = hexDistance(from, i, geo);
    if (best === null || d < bestDist || (d === bestDist && i < best)) {
      best = i;
      bestDist = d;
    }
  }
  return best;
}

/** 步骤5 A*：排除全断与友兵格，不排除敌兵格；返回第一步 */
function astarFirstStep(state: GameState, from: number, to: number, seat: number): number | null {
  const geo = geoOf(state);
  const passable = (t: number): boolean => {
    if (isFullBreak(state.tiles[t].terrain)) return false;
    const s = state.tiles[t].soldier;
    return !(s && sameTeam(state, seat, s.owner));
  };
  const g = new Map<number, number>([[from, 0]]);
  const prev = new Map<number, number>();
  const open: number[] = [from];
  const closed = new Set<number>();
  while (open.length > 0) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) {
      const a = open[bi];
      const b = open[i];
      const fa = (g.get(a) ?? 0) + hexDistance(a, to, geo);
      const fb = (g.get(b) ?? 0) + hexDistance(b, to, geo);
      if (fb < fa || (fb === fa && b < a)) bi = i;
    }
    const cur = open.splice(bi, 1)[0];
    if (cur === to) {
      let node = to;
      while (prev.get(node) !== from) {
        const p = prev.get(node);
        if (p === undefined) return null;
        node = p;
      }
      return node;
    }
    if (closed.has(cur)) continue;
    closed.add(cur);
    for (const n of neighborsOf(cur, geo)) {
      if (!passable(n) || closed.has(n)) continue;
      const ng = (g.get(cur) ?? 0) + 1;
      if (!g.has(n) || ng < (g.get(n) ?? Number.MAX_SAFE_INTEGER)) {
        g.set(n, ng);
        prev.set(n, cur);
        open.push(n);
      }
    }
  }
  return null;
}

// 步骤5 移动判定（正序）：断兵且可到达最近敌对据点 → 沿 A* 路径移动一格
function march(state: GameState, seat: number, pool: number[]): PlayerIntent | null {
  for (const t of pool) {
    const s = state.tiles[t].soldier!;
    if (s.isLinked) continue;
    const target = nearestReachableStronghold(state, t, seat);
    if (target === null) continue;
    const first = astarFirstStep(state, t, target, seat);
    if (first === null) continue;
    return { intentType: 'MOVE', from: t, to: first };
  }
  return null;
}

// 步骤6 夹击判定（逆序）：判据1~3 + 存在友兵-敌兵对（y 进攻力 + 我进攻力 > 该对敌兵兵力）
function flank(state: GameState, seat: number, pool: number[]): PlayerIntent | null {
  const geo = geoOf(state);
  for (const t of pool) {
    const s = state.tiles[t].soldier!;
    const enemies = adjacentEnemies(state, t, seat);
    if (enemies.length === 0) continue;
    const hasCounter = enemies.some((e) => state.tiles[e].soldier!.counter > 0);
    const hasNoCounter = enemies.some((e) => state.tiles[e].soldier!.counter === 0);
    if (!hasCounter || hasNoCounter) continue;
    let minStr = Number.MAX_SAFE_INTEGER;
    for (const e of enemies) {
      if (state.tiles[e].soldier!.strength < minStr) minStr = state.tiles[e].soldier!.strength;
    }
    if (powerOf(s) >= minStr) continue;
    if (isStrongholdTerrain(state.tiles[t].terrain)) continue;
    let bestZ: number | null = null;
    let bestZStrength = -1;
    for (const z of enemies) {
      const zStrength = state.tiles[z].soldier!.strength;
      if (zStrength <= bestZStrength) continue;
      let ok = false;
      for (const y of neighborsOf(t, geo)) {
        if (y === z) continue;
        const ys = state.tiles[y].soldier;
        if (!ys) continue;
        if (ys.owner === seat) {
          if (!ys.hasMovement) continue; // 同势力友兵须有行动力
        } else if (!sameTeam(state, seat, ys.owner)) {
          continue; // 非同队不是友兵
        }
        if (!areAdjacent(y, z, geo)) continue;
        if (powerOf(ys) + powerOf(s) > zStrength) {
          ok = true;
          break;
        }
      }
      if (ok) {
        bestZ = z;
        bestZStrength = zStrength;
      }
    }
    if (bestZ !== null) return { intentType: 'ATTACK', from: t, to: bestZ };
  }
  return null;
}

// 步骤7 敢死判定（逆序）：判据1~3 + 存在被围死的同队友兵 → 进攻周围兵力最大的敌兵（自杀牺牲）
function desperate(state: GameState, seat: number, pool: number[]): PlayerIntent | null {
  const geo = geoOf(state);
  for (const t of pool) {
    const s = state.tiles[t].soldier!;
    const enemies = adjacentEnemies(state, t, seat);
    if (enemies.length === 0) continue;
    const hasCounter = enemies.some((e) => state.tiles[e].soldier!.counter > 0);
    const hasNoCounter = enemies.some((e) => state.tiles[e].soldier!.counter === 0);
    if (!hasCounter || hasNoCounter) continue;
    let minStr = Number.MAX_SAFE_INTEGER;
    for (const e of enemies) {
      if (state.tiles[e].soldier!.strength < minStr) minStr = state.tiles[e].soldier!.strength;
    }
    if (powerOf(s) >= minStr) continue;
    if (isStrongholdTerrain(state.tiles[t].terrain)) continue;
    if (!hasDesperateComrade(state, seat, enemies, geo)) continue;
    let best = enemies[0];
    for (const e of enemies) {
      if (state.tiles[e].soldier!.strength > state.tiles[best].soldier!.strength) best = e;
    }
    return { intentType: 'ATTACK', from: t, to: best };
  }
  return null;
}

/** 步骤7 判据4：存在同队友兵被围死（6 邻全为同队兵或不可通行）、进攻力 ≥ 2、不在任一周围敌兵邻格 */
function hasDesperateComrade(state: GameState, seat: number, enemies: number[], geo: BoardGeometry): boolean {
  for (let i = 0; i < state.tiles.length; i++) {
    const ys = state.tiles[i].soldier;
    if (!ys || !sameTeam(state, seat, ys.owner)) continue;
    if (powerOf(ys) < 2) continue;
    let hasDir = false;
    for (const n of neighborsOf(i, geo)) {
      if (isFullBreak(state.tiles[n].terrain)) continue;
      const ns = state.tiles[n].soldier;
      if (!ns || !sameTeam(state, seat, ns.owner)) {
        hasDir = true;
        break;
      }
    }
    if (hasDir) continue;
    let near = false;
    for (const e of enemies) {
      if (areAdjacent(i, e, geo)) {
        near = true;
        break;
      }
    }
    if (near) continue;
    return true;
  }
  return false;
}

/** 一轮行动判定：依次执行步骤2~7（正序/逆序），命中即返回对应意图；全部不命中返回 null */
function decideAction(state: GameState, seat: number, rng: () => number): PlayerIntent | null {
  const pool = sortPool(state, seat, movablePool(state, seat));
  if (pool.length === 0) return null;
  const reverse = [...pool].reverse();
  const a1 = attackAlpha(state, seat, pool);
  if (a1) return a1;
  const ex = expand(state, pool, rng);
  if (ex) return ex;
  const a2 = attackBeta(state, seat, pool);
  if (a2) return a2;
  const mv = march(state, seat, pool);
  if (mv) return mv;
  const fl = flank(state, seat, reverse);
  if (fl) return fl;
  const ds = desperate(state, seat, reverse);
  if (ds) return ds;
  return null;
}

// ---------- 状态Ⅱ：加点阶段 ----------

/** 周围所有敌兵的进攻力之和 */
function sumEnemyPower(state: GameState, tile: number, seat: number): number {
  let sum = 0;
  for (const n of neighborsOf(tile, geoOf(state))) {
    const s = state.tiles[n].soldier;
    if (s && !sameTeam(state, seat, s.owner)) sum += powerOf(s);
  }
  return sum;
}

/** 周围敌兵中兵力的最大值 */
function maxEnemyStrength(state: GameState, tile: number, seat: number): number {
  let max = 0;
  for (const n of neighborsOf(tile, geoOf(state))) {
    const s = state.tiles[n].soldier;
    if (s && !sameTeam(state, seat, s.owner) && s.strength > max) max = s.strength;
  }
  return max;
}

/**
 * 状态Ⅱ 加点意图序列：四分类（只统计连兵）依次补防守压力/进攻阈值，剩余随机分配给沿海类。
 * 各类 D_k / A_k 超过当前点数时逐点随机全分并结束回合；点数归零由 reducer 自动切阶段，
 * 因此本序列总和恰为可用点数时无需额外 SWITCH_PHASE（剩余无法分配时才追加）。
 */
function planAddPoints(state: GameState, seat: number, rng: () => number): PlayerIntent[] {
  const intents: PlayerIntent[] = [];
  const force = state.forces.find((f) => f.seat === seat);
  const points = force?.points ?? 0;
  if (points <= 0) return [{ intentType: 'SWITCH_PHASE' }];
  const geo = geoOf(state);
  // 四分类：0 沿海据点 / 1 内陆据点 / 2 沿海平原 / 3 内陆平原
  const cats: number[][] = [[], [], [], []];
  for (let i = 0; i < state.tiles.length; i++) {
    const s = state.tiles[i].soldier;
    if (!s || s.owner !== seat || !s.isLinked) continue;
    const terrain = state.tiles[i].terrain;
    const coastal = neighborsOf(i, geo).some((n) => state.tiles[n].terrain === TERRAIN.OCEAN);
    if (isStrongholdTerrain(terrain)) cats[coastal ? 0 : 1].push(i);
    else if (terrain === TERRAIN.PLAIN) cats[coastal ? 2 : 3].push(i);
  }
  const d = (t: number): number =>
    Math.max(0, sumEnemyPower(state, t, seat) - state.tiles[t].soldier!.strength + 1);
  const a = (t: number): number =>
    Math.max(0, maxEnemyStrength(state, t, seat) - powerOf(state.tiles[t].soldier!) + 1);

  /** 逐点随机把 amount 点分配给 cat 内兵（坐标升序生成 ADD_POINT），返回实际分配量 */
  const randomDistribute = (cat: number[], amount: number): number => {
    if (cat.length === 0) return 0;
    const counts = new Map<number, number>();
    for (let i = 0; i < amount; i++) {
      const t = cat[rng() % cat.length];
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    const keys = [...cat].sort((x, y) => x - y);
    for (const t of keys) {
      const amt = counts.get(t) ?? 0;
      if (amt > 0) intents.push({ intentType: 'ADD_POINT', coordinate: t, amount: amt });
    }
    return amount;
  };

  let P = points;
  // 步骤A：防守压力
  for (const cat of cats) {
    if (P <= 0) break;
    const D = cat.reduce((sum, t) => sum + d(t), 0);
    if (D <= P) {
      for (const t of cat) {
        const amt = d(t);
        if (amt > 0) {
          intents.push({ intentType: 'ADD_POINT', coordinate: t, amount: amt });
          P -= amt;
        }
      }
    } else {
      randomDistribute(cat, P);
      return intents;
    }
  }
  // 步骤B：进攻阈值（兵力已变，重新计算）
  for (const cat of cats) {
    if (P <= 0) break;
    const A = cat.reduce((sum, t) => sum + a(t), 0);
    if (A <= P) {
      for (const t of cat) {
        const amt = a(t);
        if (amt > 0) {
          intents.push({ intentType: 'ADD_POINT', coordinate: t, amount: amt });
          P -= amt;
        }
      }
    } else {
      randomDistribute(cat, P);
      return intents;
    }
  }
  // 步骤C：剩余随机分配给沿海据点或沿海平原（无先后）
  if (P > 0) {
    const chosen = [cats[0], cats[2]][rng() % 2];
    P -= randomDistribute(chosen, P);
    if (P > 0) intents.push({ intentType: 'SWITCH_PHASE' }); // 所选类无可加点连兵：保留点数结束回合
  }
  return intents;
}

/** 行动阶段模拟轮数上限（防御极端棋盘死循环） */
const ACTION_LOOP_LIMIT = 500;

/**
 * 难度1 回合计划：以克隆状态 + applyIntent 模拟整回合（每次行动后基于最新模拟状态重判），
 * 返回完整意图序列（行动阶段 MOVE/ATTACK/SWITCH_PHASE + 加点阶段 ADD_POINT/SWITCH_PHASE）。
 */
function planDifficultyOne(state: GameState, seat: number, rng: () => number): PlayerIntent[] {
  const intents: PlayerIntent[] = [];
  let sim = state;
  const push = (intent: PlayerIntent): boolean => {
    const r = applyIntent(sim, { actor: { kind: 'PLAYER', seat }, intent });
    if (!r.ok) return false;
    sim = r.state;
    intents.push(intent);
    return true;
  };
  // 行动阶段（状态Ⅰ）
  if (sim.currentSeat === seat && sim.phase === 'ACTION') {
    let guard = 0;
    while (sim.currentSeat === seat && sim.phase === 'ACTION' && guard++ < ACTION_LOOP_LIMIT) {
      const action = decideAction(sim, seat, rng);
      if (action === null) {
        push({ intentType: 'SWITCH_PHASE' });
        break;
      }
      if (!push(action)) break;
    }
  }
  // 加点阶段（状态Ⅱ）
  if (sim.currentSeat === seat && sim.phase === 'ADD_POINT') {
    for (const intent of planAddPoints(sim, seat, rng)) {
      if (sim.currentSeat !== seat || sim.phase !== 'ADD_POINT') break;
      if (!push(intent)) break;
    }
  }
  return intents;
}

/**
 * AI 回合决策入口（提交方客户端调用；reducer 不内建调用）。
 * 难度1（普通难度）返回 intents（意图入流）；难度 2/3/255 返回 skip（保持休闲语义）。
 */
export function planAiTurn(state: GameState, seat: number): AiTurnPlan {
  const force = state.forces.find((f) => f.seat === seat);
  if (!force || !force.exists || !force.alive) return { kind: 'skip' };
  if (force.computer !== 1) return { kind: 'skip' };
  const rng = createRng(state.seed);
  return { kind: 'intents', intents: planDifficultyOne(state, seat, rng) };
}
