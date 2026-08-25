// 积分结算（0 和制 + 获胜者保底）：VICTORY 共识确认时统一结算，规则见《数字领主-积分统计与排行榜设计方案.md》§1.1/§3.1
// 拆「纯函数 + 编排函数」两层：computeScoreChanges 可脱离 DB 单测
import { eq, inArray } from 'drizzle-orm';
import { matchHistory, users, type NewUserRow } from '../db/schema.js';
import type { Db } from '../db/client.js';
import type { Game, GameManager } from '../game/manager.js';

/** 结算输入（结算时刻快照，同一时刻一次算定） */
export interface SettlePlayerInput {
  playerId: number;
  /** 结算前积分快照 */
  score: number;
  /** winners 集合中（VICTORY payload.winners 字符串数组） */
  isWinner: boolean;
  /** 结算时刻 connected === false（断线未重连） */
  offline: boolean;
}

export interface ScoreChange {
  playerId: number;
  /** 实际结算结果：中途离线者即使队伍获胜也为 lose（见 offline 标记） */
  result: 'win' | 'lose';
  offline: boolean;
  oldScore: number;
  /** 一位小数 */
  delta: number;
  /** max(0, round1(...))，一位小数 */
  newScore: number;
}

/** 一位小数：Math.round(x * 10) / 10 */
export function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/**
 * 0 和制结算纯函数：
 * - S = 全员积分和（一次快照）；S <= 0 → 全员 delta = 0（防除零）
 * - pay_i = round1(-20 * score_i / S)（全员支付总额恒 -20）
 * - W = { isWinner && !offline }（结算时在线的获胜方）；W 为空 → 视同平局不结算
 * - 剩余积分池 remaining = 战败方与离线获胜者的支付总和（恒 ≥ 0）
 * - 获胜者按 omega = 1/(score+100) 归一化分配，并保底 delta = max(5, delta)（超出部分系统注入）
 * - 战败方/离线获胜者：delta = pay（只支付不获得）
 */
export function computeScoreChanges(players: SettlePlayerInput[]): ScoreChange[] {
  const S = players.reduce((sum, p) => sum + p.score, 0);
  const zeroChanges = (): ScoreChange[] =>
    players.map((p) => ({
      playerId: p.playerId,
      result: 'lose',
      offline: p.offline,
      oldScore: p.score,
      delta: 0,
      newScore: p.score,
    }));

  if (S <= 0) return zeroChanges();

  const pay = new Map<number, number>();
  for (const p of players) pay.set(p.playerId, round1((-20 * p.score) / S));

  const W = players.filter((p) => p.isWinner && !p.offline);
  // 防御：无在线获胜者（正常 VICTORY 下必有一名在线获胜者上报共识，不应触发）
  if (W.length === 0) return zeroChanges();

  const omegaSum = W.reduce((sum, w) => sum + 1 / (w.score + 100), 0);
  const remaining = players
    .filter((p) => !(p.isWinner && !p.offline))
    .reduce((sum, p) => sum + -(pay.get(p.playerId) ?? 0), 0);

  return players.map((p) => {
    if (p.isWinner && !p.offline) {
      const omega = 1 / (p.score + 100);
      // 保底：不足 5 分按 5 分计（超出部分系统注入，不改其他玩家支付）
      const delta = Math.max(5, round1((remaining * omega) / omegaSum));
      return {
        playerId: p.playerId,
        result: 'win' as const,
        offline: p.offline,
        oldScore: p.score,
        delta,
        newScore: Math.max(0, round1(p.score + delta)),
      };
    }
    const delta = pay.get(p.playerId) ?? 0;
    return {
      playerId: p.playerId,
      result: 'lose' as const,
      offline: p.offline,
      oldScore: p.score,
      delta,
      newScore: Math.max(0, round1(p.score + delta)),
    };
  });
}

export interface SettlementResult {
  scoreChanges: ScoreChange[];
  steps: number;
  matchCounted: boolean;
}

/**
 * 编排：读结算时刻积分快照 → 算结算明细 → 回填 score_changes + 更新积分/对局数（同一事务）。
 * 对局数口径与积分独立：steps > 25 才 +1（含离线者、含平局）；观战者/AI 不计入。
 */
export function settleMatch(
  db: Db,
  games: GameManager,
  game: Game,
  winners: string[],
): SettlementResult | null {
  // 真人参战者（playerId !== null && !isAI；观战者/AI 无账号不计入）
  const seats = [...game.participants.entries()].filter(([, p]) => p.playerId !== null && !p.isAI);
  if (seats.length === 0) return null;
  const winnerIds = new Set(winners);
  const playerIds = seats.map(([, p]) => p.playerId as number);

  // 结算时刻同一份快照一次算定（避免顺序更新导致分母漂移）
  const rows = db.select().from(users).where(inArray(users.id, playerIds)).all();
  const rowById = new Map(rows.map((r) => [r.id, r]));

  const players: SettlePlayerInput[] = seats.map(([, p]) => ({
    playerId: p.playerId as number,
    score: rowById.get(p.playerId as number)?.score ?? 0,
    isWinner: winnerIds.has(String(p.playerId)),
    offline: !p.connected,
  }));

  // 平局（winners 为空）→ 不结算积分，score_changes = []；对局数照常按步数口径
  const scoreChanges = winners.length === 0 ? [] : computeScoreChanges(players);

  const steps = games.countReplaySteps(game);
  const matchCounted = steps > 25;

  // 回填与更新同事务：失败整体回滚，避免「对局数加了但积分没写」半截状态
  db.transaction((tx) => {
    tx.update(matchHistory)
      .set({ scoreChanges: JSON.stringify(scoreChanges) })
      .where(eq(matchHistory.gameId, game.id))
      .run();
    const byId = new Map(scoreChanges.map((c) => [c.playerId, c]));
    for (const playerId of playerIds) {
      const row = rowById.get(playerId);
      const values: Partial<NewUserRow> = {
        matches: (row?.matches ?? 0) + (matchCounted ? 1 : 0),
      };
      const change = byId.get(playerId);
      if (change) values.score = change.newScore;
      tx.update(users).set(values).where(eq(users.id, playerId)).run();
    }
  });

  return { scoreChanges, steps, matchCounted };
}
