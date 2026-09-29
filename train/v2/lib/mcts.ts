// mcts.ts — v2 原子 MCTS（决策定稿 §5）
//
// 树：节点 = 一个原子动作后的局面；同一玩家连续动作不翻转价值符号、回合边界（行动方变化）翻转。
// 价值语义：节点存储「该节点行动方视角」的价值（网络输出恒为当前行动方视角，天然对齐）；
//   回传时沿路径向上，行动方变化的边取负（负极大）；选择时父节点将子节点价值换算回父视角再取 max
//   （对手节点等效取 min）。
// 根决策：argmax（部署，τ=0）或温度采样（训练，prob ∝ visits^(1/τ)）；π = 根访问比例。
// 叶评估：终局精确值（+1/−1/0）；非终局 = 网络价值。根节点全动作展开（每个合法动作先建子节点评估）。
// 惰性物化：展开只算合法动作 + 先验（一次前向）；子节点局面在首次被 PUCT 选中时才经 applyIntent 派生，
//   选择分数与全量展开逐位一致（未物化子节点按 Q=0、n=0 参与），树内存 O(模拟数 × 局面大小) 而非
//   O(合法动作数 × 模拟数 × 局面大小)（大图后期加点局面 L≈2500 时全量展开树可达数 GB，超 worker 堆上限）。
// 确定性：无随机；PUCT 并列取动作索引小者（升序遍历）。
import { applyIntent } from '@dl/shared';
import type { GameState, PlayerIntent } from '@dl/shared';
import { actionToIntent, legalActionList } from './actions.js';
import { encodeState } from './encode.js';
import type { NeuralNet } from './nn.js';

export interface MctsOptions {
  /** 模拟次数 */
  simulations: number;
  /** PUCT 探索常数（缺省 1.0） */
  explorationC?: number;
  /** 根温度采样（缺省 0 = argmax；训练传 >0） */
  temperature?: number;
  /** 单决策物化节点预算（安全阀，缺省 500_000）：合法动作数 L 过大时按 floor(budget/L) 降模拟数，
   *  常规局面不触发；防御超大 L 加点局面（L≈数千）的树体积与算力 */
  maxNodes?: number;
  rng?: () => number;
}

export interface MctsResult {
  /** 根选择的动作索引（-1 = 无合法动作/终局防御） */
  action: number;
  /** 合法动作 → 访问数 */
  visits: Map<number, number>;
  /** 合法动作 → 平均价值（根行动方视角） */
  meanValues: Map<number, number>;
  /** 访问比例先验（覆盖全部合法动作，prob 可含 0；训练样本用） */
  pi: { idx: number[]; prob: number[] };
}

interface MctsNode {
  state: GameState;
  /** 到达本节点的动作（根 = -1） */
  action: number;
  /** 本节点行动方 */
  seat: number;
  terminal: boolean;
  /** 合法动作列表（升序；null = 未展开） */
  legal: number[] | null;
  /** 网络先验（softmax over legal，与 legal 对齐；null = 未展开） */
  prior: Float64Array | null;
  /** 网络价值（本节点行动方视角） */
  netValue: number;
  visits: number;
  /** 价值累加（本节点行动方视角） */
  valueSum: number;
  /** 已物化子节点（惰性：仅首次被选中时创建；null = 未展开） */
  children: Map<number, MctsNode> | null;
  /** 掩码动作但 applyIntent 被拒的动作（理论不可达；防御，选择时跳过） */
  blocked?: Set<number>;
}

/** 终局价值（node 行动方视角）：胜 +1 / 负 −1 / 平 0 */
function terminalValue(state: GameState, seat: number): number {
  const wt = state.winningTeam;
  if (wt === null || wt < 0) return 0;
  const team = state.forces.find((f) => f.seat === seat)?.team ?? -1;
  return team === wt ? 1 : -1;
}

/** 展开节点：算合法动作 + 网络前向（先验 softmax over legal + 价值）。
 *  惰性物化：本处只建空 children Map，子节点在首次被 PUCT 选中时才经 materializeChild 派生（见 selectAction/选择循环）。 */
async function expandNode(node: MctsNode, net: NeuralNet): Promise<void> {
  const state = node.state;
  node.terminal = state.finished;
  node.children = new Map();
  if (node.terminal) {
    node.legal = [];
    return;
  }
  const legal = legalActionList(state);
  node.legal = legal;
  if (legal.length === 0) {
    node.netValue = 0; // 防御：非终局但无合法动作（理论不可达）
    return;
  }
  const enc = encodeState(state);
  const out = await net.forward(state, enc);
  // 先验：合法动作上的 softmax（数值稳定）
  const logits = out.policy;
  let max = -Infinity;
  for (const a of legal) if (logits[a] > max) max = logits[a];
  let sum = 0;
  const exp = new Float64Array(legal.length);
  for (let i = 0; i < legal.length; i++) {
    exp[i] = Math.exp(logits[legal[i]] - max);
    sum += exp[i];
  }
  const prior = new Float64Array(legal.length);
  for (let i = 0; i < legal.length; i++) prior[i] = exp[i] / sum;
  node.prior = prior;
  node.netValue = out.value; // 网络恒输出「当前行动方视角」
}

/** 物化子节点：应用动作得到后继局面（applyIntent 内部克隆，父局面不可变）。
 *  掩码动作被拒（理论不可达）→ 记入 blocked 并返回 null，选择时跳过该动作。 */
function materializeChild(node: MctsNode, a: number): MctsNode | null {
  const r = applyIntent(node.state, {
    actor: { kind: 'PLAYER', seat: node.state.currentSeat },
    intent: actionToIntent(node.state, a),
  });
  if (!r.ok) {
    (node.blocked ??= new Set()).add(a);
    return null;
  }
  const child: MctsNode = {
    state: r.state,
    action: a,
    seat: r.state.currentSeat,
    terminal: r.state.finished,
    legal: null,
    prior: null,
    netValue: 0,
    visits: 0,
    valueSum: 0,
    children: null,
  };
  return child;
}

/** PUCT 选择（父视角换算：子节点行动方与父不同则取负）。返回动作索引；
 *  未物化子节点按 Q=0、n=0 参与（分数与全量展开一致），选中后由调用方 materializeChild 物化。 */
function selectAction(node: MctsNode, c: number): number | null {
  const legal = node.legal!;
  const children = node.children!;
  const sqrtN = Math.sqrt(node.visits);
  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < legal.length; i++) {
    const a = legal[i];
    if (node.blocked?.has(a)) continue;
    const ch = children.get(a);
    const n = ch?.visits ?? 0;
    const q = ch && ch.visits > 0 ? (ch.seat === node.seat ? ch.valueSum : -ch.valueSum) / ch.visits : 0;
    const score = q + (c * node.prior![i] * sqrtN) / (1 + n);
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return best >= 0 ? best : null;
}

/** 根决策：访问数 argmax（并列取索引小者，确定性） */
function argmaxVisits(root: MctsNode, legal: number[]): number {
  let best = legal[0];
  let bestV = -1;
  for (const a of legal) {
    const v = root.children?.get(a)?.visits ?? 0;
    if (v > bestV) {
      bestV = v;
      best = a;
    }
  }
  return best;
}

/** 根决策：温度采样（prob ∝ visits^(1/τ)） */
function sampleByVisits(root: MctsNode, legal: number[], tau: number, rng: () => number): number {
  const weights = legal.map((a) => Math.pow(root.children?.get(a)?.visits ?? 0, 1 / tau));
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return argmaxVisits(root, legal);
  let r = rng() * sum;
  for (let i = 0; i < legal.length; i++) {
    r -= weights[i];
    if (r <= 0) return legal[i];
  }
  return legal[legal.length - 1];
}

/**
 * 原子 MCTS 决策。返回根选择的动作索引与访问分布。
 * state 须处于 ACTION/ADD_POINT 决策点。
 */
export async function mctsDecide(
  state: GameState,
  net: NeuralNet,
  opts: MctsOptions,
): Promise<MctsResult> {
  const c = opts.explorationC ?? 1.0;
  const rng = opts.rng ?? Math.random;
  const rootSeat = state.currentSeat;

  const root: MctsNode = {
    state,
    action: -1,
    seat: rootSeat,
    terminal: state.finished,
    legal: null,
    prior: null,
    netValue: 0,
    visits: 0,
    valueSum: 0,
    children: null,
  };

  // 根节点全动作展开（决策定稿 §5：一步深 + 价值网络即可识别先亏后赚；先验覆盖全部合法动作）
  await expandNode(root, net);
  const legal = root.legal!;
  if (legal.length === 0) {
    return { action: -1, visits: new Map(), meanValues: new Map(), pi: { idx: [], prob: [] } };
  }

  // 模拟数兜底（安全阀）：超大合法动作集局面按物化节点预算降模拟（常规局面不触发）
  const maxNodes = opts.maxNodes ?? 500_000;
  const sims = Math.max(1, Math.min(opts.simulations, Math.floor(maxNodes / legal.length)));

  for (let s = 0; s < sims; s++) {
    // 选择：沿 PUCT 下探到未展开或终局节点；未物化子节点按 Q=0 参与，选中后即时物化
    const path: MctsNode[] = [root];
    let node = root;
    while (!node.terminal && node.children !== null) {
      const a = selectAction(node, c);
      if (a === null) break;
      let child: MctsNode | null | undefined = node.children.get(a);
      if (!child) {
        child = materializeChild(node, a);
        if (!child) continue; // 防御：掩码动作被拒（理论不可达），blocked 后重选
        node.children.set(a, child);
      }
      path.push(child);
      node = child;
    }
    // 展开（若未展开且非终局）
    if (!node.terminal && node.children === null) {
      await expandNode(node, net);
    }
    // 回传：叶价值（终局精确值 / 网络价值），沿路径向上、行动方变化的边取负
    let v = node.terminal ? terminalValue(node.state, node.seat) : node.netValue;
    node.visits += 1;
    node.valueSum += v;
    for (let i = path.length - 2; i >= 0; i--) {
      const n = path[i];
      if (node.seat !== n.seat) v = -v;
      node = n;
      node.visits += 1;
      node.valueSum += v;
    }
  }

  // 根决策
  const tau = opts.temperature ?? 0;
  const action =
    tau > 0 && root.visits > 0 ? sampleByVisits(root, legal, tau, rng) : argmaxVisits(root, legal);

  // 诊断：合法动作的访问数与根视角平均价值
  const visits = new Map<number, number>();
  const meanValues = new Map<number, number>();
  for (const a of legal) {
    const ch = root.children?.get(a);
    const v = ch?.visits ?? 0;
    visits.set(a, v);
    meanValues.set(
      a,
      ch && ch.visits > 0 ? (ch.seat === rootSeat ? ch.valueSum : -ch.valueSum) / ch.visits : 0,
    );
  }
  // π：访问比例（覆盖全部合法动作，prob 可含 0；根未访问时均匀兜底）
  const prob =
    root.visits > 0 ? legal.map((a) => (visits.get(a) ?? 0) / root.visits) : legal.map(() => 1 / legal.length);

  return { action, visits, meanValues, pi: { idx: [...legal], prob } };
}

/** MCTS 策略（接入 driver）：返回根选择的意图 + 访问比例先验 */
export function mctsPolicy(net: NeuralNet, opts: MctsOptions): (state: GameState) => Promise<{ intent: PlayerIntent; pi: { idx: number[]; prob: number[] } }> {
  return async (state) => {
    const r = await mctsDecide(state, net, opts);
    return { intent: actionToIntent(state, r.action), pi: r.pi };
  };
}
