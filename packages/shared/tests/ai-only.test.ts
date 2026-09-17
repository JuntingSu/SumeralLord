// 训练模式补丁（allowAiOnly）：AI-only 对局的轮转放行与判胜放行
// - 默认（allowAiOnly=false）：无存活人类势力时回合轮转冻结、胜负按平局收尾（生产语义不变）
// - 训练模式（allowAiOnly=true）：AI-only 对局正常轮转，由实际胜负收尾
import { describe, it, expect } from 'vitest';
import { applyIntent, initState, planAiTurn } from '../src/index.js';
import { makeMap, assignments, CITY, PLAIN } from './helpers.js';
import type { GameState, MapFullData, PlayerIntent, SeatAssignment } from '../src/index.js';

/** 小地图：seat1 强兵（index 2）紧邻 seat2 据点（index 5），可首回合拿下 */
const tinyMap = (): MapFullData =>
  makeMap({
    rows: 2,
    columns: 3,
    tiles: {
      1: [CITY, 1, 2],
      2: [PLAIN, 1, 6],
      5: [CITY, 2, 2],
    },
  });

const AI_ASG: SeatAssignment[] = assignments({ seat: 1, isAI: true }, { seat: 2, isAI: true });

/** 3 势力 2 队图：seat1(队1) 攻占 seat2(队2) 据点后，seat3(队2) 仍存活 → 多队存活无人类 */
const threeForceMap = (): MapFullData =>
  makeMap({
    rows: 2,
    columns: 4,
    players: [
      { seat: 1, team: 1 },
      { seat: 2, team: 2 },
      { seat: 3, team: 2 },
    ],
    tiles: {
      1: [CITY, 1, 2],
      2: [PLAIN, 1, 6],
      6: [CITY, 2, 2],
      7: [CITY, 3, 2],
    },
  });

const AI_ASG3: SeatAssignment[] = assignments(
  { seat: 1, isAI: true },
  { seat: 2, isAI: true },
  { seat: 3, isAI: true },
);

function startAiOnly(allowAiOnly: boolean): GameState {
  return initState({
    map: tinyMap(),
    seatAssignments: AI_ASG,
    seed: 'ai-only-test',
    timeSettings: { stepTime: 60, gameTime: 600, additionalTime: 0 },
    allowAiOnly,
  }).state;
}

/** 用规则 AI 驱动当前 seat 的完整回合（意图逐条应用），返回应用后的状态 */
function driveTurn(st: GameState): GameState {
  let s = st;
  let guard = 0;
  while (!s.finished && guard++ < 100) {
    const seat = s.currentSeat;
    const plan = planAiTurn(s, seat);
    const intents: PlayerIntent[] =
      plan.kind === 'intents'
        ? plan.intents
        : s.phase === 'ACTION'
          ? [{ intentType: 'SWITCH_PHASE' }, { intentType: 'SWITCH_PHASE' }]
          : [{ intentType: 'SWITCH_PHASE' }];
    if (plan.kind === 'intents' && plan.intents.length === 0) break;
    let done = false;
    for (const intent of intents) {
      const r = applyIntent(s, { actor: { kind: 'PLAYER', seat }, intent });
      if (r.ok) s = r.state;
      if (s.finished) {
        done = true;
        break;
      }
    }
    if (done) break;
    // 回合已结束（进入下一 seat 或冻结 END）
    if (s.currentSeat !== seat || s.phase === 'END') break;
  }
  return s;
}

describe('训练模式 allowAiOnly', () => {
  it('默认关闭：AI-only 对局首回合结束后轮转冻结在 END（生产语义不变）', () => {
    const st0 = startAiOnly(false);
    expect(st0.phase).toBe('ACTION');
    const st = driveTurn(st0);
    expect(st.phase).toBe('END'); // 冻结
    expect(st.currentSeat).toBe(2); // 已指向下一家但无法推进
    expect(st.turn).toBe(1);
    // 再次切换无效（END 不可转出）
    const r = applyIntent(st, { actor: { kind: 'PLAYER', seat: 2 }, intent: { intentType: 'SWITCH_PHASE' } });
    expect(r.state.phase).toBe('END');
  });

  it('训练模式开启：AI-only 对局正常轮转，双方回合交替推进', () => {
    const st0 = startAiOnly(true);
    const st1 = driveTurn(st0);
    // seat1 回合结束 → 轮转到 seat2 的准备/行动（非冻结）
    expect(st1.phase).toBe('ACTION');
    expect(st1.currentSeat).toBe(2);
    const st2 = driveTurn(st1);
    expect(st2.turn).toBeGreaterThanOrEqual(2); // 全局轮次推进
  });

  it('判胜放行：AI-only 下攻占对方据点按实际胜负收尾（不判平）', () => {
    const st0 = startAiOnly(true);
    // seat1 首回合直接用强兵进攻 seat2 据点（index 5）
    const r = applyIntent(st0, { actor: { kind: 'PLAYER', seat: 1 }, intent: { intentType: 'ATTACK', from: 2, to: 5 } });
    expect(r.ok).toBe(true);
    expect(r.state.finished).toBe(true);
    expect(r.state.winningTeam).toBe(1);
  });

  it('默认关闭：攻占最后据点（单队存活）仍按实际胜负判胜，不受影响', () => {
    const st0 = startAiOnly(false);
    const r = applyIntent(st0, { actor: { kind: 'PLAYER', seat: 1 }, intent: { intentType: 'ATTACK', from: 2, to: 5 } });
    expect(r.ok).toBe(true);
    expect(r.state.finished).toBe(true);
    expect(r.state.winningTeam).toBe(1);
  });

  it('默认关闭：多队存活且无人类时按平局收尾（winningTeam=-1，生产语义）', () => {
    const st = initState({
      map: threeForceMap(),
      seatAssignments: AI_ASG3,
      seed: 'ai-only-test',
      timeSettings: { stepTime: 60, gameTime: 600, additionalTime: 0 },
    }).state;
    // seat1 攻占 seat2 据点（index 6）：seat2 被清除，seat3(队2) 仍存活 → 多队无人类
    const r = applyIntent(st, { actor: { kind: 'PLAYER', seat: 1 }, intent: { intentType: 'ATTACK', from: 2, to: 6 } });
    expect(r.ok).toBe(true);
    expect(r.state.finished).toBe(true);
    expect(r.state.winningTeam).toBe(-1);
  });

  it('训练模式开启：多队存活且无人类时对局继续（不判平）', () => {
    const st = initState({
      map: threeForceMap(),
      seatAssignments: AI_ASG3,
      seed: 'ai-only-test',
      timeSettings: { stepTime: 60, gameTime: 600, additionalTime: 0 },
      allowAiOnly: true,
    }).state;
    const r = applyIntent(st, { actor: { kind: 'PLAYER', seat: 1 }, intent: { intentType: 'ATTACK', from: 2, to: 6 } });
    expect(r.ok).toBe(true);
    expect(r.state.finished).toBe(false); // 对局继续
    expect(r.state.forces.find((f) => f.seat === 2)?.alive).toBe(false);
  });
});
