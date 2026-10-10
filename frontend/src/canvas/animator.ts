// 事件链动画播放器（M5.1，展示层演出）：board 权威不变，动画只影响视觉。
// 逐链播放：链起始兵表快照 → 逐事件动画（进度 0..1）→ 事件结束时按事件自带数据推进"动画态"。
// 动画态推进只消费事件数据（SPAWN/UPDATE/DESPAWN/BREAK_JUDGE），不重复推导规则；
// BREAK_JUDGE 的 region 断兵/扣血/删兵与 reducer 直接修改语义一致（reducer 不为其产生 UPDATE 事件）。
// frame() 的契约：返回 null ⟺ 队列已排空（回放已追平最新局面）。**只要队列里还有待播链就绝不返回 null**：
// 链与链的交界帧返回「链末态」帧（event 为 null，tiles 为该链播完后的动画态）。否则观战/重连回放积压时，
// 渲染层会在交界帧回落渲染权威 board（= 最新局面），与回放位置交替显示造成高频闪烁。
// 本文件属 UI 层（frontend/src/canvas/），确定性 lint 不适用（允许时间戳）。
import type { GameEvent, SoldierState } from '@dl/shared';

/** 动画态兵表（index → 兵；与 board 解耦，仅供渲染） */
export type AnimTiles = Array<SoldierState | null>;

/** 单条事件链队列项（与 stores/game 的 eventQueue 元素同构） */
export interface EventQueueItem {
  chain: GameEvent[];
  /** 链应用前的兵表快照（动画插值起点；board 权威不变） */
  beforeTiles: AnimTiles;
}

/** 每帧输出：当前事件与进度 + 事件起始态兵表（BoardCanvas 据此画中间帧） */
export interface AnimatorFrame {
  /** 当前事件（链末态帧为 null：该链已播完、尚未取下一链） */
  event: GameEvent | null;
  /** 0..1 事件播放进度（暂停时冻结） */
  progress: number;
  tiles: AnimTiles;
  /** 断连区域高亮地块（红闪） */
  breakTiles: number[];
  /** 势力清除中（该势力兵红闪） */
  clearingSeats: number[];
}

/** 各事件动画时长（ms）；INIT 为 0（瞬时） */
export const EVENT_DURATION: Record<string, number> = {
  MOVE: 200,
  ATTACK: 250,
  SPAWN: 150,
  DESPAWN: 150,
  UPDATE: 100,
  BREAK: 200,
  REJOIN: 150,
  BREAK_JUDGE: 250,
  FORCE_CLEAR: 400,
  SWITCH_PHASE: 80,
  END_TURN: 120,
  ADD_POINT: 100,
  INIT: 0,
  VICTORY: 500,
};

export class EventAnimator {
  private item: EventQueueItem | null = null;
  private index = 0;
  private tiles: AnimTiles = [];
  private eventStart = 0;
  private lastProgress = 0;
  private speed = 1;
  private paused = false;
  private breakTiles: number[] = [];
  private clearingSeats: number[] = [];

  constructor(
    private readonly getQueue: () => EventQueueItem[],
    private readonly popQueue: () => void,
  ) {}

  /** 是否有进行中的动画（用于操作禁用提示） */
  get isPlaying(): boolean {
    return this.item !== null;
  }

  /** 当前动画态兵表（测试/调试用只读视图；与 board 解耦） */
  get currentTiles(): AnimTiles {
    return this.tiles;
  }

  setSpeed(speed: number): void {
    this.speed = speed;
  }

  /** 暂停/恢复（now 供测试注入；默认真实时钟）。暂停冻结进度，恢复从冻结点继续 */
  setPaused(paused: boolean, now = performance.now()): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (!this.item) return;
    const ev = this.item.chain[this.index];
    const dur = (EVENT_DURATION[ev.kind] ?? 120) / this.speed;
    if (paused) {
      this.lastProgress = Math.min(1, Math.max(0, (now - this.eventStart) / dur));
    } else {
      this.eventStart = now - this.lastProgress * dur;
    }
  }

  /** 单步：立即结束当前事件（推进到下一事件/下一链） */
  step(): void {
    if (!this.item) return;
    this.finishEvent(performance.now());
  }

  /** 快进：丢弃全部动画（调用方同时清队列），回到 board 渲染 */
  reset(): void {
    this.item = null;
    this.index = 0;
    this.tiles = [];
    this.breakTiles = [];
    this.clearingSeats = [];
  }

  /** 每帧调用（rAF）：返回当前帧；**队列已排空（回放已追平最新）时返回 null（渲染权威 board）** */
  frame(now: number): AnimatorFrame | null {
    if (this.item === null) {
      const queue = this.getQueue();
      if (queue.length === 0) return null;
      this.item = queue[0];
      this.index = 0;
      this.tiles = this.item.beforeTiles.map((t) => (t ? { ...t } : null));
      this.eventStart = now;
    }
    const ev = this.item.chain[this.index];
    const dur = (EVENT_DURATION[ev.kind] ?? 120) / this.speed;
    if (this.paused) {
      return {
        event: ev,
        progress: this.lastProgress,
        tiles: this.tiles,
        breakTiles: this.breakTiles,
        clearingSeats: this.clearingSeats,
      };
    }
    const elapsed = now - this.eventStart;
    const progress = Math.min(1, Math.max(0, elapsed / dur));
    this.lastProgress = progress;
    if (elapsed < dur) {
      return {
        event: ev,
        progress,
        tiles: this.tiles,
        breakTiles: this.breakTiles,
        clearingSeats: this.clearingSeats,
      };
    }
    this.finishEvent(now);
    if (this.item === null) {
      // 链播完：队列仍有待播链 → 返回「链末态」帧（tiles 即该链播完后的动画态，不回落当前局面）；
      // 队列已空（回放追平最新）→ null，由渲染层画权威 board。
      if (this.getQueue().length > 0) {
        return {
          event: null,
          progress: 1,
          tiles: this.tiles,
          breakTiles: this.breakTiles,
          clearingSeats: this.clearingSeats,
        };
      }
      return null;
    }
    return this.frame(now);
  }

  private finishEvent(now: number): void {
    const item = this.item;
    if (!item) return;
    const ev = item.chain[this.index];
    this.applyEvent(ev);
    this.index += 1;
    if (this.index >= item.chain.length) {
      this.popQueue();
      this.item = null;
      this.index = 0;
      this.eventStart = 0;
      this.breakTiles = [];
      this.clearingSeats = [];
      return;
    }
    this.eventStart = now;
  }

  /** 事件结束：推进动画态（只消费事件自带数据，与 reducer 语义一致） */
  private applyEvent(ev: GameEvent): void {
    switch (ev.kind) {
      case 'SPAWN':
        this.tiles[ev.tile] = { ...ev.soldier };
        break;
      case 'UPDATE':
        if (this.tiles[ev.tile]) this.tiles[ev.tile] = { ...ev.after };
        break;
      case 'DESPAWN':
        this.tiles[ev.tile] = null;
        break;
      case 'BREAK':
        this.breakTiles = [...ev.branches];
        break;
      case 'BREAK_JUDGE':
        // reducer 对断连区域直接修改（不产生 UPDATE），此处按同一语义推进
        if (!ev.connected) {
          for (const t of ev.region) {
            const s = this.tiles[t];
            if (!s) continue;
            s.isLinked = false;
            s.strength -= 1;
            if (s.strength <= 0) this.tiles[t] = null;
          }
        }
        this.breakTiles = ev.connected ? [] : [...ev.region];
        break;
      case 'FORCE_CLEAR':
        if (!this.clearingSeats.includes(ev.seat)) this.clearingSeats = [...this.clearingSeats, ev.seat];
        break;
      default:
        break;
    }
  }
}
