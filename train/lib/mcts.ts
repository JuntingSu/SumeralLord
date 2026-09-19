// mcts.ts — 回合级 MCTS 搜索引擎（设计方案 §4）
// 节点 = 回合边界，动作 = 候选回合计划（4 个）；深度 = 根势力 2 回合 + 对手 1 回合（3 层）；
// 叶 = 根势力第二个回合结束局面，E_te(叶局面, 该回合开始局面) 评估并按局面哈希缓存。
// 对抗语义：对手节点取 min（翻转符号的 UCB 选择）；价值始终以根视角存储与回传。
// UCB1 c=1.0；每决策 300 次模拟；树不复用；argmax 与温度采样两种根决策模式。
import { hashGameState } from '@dl/shared';
import type { GameState } from '@dl/shared';
import { evalTe, type TeWeights } from './eval.js';
import { planTurnCandidates, type TurnPlan, type TurnPlanOptions } from './turnplan.js';

export interface MctsOptions {
  /** 每决策模拟次数（默认 300） */
  simulations?: number;
  /** UCB1 探索常数（默认 1.0） */
  explorationC?: number;
  /** 候选生成参数透传 */
  turnPlan?: TurnPlanOptions;
  /** 根决策模式：argmax（基准/验收）| sample（自对弈，按访问比例^（1/τ）） */
  mode?: 'argmax' | 'sample';
  /** 温度采样 τ（mode=sample 时生效） */
  temperature?: number;
  /** 采样随机源（缺省 Math.random；训练对局不种子化） */
  rng?: () => number;
}

export interface MctsResult {
  plan: TurnPlan;
  /** 根各候选访问数 */
  visits: number[];
  /** 根各候选平均价值（根视角） */
  meanValues: number[];
  /** 搜索树节点数（诊断） */
  nodeCount: number;
  /** 根各候选计划（自对弈采样/分析用） */
  plans: TurnPlan[];
}

interface MctsNode {
  state: GameState;
  seatToMove: number;
  /** 本回合开始局面（叶评估的"回合初"快照） */
  turnStart: GameState;
  depth: number;
  /** 叶评估点（深度 3）或无候选终态 */
  isLeaf: boolean;
  /** 终局已知值（根视角：胜 1 / 负 −1 / 平 0） */
  terminalValue: number | null;
  plans: TurnPlan[] | null;
  children: MctsNode[] | null;
  visits: number;
  valueSum: number;
}

/** 终局价值（根视角）：胜 +1 / 负 −1 / 平 0 */
function outcomeValue(state: GameState, rootSeat: number): number {
  if (!state.finished) return 0;
  const rootTeam = state.forces.find((f) => f.seat === rootSeat)?.team ?? -1;
  if (state.winningTeam === null || state.winningTeam < 0) return 0;
  return state.winningTeam === rootTeam ? 1 : -1;
}

function otherAliveSeat(state: GameState, seat: number): number {
  for (const f of state.forces) {
    if (f.exists && f.alive && f.seat !== seat) return f.seat;
  }
  return seat; // 无其他存活势力（对局应已结束）
}

/** 叶评估：E_te(叶局面, 该回合开始局面)，按局面哈希缓存 */
function leafValue(
  node: MctsNode,
  rootSeat: number,
  weights: TeWeights,
  cache: Map<string, number>,
): number {
  const key = `${hashGameState(node.state)}|${hashGameState(node.turnStart)}|${rootSeat}`;
  let v = cache.get(key);
  if (v === undefined) {
    v = evalTe(node.state, node.turnStart, rootSeat, weights);
    cache.set(key, v);
  }
  return v;
}

/** UCB1 选择：对手节点翻转价值符号取 min（根视角存储的标准对抗惯例） */
function selectChild(node: MctsNode, rootSeat: number, c: number): MctsNode {
  const sign = node.seatToMove === rootSeat ? 1 : -1;
  const logN = Math.log(Math.max(1, node.visits));
  let best = node.children![0];
  let bestScore = -Infinity;
  for (const ch of node.children!) {
    let score: number;
    if (ch.visits === 0) {
      score = Infinity; // 未访问优先
    } else {
      score = sign * (ch.valueSum / ch.visits) + c * Math.sqrt(logN / ch.visits);
    }
    if (score > bestScore) {
      bestScore = score;
      best = ch;
    }
  }
  return best;
}

/** 按访问比例^(1/τ) 采样根动作 */
function sampleByVisits(visits: number[], tau: number, rng: () => number): number {
  if (visits.length === 1) return 0;
  const t = Math.max(0.01, tau);
  const weights = visits.map((n) => Math.pow(Math.max(1, n), 1 / t));
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i];
    if (roll < 0) return i;
  }
  return weights.length - 1;
}

/** 回合级 MCTS 决策（每决策从零建树，不复用） */
export function mctsDecide(state: GameState, rootSeat: number, weights: TeWeights, opts?: MctsOptions): MctsResult {
  const simulations = opts?.simulations ?? 300;
  const c = opts?.explorationC ?? 1.0;
  const evalCache = new Map<string, number>();
  let nodeCount = 1;

  const root: MctsNode = {
    state,
    seatToMove: rootSeat,
    turnStart: state,
    depth: 0,
    isLeaf: false,
    terminalValue: state.finished ? outcomeValue(state, rootSeat) : null,
    plans: null,
    children: null,
    visits: 0,
    valueSum: 0,
  };

  for (let sim = 0; sim < simulations; sim++) {
    const path: MctsNode[] = [root];
    let node = root;
    let value: number;
    for (;;) {
      if (node.terminalValue !== null) {
        value = node.terminalValue;
        break;
      }
      if (node.isLeaf) {
        value = leafValue(node, rootSeat, weights, evalCache);
        break;
      }
      if (node.children === null) {
        // 扩展：生成候选回合计划并创建子节点
        if (node.state.finished) {
          node.terminalValue = outcomeValue(node.state, rootSeat);
          value = node.terminalValue;
          break;
        }
        if (node.depth >= 3) {
          node.isLeaf = true; // 根势力第 2 回合结束 → 叶评估点
          value = leafValue(node, rootSeat, weights, evalCache);
          break;
        }
        const plans = planTurnCandidates(node.state, node.seatToMove, weights, opts?.turnPlan);
        if (plans.length === 0) {
          node.isLeaf = true; // 无候选（防御性兜底）
          value = leafValue(node, rootSeat, weights, evalCache);
          break;
        }
        node.plans = plans;
        node.children = plans.map((p) => {
          nodeCount++;
          return {
            state: p.resultState,
            seatToMove: otherAliveSeat(p.resultState, node.seatToMove),
            turnStart: p.resultState, // 子回合的开始局面 = 本回合结束局面
            depth: node.depth + 1,
            isLeaf: false,
            terminalValue: p.resultState.finished ? outcomeValue(p.resultState, rootSeat) : null,
            plans: null,
            children: null,
            visits: 0,
            valueSum: 0,
          };
        });
      }
      node = selectChild(node, rootSeat, c);
      path.push(node);
    }
    for (const n of path) {
      n.visits++;
      n.valueSum += value;
    }
  }

  // 根决策
  const children = root.children;
  if (!children || children.length === 0 || root.plans === null) {
    // 无候选（对局已结束等）：返回空计划
    return {
      plan: { actionIntents: [], addPointIntents: [], resultState: state },
      visits: [],
      meanValues: [],
      nodeCount,
      plans: [],
    };
  }
  const visits = children.map((ch) => ch.visits);
  const meanValues = children.map((ch) => (ch.visits > 0 ? ch.valueSum / ch.visits : 0));
  let picked = 0;
  if (opts?.mode === 'sample') {
    picked = sampleByVisits(visits, opts.temperature ?? 1, opts.rng ?? Math.random);
  } else {
    // argmax：访问数优先，平局取平均价值，再取索引（确定性）
    for (let i = 1; i < children.length; i++) {
      if (visits[i] > visits[picked] || (visits[i] === visits[picked] && meanValues[i] > meanValues[picked])) {
        picked = i;
      }
    }
  }
  return { plan: root.plans[picked], visits, meanValues, nodeCount, plans: root.plans };
}
