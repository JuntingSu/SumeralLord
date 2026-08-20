// 本地计时器（规则 v2 §10）：
// - 局时：仅在自己回合期间走表（行动阶段开始 → 加点阶段结束）；归零 → 超时投降
// - 步时：每次轮到该势力重置为 stepTime，行动/加点两阶段共用；归零 → 超时投降
// - 加时：己方回合结束时加到局时
// - 同时归零：步时优先
// 计时权威在本地（娱乐定位）；TIME_SYNC 仅校正显示，不走表逻辑。
import type { RoomTimeSettings } from '@dl/shared';

export interface TimerState {
  /** 当前行动势力（null = 未开始/已结束） */
  activeSeat: number | null;
  stepTimeRemain: number;
  gameTimeRemain: number;
}

export function initialTimer(settings: RoomTimeSettings): TimerState {
  return { activeSeat: null, stepTimeRemain: settings.stepTime, gameTimeRemain: settings.gameTime };
}

/** 回合轮转（activeSeat 变化）时重置计时：旧回合结束加时 → 新回合步时重置（§10） */
export function onTurnChange(prev: TimerState, nextSeat: number, settings: RoomTimeSettings): TimerState {
  let gameTimeRemain = prev.gameTimeRemain;
  if (prev.activeSeat !== null && prev.activeSeat !== nextSeat) {
    // 己方回合结束 → 局时 + 加时（上限为局时设置值）
    gameTimeRemain = Math.min(settings.gameTime, gameTimeRemain + settings.additionalTime);
  }
  return {
    activeSeat: nextSeat,
    stepTimeRemain: settings.stepTime,
    gameTimeRemain,
  };
}

/** 走表（每秒 tick）：步时与局时同时走；归零触发超时投降（步时优先语义） */
export function tick(state: TimerState): { next: TimerState; timeout: boolean } {
  if (state.activeSeat === null) return { next: state, timeout: false };
  const stepTimeRemain = Math.max(0, state.stepTimeRemain - 1);
  const gameTimeRemain = Math.max(0, state.gameTimeRemain - 1);
  return {
    next: { ...state, stepTimeRemain, gameTimeRemain },
    timeout: stepTimeRemain <= 0 || gameTimeRemain <= 0,
  };
}

/** 格式化 mm:ss */
export function formatClock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
