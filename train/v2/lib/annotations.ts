// annotations.ts — 标注文件加载与转换（示范/纠错 → demo-samples；偏好 → pref-samples）
// 规则/编码全部在 TS 侧：标注只存引用（gameId + eventId + seat + intents），转换时从日志重放。
import { applyIntent } from '@dl/shared';
import type { GameState, PlayerIntent } from '@dl/shared';
import { actionToIntent, intentToAction, legalActionList } from './actions.js';
import type { DemoFile, DemoSample, PrefFile, PrefSample } from './annotation-types.js';
import { encodeState } from './encode.js';
import { replayTo, type ParsedLog } from './logs.js';

export type { DemoFile, DemoSample, PrefFile, PrefSample } from './annotation-types.js';

/** 编码一个局面（当前行动方相对视角），供偏好样本复用 */
function encodeSide(state: GameState, perspectiveSeat: number): PrefSample['a'] {
  const enc = encodeState(state);
  return { cls: enc.cls, tiles: enc.tiles, rows: state.rows, columns: state.columns, seat: perspectiveSeat };
}

/**
 * 示范/纠错 → 训练样本（每步一条，π = 人类动作 one-hot）。
 * ADD_POINT 金额 > 32 拆分为多个 ≤32 的步骤；任意意图被拒/映射失败 → 返回 null（整条跳过并警告由调用方打）。
 */
export function demoToSamples(demo: DemoFile, log: ParsedLog): DemoSample[] | null {
  let state = replayTo(log, demo.startEventId);
  const out: DemoSample[] = [];
  for (const intent of demo.intents) {
    // 拆分 ADD_POINT 金额
    const intents: PlayerIntent[] =
      intent.intentType === 'ADD_POINT' && intent.amount > 32
        ? Array.from({ length: Math.ceil(intent.amount / 32) }, (_, i) => ({
            intentType: 'ADD_POINT' as const,
            coordinate: intent.coordinate,
            amount: Math.min(32, intent.amount - i * 32),
          }))
        : [intent];
    for (const it of intents) {
      if (state.currentSeat !== demo.seat) return null; // 演示越出己方回合：不一致，跳过
      const actionIdx = intentToAction(state, it);
      if (actionIdx === null) return null;
      const legal = legalActionList(state);
      const pos = legal.indexOf(actionIdx);
      if (pos < 0) return null; // 人类动作不在合法集（理论上 viewer 已验证；防御）
      const enc = encodeState(state);
      const pi: [number, number][] = legal.map((idx, i) => [idx, i === pos ? 1 : 0]);
      out.push({
        gameId: demo.id,
        mapId: log.mapId,
        turn: state.turn,
        seat: demo.seat,
        phase: state.phase,
        nTiles: state.tiles.length,
        rows: state.rows,
        columns: state.columns,
        cls: enc.cls,
        tiles: enc.tiles,
        pi,
        z: 0,
      });
      const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: demo.seat }, intent: it });
      if (!r.ok) return null;
      state = r.state;
    }
  }
  return out.length > 0 ? out : null;
}

/** 偏好（局面题）→ 偏好样本 */
export function positionPrefToSample(pref: Extract<PrefFile, { kind: 'position' }>, logA: ParsedLog, logB: ParsedLog): PrefSample | null {
  if (pref.label === 'unknown') return null;
  const sa = replayTo(logA, pref.a.eventId);
  const sb = replayTo(logB, pref.b.eventId);
  return {
    id: pref.id,
    label: pref.label,
    a: encodeSide(sa, pref.a.seat),
    b: encodeSide(sb, pref.b.seat),
  };
}

/** 偏好（走法题）→ 偏好样本（apply A/B 得后继局面，视角 = 位置行动方） */
export function actionPrefToSample(pref: Extract<PrefFile, { kind: 'action' }>, log: ParsedLog): PrefSample | null {
  if (pref.label === 'unknown') return null;
  const base = replayTo(log, pref.eventId);
  const seat = base.currentSeat;
  const ra = applyIntent(base, { actor: { kind: 'PLAYER', seat }, intent: pref.actionA });
  const rb = applyIntent(base, { actor: { kind: 'PLAYER', seat }, intent: pref.actionB });
  if (!ra.ok || !rb.ok) return null;
  return {
    id: pref.id,
    label: pref.label,
    a: encodeSide(ra.state, seat),
    b: encodeSide(rb.state, seat),
  };
}

/** 将偏好文件转换为偏好样本（需日志；任一侧缺失/重放失败 → null） */
export function prefToSample(pref: PrefFile, logs: Map<string, ParsedLog>): PrefSample | null {
  if (pref.kind === 'position') {
    const la = logs.get(pref.a.sourceGameId);
    const lb = logs.get(pref.b.sourceGameId);
    if (!la || !lb) return null;
    return positionPrefToSample(pref, la, lb);
  }
  const log = logs.get(pref.sourceGameId);
  if (!log) return null;
  return actionPrefToSample(pref, log);
}
