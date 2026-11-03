// 触发器事务引擎：动作 pass（HUMAN 意图）、回合 pass（任意来源）、连锁、延时到期。
// 确定性顺序：转换 eventIndex 升序 → priority 降序 → 定义序 → id；单事务总触发上限。
import type { GameEvent, GameState } from '../types.js';
import type { PendingTrigger, TriggerDef, TriggerDelta } from './types.js';
import type { WorldTransition } from './types.js';
import type { TransitionCursor } from './delta.js';
import { collectTransitions } from './delta.js';
import { matchActionCondition, matchWorldCondition } from './conditions.js';

export const MAX_TRIGGER_FIRINGS = 512;

export interface TriggerExecutor {
  /** 执行单个触发器的全部效果，返回该触发器造成的增量 diff */
  execute(trigger: TriggerDef): TriggerDelta;
}

export interface TriggerTransactionInput {
  state: GameState;
  chain: GameEvent[];
  /** 本意图（已结算）造成的增量 diff */
  intentDelta: TriggerDelta;
  human: boolean;
  executor: TriggerExecutor;
  /** 事务开始前的阶段/回合游标（用于扫描本链转换） */
  transitionCursor: TransitionCursor;
  /** initState 的初始回合 pass：额外注入 TURN_START(1) */
  init?: boolean;
}

interface WorldPassState {
  initialized: boolean;
  lastIndex: number;
  cursor: TransitionCursor;
  /** 已入队过的 触发器:转换 键（跨多次 pass 保留，保证 repeatable 每个转换最多一次） */
  seen: Set<string>;
  /** 已排期的延时触发器 id */
  scheduled: Set<string>;
}

function triggerOrder(state: GameState): Map<string, number> {
  const order = new Map<string, number>();
  state.triggers.forEach((t, i) => order.set(t.id, i));
  return order;
}

function sortDefs(defs: TriggerDef[], order: Map<string, number>): TriggerDef[] {
  return [...defs].sort((a, b) => {
    const pa = a.priority ?? 0;
    const pb = b.priority ?? 0;
    if (pa !== pb) return pb - pa;
    const oa = order.get(a.id) ?? 0;
    const ob = order.get(b.id) ?? 0;
    if (oa !== ob) return oa - ob;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function isEligible(def: TriggerDef, state: GameState, firedThisTx: ReadonlySet<string>): boolean {
  const runtime = state.triggerRuntime;
  if (!runtime) return false;
  if (def.once && (runtime.firedCounts[def.id] ?? 0) > 0) return false;
  if (!def.repeatable && firedThisTx.has(def.id)) return false;
  return true;
}

function scheduleDelay(def: TriggerDef, state: GameState): void {
  const runtime = state.triggerRuntime;
  if (!runtime || !def.delay) return;
  if (def.once && (runtime.firedCounts[def.id] ?? 0) > 0) return;
  if (runtime.pending.some((p) => p.triggerId === def.id)) return;
  const pending: PendingTrigger = { triggerId: def.id, serial: runtime.nextSerial++ };
  if (def.delay.unit === 'intent') pending.dueIntentSeq = runtime.intentSeq + def.delay.amount;
  else if (def.delay.unit === 'turn') pending.dueTurnSeq = runtime.turnSeq + def.delay.amount;
  else pending.dueRound = state.turn + def.delay.amount;
  runtime.pending.push(pending);
}

// ---------- 动作 pass ----------

function runActionPass(input: TriggerTransactionInput, firedThisTx: Set<string>, counter: { value: number }): void {
  const { state, chain, executor } = input;
  const runtime = state.triggerRuntime;
  if (!runtime) return;
  const order = triggerOrder(state);
  const defs = sortDefs(state.triggers.filter((t) => t.class === 'action'), order);
  const queue: TriggerDef[] = [];
  const queued = new Set<string>();
  const scheduled = new Set<string>();

  const sortQueue = (): void => {
    queue.sort((a, b) => {
      const pa = a.priority ?? 0;
      const pb = b.priority ?? 0;
      if (pa !== pb) return pb - pa;
      const oa = order.get(a.id) ?? 0;
      const ob = order.get(b.id) ?? 0;
      if (oa !== ob) return oa - ob;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  };

  const enqueueMatching = (delta: TriggerDelta): void => {
    for (const def of defs) {
      if (queued.has(def.id)) continue;
      if (!isEligible(def, state, firedThisTx)) continue;
      if (!matchActionCondition(def.when, delta, firedThisTx, state)) continue;
      if (def.delay) {
        if (scheduled.has(def.id)) continue;
        scheduleDelay(def, state);
        scheduled.add(def.id);
        continue;
      }
      queue.push(def);
      queued.add(def.id);
    }
    sortQueue();
  };

  enqueueMatching(input.intentDelta);

  while (queue.length > 0) {
    if (counter.value >= MAX_TRIGGER_FIRINGS) {
      chain.push({ level: 5, kind: 'TRIGGER_OVERFLOW', transactionSeq: runtime.transactionSeq });
      break;
    }
    const def = queue.shift()!;
    queued.delete(def.id);
    if (!isEligible(def, state, firedThisTx)) continue;

    firedThisTx.add(def.id);
    runtime.firedCounts[def.id] = (runtime.firedCounts[def.id] ?? 0) + 1;
    counter.value += 1;
    chain.push({ level: 5, kind: 'TRIGGER_FIRE', triggerId: def.id });

    const delta = executor.execute(def);
    enqueueMatching(delta);
    if (state.finished) break;
  }
}

// ---------- 回合 pass ----------

interface WorldWork {
  def: TriggerDef;
  transition: WorldTransition;
}

function createWorldPassState(input: TriggerTransactionInput): WorldPassState {
  return {
    initialized: false,
    lastIndex: 0,
    cursor: input.transitionCursor,
    seen: new Set(),
    scheduled: new Set(),
  };
}

function runWorldPass(
  input: TriggerTransactionInput,
  world: WorldPassState,
  firedThisTx: Set<string>,
  counter: { value: number },
): void {
  const { state, chain, executor } = input;
  const runtime = state.triggerRuntime;
  if (!runtime) return;
  const order = triggerOrder(state);
  const defs = sortDefs(state.triggers.filter((t) => t.class === 'world'), order);
  const queue: WorldWork[] = [];

  const sortQueue = (): void => {
    queue.sort((a, b) => {
      if (a.transition.eventIndex !== b.transition.eventIndex) {
        return a.transition.eventIndex - b.transition.eventIndex;
      }
      const pa = a.def.priority ?? 0;
      const pb = b.def.priority ?? 0;
      if (pa !== pb) return pb - pa;
      const oa = order.get(a.def.id) ?? 0;
      const ob = order.get(b.def.id) ?? 0;
      if (oa !== ob) return oa - ob;
      return a.def.id < b.def.id ? -1 : a.def.id > b.def.id ? 1 : 0;
    });
  };

  const workKey = (def: TriggerDef, tx: WorldTransition): string =>
    `${def.id}:${tx.eventIndex}:${tx.kind}:${tx.phase}`;

  const enqueueTransitions = (transitions: WorldTransition[]): void => {
    for (const tx of transitions) {
      for (const def of defs) {
        const key = workKey(def, tx);
        if (world.seen.has(key)) continue;
        if (!isEligible(def, state, firedThisTx)) continue;
        if (!matchWorldCondition(def.when, tx, firedThisTx, state)) continue;
        if (def.delay) {
          if (world.scheduled.has(def.id)) continue;
          scheduleDelay(def, state);
          world.scheduled.add(def.id);
          continue;
        }
        queue.push({ def, transition: tx });
        world.seen.add(key);
      }
    }
    sortQueue();
  };

  // 首次扫描整条链；后续只扫描新增事件（延时/触发器效果追加）
  const from = world.initialized ? world.lastIndex : 0;
  const scan = collectTransitions(chain, from, world.cursor);
  runtime.turnSeq += scan.turnSeqDelta;
  world.lastIndex = scan.nextIndex;
  world.cursor = scan.cursor;
  const transitions =
    !world.initialized && input.init
      ? [
          {
            kind: 'TURN_START' as const,
            seat: input.transitionCursor.seat,
            phase: 'PREPARE' as const,
            turn: 1,
            eventIndex: -1,
          },
          ...scan.transitions,
        ]
      : scan.transitions;
  world.initialized = true;
  enqueueTransitions(transitions);

  while (queue.length > 0) {
    if (counter.value >= MAX_TRIGGER_FIRINGS) {
      chain.push({ level: 5, kind: 'TRIGGER_OVERFLOW', transactionSeq: runtime.transactionSeq });
      break;
    }
    const work = queue.shift()!;
    if (!isEligible(work.def, state, firedThisTx)) continue;

    firedThisTx.add(work.def.id);
    runtime.firedCounts[work.def.id] = (runtime.firedCounts[work.def.id] ?? 0) + 1;
    counter.value += 1;
    chain.push({ level: 5, kind: 'TRIGGER_FIRE', triggerId: work.def.id });

    executor.execute(work.def);

    const next = collectTransitions(chain, world.lastIndex, world.cursor);
    world.lastIndex = next.nextIndex;
    world.cursor = next.cursor;
    runtime.turnSeq += next.turnSeqDelta;
    enqueueTransitions(next.transitions);
    // 连锁：同一转换重新求值；firedThisTx 已包含刚执行的触发器
    enqueueTransitions([work.transition]);
    if (state.finished) break;
  }
}

// ---------- 延时到期 ----------

function isDue(p: PendingTrigger, state: GameState): boolean {
  const runtime = state.triggerRuntime;
  if (!runtime) return false;
  if (p.dueIntentSeq !== undefined && runtime.intentSeq >= p.dueIntentSeq) return true;
  if (p.dueTurnSeq !== undefined && runtime.turnSeq >= p.dueTurnSeq) return true;
  if (p.dueRound !== undefined && state.turn >= p.dueRound) return true;
  return false;
}

/** 执行本事务到期的延时触发器；返回是否有执行。允许在 AI 事务执行。 */
function runDueDelays(
  input: TriggerTransactionInput,
  firedThisTx: Set<string>,
  counter: { value: number },
): boolean {
  const { state, chain, executor } = input;
  const runtime = state.triggerRuntime;
  if (!runtime) return false;
  const due = runtime.pending.filter((p) => isDue(p, state)).sort((a, b) => a.serial - b.serial);
  if (due.length === 0) return false;
  if (counter.value >= MAX_TRIGGER_FIRINGS) {
    chain.push({ level: 5, kind: 'TRIGGER_OVERFLOW', transactionSeq: runtime.transactionSeq });
    return false;
  }
  const dueSerials = new Set(due.map((p) => p.serial));
  runtime.pending = runtime.pending.filter((p) => !dueSerials.has(p.serial));
  const byId = new Map(state.triggers.map((t) => [t.id, t]));

  let executed = false;
  for (const pending of due) {
    if (state.finished) break;
    if (counter.value >= MAX_TRIGGER_FIRINGS) {
      chain.push({ level: 5, kind: 'TRIGGER_OVERFLOW', transactionSeq: runtime.transactionSeq });
      break;
    }
    const def = byId.get(pending.triggerId);
    if (!def) continue;
    if (def.once && (runtime.firedCounts[def.id] ?? 0) > 0) continue;

    firedThisTx.add(def.id);
    runtime.firedCounts[def.id] = (runtime.firedCounts[def.id] ?? 0) + 1;
    counter.value += 1;
    executed = true;
    chain.push({ level: 5, kind: 'TRIGGER_FIRE', triggerId: def.id });

    const delta = executor.execute(def);
    // 玩家事务内，延时效果可继续触发动作类；AI 事务内不触发动作类
    if (input.human) {
      runActionPass({ ...input, intentDelta: delta }, firedThisTx, counter);
    }
  }
  return executed;
}

/** 每次 applyIntent（triggerMode 且意图成功）或 initState 调用一次 */
export function runTriggerTransaction(input: TriggerTransactionInput): void {
  const runtime = input.state.triggerRuntime;
  if (!runtime) return;
  runtime.transactionSeq += 1;
  if (input.human) runtime.intentSeq += 1;
  const firedThisTx = new Set<string>();
  const counter = { value: 0 };

  if (input.human) runActionPass(input, firedThisTx, counter);
  if (input.state.finished) return;

  const world = createWorldPassState(input);
  runWorldPass(input, world, firedThisTx, counter);

  let guard = 0;
  while (!input.state.finished && guard++ < 32) {
    const executed = runDueDelays(input, firedThisTx, counter);
    if (!executed) break;
    runWorldPass(input, world, firedThisTx, counter);
  }
}
