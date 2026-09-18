// MCTS 核心（纯 MCTS，无神经网络；m/n 共用骨架）
// 节点 = 状态；边 = 合法意图（逐意图粒度）；选择：UCT（C 可调，种子化平局打破）
// 模拟：规则 AI（planAiTurn）对双方 rollout rolloutRounds 轮，途中终局/截断即停
// 叶评估：L = tanh(log(A²/(B·(B+O)))) + c·S_me（A=我方总兵力，B=对手总兵力，O=对手连兵数，S_me=我方据点）
// 终端：  R = outcome + (1 − 2p̂)（p̂ = b 先手 / 1−b 后手）
// 截断：  R = −0.9（回合上限，平坦）
// 值视角：negamax（节点值 = 该节点行动玩家视角；子节点换手取反）
import { applyIntent, listAiActions, planAiTurn, neighborsOf, isFullBreak } from '@dl/shared';
import type { GameState, PlayerIntent } from '@dl/shared';
import { createRng } from './rng.js';
import { withSeed } from './game.js';

export interface MctsConfig {
  /** 每步搜索模拟数 */
  simsPerMove: number;
  /** UCT 探索常数 C */
  explorationC: number;
  /** 叶评估据点项系数 c */
  cStronghold: number;
  /** 叶评估伤害差分项系数 d（2026-09-17 用户修正） */
  damageCoeff: number;
  /** 叶评估死胡同连兵惩罚系数 q（2026-09-17：加点投到无方向连兵的浪费惩罚，与兵力成正比） */
  stuckPenalty: number;
  /** 终端奖励倍率（2026-09-17 用户修正：扩大 5 倍促转化） */
  terminalScale: number;
  /** rollout 轮数（双方各一次为一轮） */
  rolloutRounds: number;
  /** 回合上限（全局轮次；0=不限） */
  turnCap: number;
  /** 地图先手胜率基线 b（seat1=先手视角） */
  b: number;
}

/** 截断 ≈ 近败（随终端倍率缩放，保持"截断≈失败"语义） */
function truncationValue(cfg: MctsConfig): number {
  return -0.9 * cfg.terminalScale;
}

function legalActions(state: GameState): PlayerIntent[] {
  if (state.finished) return [];
  const seat = state.currentSeat;
  const out: PlayerIntent[] = [];
  if (state.phase === 'ACTION') {
    for (const a of listAiActions(state, seat)) out.push({ intentType: a.kind, from: a.from, to: a.to });
    out.push({ intentType: 'SWITCH_PHASE' });
    return out;
  }
  if (state.phase === 'ADD_POINT') {
    const force = state.forces.find((f) => f.seat === seat);
    if (force && force.points > 0) {
      for (let i = 0; i < state.tiles.length; i++) {
        const s = state.tiles[i].soldier;
        if (s && s.owner === seat && s.isLinked) out.push({ intentType: 'ADD_POINT', coordinate: i, amount: 1 });
      }
    }
    out.push({ intentType: 'SWITCH_PHASE' });
    return out;
  }
  return [{ intentType: 'SWITCH_PHASE' }];
}

/** 终端值（seat 视角；×terminalScale 放大，促转化） */
function evalTerminal(state: GameState, seat: number, cfg: MctsConfig): number {
  const force = state.forces.find((f) => f.seat === seat);
  const won = !!force && state.winningTeam !== null && force.team === state.winningTeam;
  const outcome = won ? 1 : -1;
  const prior = seat === 1 ? cfg.b : 1 - cfg.b;
  return cfg.terminalScale * (outcome + (1 - 2 * prior));
}

/** 叶评估（seat 视角；A/B/O/S_me 取模拟终点局面；伤害差分项取 rollout 窗口净变化；死胡同惩罚与兵力成正比） */
function leafValue(state: GameState, seat: number, cfg: MctsConfig, startM: number, startE: number): number {
  const opp = 3 - seat; // 1v1：seat ∈ {1,2}
  let A = 0;
  let B = 0;
  let O = 0;
  let S = 0;
  for (const t of state.tiles) {
    const s = t.soldier;
    if (!s) continue;
    if (s.owner === seat) {
      A += s.strength;
      if (t.terrain === 1) S++;
    } else if (s.owner === opp) {
      B += s.strength;
      if (s.isLinked) O++;
    }
  }
  const ratio = (A * A) / (B * (B + O)); // 防御：B=0 → 极大 → tanh→1
  let v = Math.tanh(Math.log(ratio)) + cfg.cStronghold * S;
  // 伤害差分项：(Δ敌 − Δ我 + 0.5)·Δ敌·d
  // Δ敌 = max(0, 开局敌总兵力 − 终点敌总兵力)；Δ我 = 开局我总兵力 − 终点我总兵力（净变化，加点净增为负）
  // 敌方无减少 → 项为 0；我方净损大于敌方 → 项为负；反击次数 1 → 多步围攻（先手吃反击、后续无反击）显正
  const dmgE = Math.max(0, startE - B);
  const dmgM = startM - A;
  if (dmgE > 0) v += (dmgE - dmgM + 0.5) * dmgE * cfg.damageCoeff;
  // 死胡同连兵惩罚：−q·Σ(我方死胡同连兵兵力)，抑制把点数投给无方向兵（2026-09-17 用户修正）
  const stuck = stuckLinkedStrength(state, seat);
  if (stuck > 0) v -= cfg.stuckPenalty * stuck;
  return v;
}

/** 节点直评（终局/截断/叶子；无窗口时伤害项为 0） */
function evaluateNode(state: GameState, seat: number, cfg: MctsConfig, startM?: number, startE?: number): number {
  if (state.finished) return evalTerminal(state, seat, cfg);
  if (cfg.turnCap > 0 && state.turn > cfg.turnCap) return truncationValue(cfg);
  const sm = startM ?? totalStrength(state, seat);
  const se = startE ?? totalStrength(state, 3 - seat);
  return leafValue(state, seat, cfg, sm, se);
}

/** 某势力总兵力 */
function totalStrength(state: GameState, owner: number): number {
  let sum = 0;
  for (const t of state.tiles) {
    const s = t.soldier;
    if (s && s.owner === owner) sum += s.strength;
  }
  return sum;
}

/** 死胡同连兵总兵力：连兵周围全部为友兵或全断地形（无任何可走/可攻方向），加点投给这类兵视为浪费 */
function stuckLinkedStrength(state: GameState, seat: number): number {
  const geo = { rows: state.rows, columns: state.columns, cylindrical: state.cylindrical };
  let sum = 0;
  for (let i = 0; i < state.tiles.length; i++) {
    const s = state.tiles[i].soldier;
    if (!s || s.owner !== seat || !s.isLinked) continue;
    let hasDirection = false;
    for (const n of neighborsOf(i, geo)) {
      if (isFullBreak(state.tiles[n].terrain)) continue; // 全断 → 非方向
      const other = state.tiles[n].soldier;
      if (!other || other.owner !== seat) {
        hasDirection = true; // 空可走格或敌兵（1v1：非同势力即敌）→ 有方向
        break;
      }
    }
    if (!hasDirection) sum += s.strength;
  }
  return sum;
}

/** rollout：规则 AI 对双方模拟；返回 seat 视角价值 */
function rollout(state: GameState, seat: number, cfg: MctsConfig, aiSeed: string): number {
  let sim = state;
  const startM = totalStrength(state, seat);
  const startE = totalStrength(state, 3 - seat);
  for (let t = 0; t < cfg.rolloutRounds * 2; t++) {
    if (sim.finished) return evalTerminal(sim, seat, cfg);
    if (cfg.turnCap > 0 && sim.turn > cfg.turnCap) return truncationValue(cfg);
    const s = sim.currentSeat;
    const plan = planAiTurn(withSeed(sim, `${aiSeed}:r:${t}`), s);
    const intents: PlayerIntent[] =
      plan.kind === 'intents'
        ? plan.intents
        : sim.phase === 'ACTION'
          ? [{ intentType: 'SWITCH_PHASE' }, { intentType: 'SWITCH_PHASE' }]
          : [{ intentType: 'SWITCH_PHASE' }];
    if (intents.length === 0) {
      const r = applyIntent(sim, { actor: { kind: 'PLAYER', seat: s }, intent: { intentType: 'SWITCH_PHASE' } });
      sim = r.ok ? r.state : sim;
      continue;
    }
    for (const intent of intents) {
      const r = applyIntent(sim, { actor: { kind: 'PLAYER', seat: s }, intent });
      if (r.ok) sim = r.state;
      if (sim.finished) break;
      if (cfg.turnCap > 0 && sim.turn > cfg.turnCap) break;
    }
  }
  return evaluateNode(sim, seat, cfg, startM, startE);
}

interface ChildEdge {
  intent: PlayerIntent;
  node: Node;
}

interface Node {
  state: GameState;
  player: number;
  parent: Node | null;
  visits: number;
  value: number;
  children: Map<string, ChildEdge>;
  untried: PlayerIntent[] | null;
}

const keyOf = (intent: PlayerIntent) => JSON.stringify(intent);

/**
 * 单步决策：从 state（轮到 seat）搜索并返回最优意图。
 * aiSeed：搜索平局打破与 rollout 的独立随机源（训练协议 D10）。
 */
export function chooseMove(state: GameState, cfg: MctsConfig, aiSeed: string): PlayerIntent {
  const rng = createRng(aiSeed);
  const rootPlayer = state.currentSeat;
  const root: Node = { state, player: rootPlayer, parent: null, visits: 0, value: 0, children: new Map(), untried: null };

  for (let sim = 0; sim < cfg.simsPerMove; sim++) {
    // 选择：沿已展开路径走到最深层未完成节点
    let node = root;
    while (node.untried === null || node.untried.length === 0) {
      if (node.children.size === 0) break;
      node = selectChild(node, cfg, rng);
    }
    // 展开
    if (node.untried === null) node.untried = legalActions(node.state);
    if (node.untried.length === 0) {
      backprop(node, evaluateNode(node.state, node.player, cfg));
      continue;
    }
    const intent = node.untried.pop()!;
    const r = applyIntent(node.state, { actor: { kind: 'PLAYER', seat: node.player }, intent });
    if (!r.ok) {
      backprop(node, evaluateNode(node.state, node.player, cfg));
      continue;
    }
    const child: Node = {
      state: r.state,
      player: r.state.currentSeat,
      parent: node,
      visits: 0,
      value: 0,
      children: new Map(),
      untried: null,
    };
    node.children.set(keyOf(intent), { intent, node: child });
    backprop(child, rollout(child.state, child.player, cfg, aiSeed));
  }

  // 根选择：node.player 视角最大化（对手节点取反）
  let best: ChildEdge | null = null;
  let bestScore = -Infinity;
  for (const edge of root.children.values()) {
    const c = edge.node;
    const flip = c.player === rootPlayer ? 1 : -1;
    const q = flip * (c.value / Math.max(1, c.visits));
    const s = q + c.visits * 1e-6; // 平局偏好访问量
    if (s > bestScore) {
      bestScore = s;
      best = edge;
    }
  }
  return best ? best.intent : { intentType: 'SWITCH_PHASE' };
}

/** negamax 回传：值从各节点自身 player 视角累积（换手取反） */
function backprop(leaf: Node, valueFromLeaf: number): void {
  let cur: Node | null = leaf;
  let m = 1;
  while (cur) {
    cur.visits += 1;
    cur.value += m * valueFromLeaf;
    if (cur.parent) m = cur.player === cur.parent.player ? m : -m;
    cur = cur.parent;
  }
}

/** UCT 选择子节点（node.player 视角最大化） */
function selectChild(node: Node, cfg: MctsConfig, rng: () => number): Node {
  let best: ChildEdge | null = null;
  let bestScore = -Infinity;
  const logN = Math.log(Math.max(1, node.visits));
  for (const edge of node.children.values()) {
    const c = edge.node;
    if (c.visits === 0) {
      const s = 1e9 + rng();
      if (s > bestScore) {
        bestScore = s;
        best = edge;
      }
      continue;
    }
    const flip = c.player === node.player ? 1 : -1;
    const q = flip * (c.value / c.visits);
    const s = q + cfg.explorationC * Math.sqrt(logN / c.visits) + rng() * 1e-9;
    if (s > bestScore) {
      bestScore = s;
      best = edge;
    }
  }
  return best!.node;
}
