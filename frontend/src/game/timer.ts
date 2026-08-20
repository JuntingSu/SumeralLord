// 本地计时器（规则 v2 §10 + 补充规则）：
// - 局时：仅在自己回合期间走表（行动阶段开始 → 加点阶段结束）；归零 → 超时投降
// - 步时：每次轮到该势力重置；若剩余局时不足一步时，按剩余局时起算；行动/加点两阶段共用；
//   归零（局时未归零）→ 代玩家跳过本回合
// - 加时：己方回合结束时加到局时
// - 同时归零：按局时归零处理（超时投降）
// 计时权威在本地（娱乐定位）；TIME_SYNC 仅校正显示，不走表逻辑。
import type { RoomTimeSettings } from '@dl/shared';

export interface TimerState {
  /** 当前行动势力（null = 未开始/已结束） */
  activeSeat: number | null;
  stepTimeRemain: number;
  gameTimeRemain: number;
}

export interface TickResult {
  next: TimerState;
  /** 步时归零（局时未归零）→ 代玩家跳过本回合 */
  stepTimeout: boolean;
  /** 局时归零 → 超时投降（含同时归零，局时优先） */
  gameTimeout: boolean;
}

export function initialTimer(settings: RoomTimeSettings): TimerState {
  return { activeSeat: null, stepTimeRemain: settings.stepTime, gameTimeRemain: settings.gameTime };
}

/** 回合轮转（activeSeat 变化）时重置计时：旧回合结束加时 → 新回合步时重置（不足一步时按剩余局时起算） */
export function onTurnChange(prev: TimerState, nextSeat: number, settings: RoomTimeSettings): TimerState {
  let gameTimeRemain = prev.gameTimeRemain;
  if (prev.activeSeat !== null && prev.activeSeat !== nextSeat) {
    // 己方回合结束 → 局时 + 加时（上限为局时设置值）
    gameTimeRemain = Math.min(settings.gameTime, gameTimeRemain + settings.additionalTime);
  }
  return {
    activeSeat: nextSeat,
    // 局时不足一步时：新回合步时从剩余局时开始倒计时
    stepTimeRemain: Math.min(settings.stepTime, gameTimeRemain),
    gameTimeRemain,
  };
}

/** 走表（每秒 tick）：步时与局时同时走；归零边界各报一次（防止重复触发） */
export function tick(state: TimerState): TickResult {
  if (state.activeSeat === null) return { next: state, stepTimeout: false, gameTimeout: false };
  const stepTimeRemain = Math.max(0, state.stepTimeRemain - 1);
  const gameTimeRemain = Math.max(0, state.gameTimeRemain - 1);
  return {
    next: { ...state, stepTimeRemain, gameTimeRemain },
    // 仅归零瞬间报一次；同时归零 → 局时优先（stepTimeout 要求局时未归零）
    stepTimeout: state.stepTimeRemain > 0 && stepTimeRemain === 0 && gameTimeRemain > 0,
    gameTimeout: state.gameTimeRemain > 0 && gameTimeRemain === 0,
  };
}

/** 格式化 mm:ss */
export function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
