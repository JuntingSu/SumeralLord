// 演示回放播放辅助：初态补齐演示规则、单步应用、带检查点的定位。
// 纯函数/纯类，不依赖 React，便于单测。
import { applyIntent } from '@dl/shared';
import type {
  DemoReplayFile,
  DemoReplayStep,
  DemoRules,
  GameEvent,
  GameState,
  SoldierState,
} from '@dl/shared';

/** 回放一律使用无限加点 + 无自动胜负，即使文件里的初态没带 demo 字段 */
export const DEMO_RULES: DemoRules = { infinitePoints: true, noVictory: true };

/** 检查点间隔（步）；定位时最多重放这么多步 */
const CHECKPOINT_EVERY = 20;
/** 检查点数量上限（含初态 0），避免大图占用过多内存 */
const MAX_CHECKPOINTS = 16;

export interface DemoStepResult {
  ok: boolean;
  state: GameState;
  chain: GameEvent[];
  beforeTiles: Array<SoldierState | null>;
  reason?: string;
}

export function demoInitialState(file: DemoReplayFile): GameState {
  return { ...file.initialState, demo: { ...DEMO_RULES } };
}

/** 按记录的执行势力应用一条意图；失败时返回原状态 */
export function applyDemoStep(state: GameState, step: DemoReplayStep): DemoStepResult {
  const beforeTiles: Array<SoldierState | null> = state.tiles.map((t) => (t.soldier ? { ...t.soldier } : null));
  const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: step.seat }, intent: step.intent });
  if (!r.ok) {
    return { ok: false, state, chain: [], beforeTiles, reason: r.reason };
  }
  return { ok: true, state: r.state, chain: r.chain, beforeTiles };
}

export interface SeekResult {
  state: GameState;
  /** 被当前 reducer 拒绝的步骤序号（版本不一致时可能出现） */
  failedSteps: number[];
}

/**
 * 回放时间轴：以初态 + 检查点缓存按需计算任意步局面。
 * 前进/后退都通过 stateAt 定位；倒放不做动画，直接跳到目标局面。
 */
export class DemoReplayTimeline {
  readonly file: DemoReplayFile;
  readonly initial: GameState;
  readonly total: number;
  private readonly checkpoints = new Map<number, GameState>();

  constructor(file: DemoReplayFile) {
    this.file = file;
    this.initial = demoInitialState(file);
    this.total = file.steps.length;
    this.checkpoints.set(0, this.initial);
  }

  /** 第 n 步（0 = 初态，total = 终态）的局面 */
  stateAt(n: number): SeekResult {
    const target = Math.max(0, Math.min(n, this.total));
    let start = 0;
    let state = this.initial;
    for (const [cursor, cached] of this.checkpoints) {
      if (cursor <= target && cursor > start) {
        start = cursor;
        state = cached;
      }
    }
    const failedSteps: number[] = [];
    for (let i = start; i < target; i++) {
      const r = applyDemoStep(state, this.file.steps[i]);
      if (r.ok) state = r.state;
      else failedSteps.push(i);
    }
    if (target % CHECKPOINT_EVERY === 0) this.remember(target, state);
    return { state, failedSteps };
  }

  private remember(cursor: number, state: GameState): void {
    this.checkpoints.set(cursor, state);
    if (this.checkpoints.size <= MAX_CHECKPOINTS) return;
    // 淘汰离当前定位点最远的检查点（保留 0 与当前检查点）
    let farthest = -1;
    let farthestDistance = -1;
    for (const key of this.checkpoints.keys()) {
      if (key === 0 || key === cursor) continue;
      const distance = Math.abs(key - cursor);
      if (distance > farthestDistance) {
        farthestDistance = distance;
        farthest = key;
      }
    }
    if (farthest >= 0) this.checkpoints.delete(farthest);
  }
}
