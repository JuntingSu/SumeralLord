// sampler.ts — 偏好题抽样器（决策定稿 §9 偏好通道，修订版 §三）
// 局面题：同图（mapId）两局、同视角座次的回合末局面两两配对，近回合优先，局面哈希种子确定性 + 去重。
// 走法题：决策点跑当前模型 MCTS（argmax），A = 访问数第一、B = 访问数第二（有区分度）。
import { hashGameState } from '@dl/shared';
import type { GameState, PlayerIntent } from '@dl/shared';
import { actionToIntent } from './actions.js';
import { collectTurnEnds, getLogIndex, loadLog, replayTo, type ParsedLog, type TurnEndPosition } from './logs.js';
import { mctsDecide } from './mcts.js';
import type { NeuralNet } from './nn.js';

export interface QuestionRef {
  sourceGameId: string;
  eventId: number;
  seat: number;
}

export type Question =
  | { kind: 'position'; a: QuestionRef; b: QuestionRef }
  | { kind: 'action'; sourceGameId: string; eventId: number; seat: number; actionA: PlayerIntent; actionB: PlayerIntent };

export interface SampleOptions {
  numPositionQuestions: number;
  numActionQuestions: number;
  /** 每个局面最多被抽中的次数（去重防刷屏，默认 3） */
  maxDrawsPerPosition?: number;
  /** 局面题近回合优先的回合差上限（默认 2），数据不足再放宽 */
  maxTurnGap?: number;
  /** 走法题 MCTS 模拟数（默认 100） */
  actionSims?: number;
}

/** 由局面哈希字符串派生确定性 RNG（mulberry32 式） */
function hashRng(hash: string): () => number {
  let h = 0;
  for (let i = 0; i < hash.length; i++) h = (Math.imul(h, 31) + hash.charCodeAt(i)) >>> 0;
  let a = h || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 抽样全部局面题（确定性：配对顺序由局面哈希种子的 RNG 决定） */
export function samplePositionQuestions(
  logs: ParsedLog[],
  opts: SampleOptions,
): Question[] {
  const maxDraws = opts.maxDrawsPerPosition ?? 3;
  const maxGap = opts.maxTurnGap ?? 2;

  // 按 (mapId, seat) 分组回合末局面
  const groups = new Map<string, TurnEndPosition[]>();
  for (const log of logs) {
    for (const te of collectTurnEnds(log)) {
      const key = `${log.mapId}|${te.seat}`;
      const arr = groups.get(key) ?? [];
      arr.push(te);
      groups.set(key, arr);
    }
  }

  const drawCount = new Map<string, number>();
  const canDraw = (te: TurnEndPosition): boolean =>
    (drawCount.get(hashGameState(te.state)) ?? 0) < maxDraws;

  const out: Question[] = [];
  // 按 (mapId, seat) 确定顺序，组内按回合排序后做近回合配对
  const keys = [...groups.keys()].sort();
  for (const key of keys) {
    if (out.length >= opts.numPositionQuestions) break;
    const positions = groups.get(key)!.sort((a, b) => a.turn - b.turn);
    const used = new Set<TurnEndPosition>();
    // 优先近回合（|turn 差| ≤ maxGap），数据不足时放宽到任意配对
    for (const gap of [maxGap, Infinity]) {
      for (let i = 0; i < positions.length && out.length < opts.numPositionQuestions; i++) {
        const a = positions[i];
        if (used.has(a) || !canDraw(a)) continue;
        for (let j = i + 1; j < positions.length; j++) {
          const b = positions[j];
          if (used.has(b) || !canDraw(b)) continue;
          if (Math.abs(a.turn - b.turn) > gap) continue;
          used.add(a);
          used.add(b);
          for (const te of [a, b]) {
            const h = hashGameState(te.state);
            drawCount.set(h, (drawCount.get(h) ?? 0) + 1);
          }
          out.push({
            kind: 'position',
            a: { sourceGameId: a.gameId, eventId: a.eventId, seat: a.seat },
            b: { sourceGameId: b.gameId, eventId: b.eventId, seat: b.seat },
          });
          break;
        }
      }
      if (out.length >= opts.numPositionQuestions) break;
    }
  }
  return out;
}

/** 抽样全部走法题（A = MCTS 访问数第一，B = 第二；确定性取决于模型与局面） */
export async function sampleActionQuestions(
  logs: ParsedLog[],
  net: NeuralNet,
  opts: SampleOptions,
): Promise<Question[]> {
  const maxDraws = opts.maxDrawsPerPosition ?? 3;
  const sims = opts.actionSims ?? 100;

  // 位置池 = 各局回合末局面（即下一行动方的决策点），按局面哈希种子洗牌
  const pool: TurnEndPosition[] = [];
  for (const log of logs) {
    for (const te of collectTurnEnds(log)) pool.push(te);
  }
  const rngFor = (te: TurnEndPosition) => hashRng(hashGameState(te.state));
  const ordered = shuffle(pool, hashRng(pool.map((p) => hashGameState(p.state)).join('')));

  const drawCount = new Map<string, number>();
  const out: Question[] = [];
  for (const te of ordered) {
    if (out.length >= opts.numActionQuestions) break;
    const h = hashGameState(te.state);
    if ((drawCount.get(h) ?? 0) >= maxDraws) continue;
    const state = replayTo(logFor(te, logs), te.eventId);
    if (state.finished || (state.phase !== 'ACTION' && state.phase !== 'ADD_POINT')) continue;
    const r = await mctsDecide(state, net, { simulations: sims });
    if (r.visits.size < 2) continue;
    // A = 访问数第一，B = 访问数第二（保证区分度）
    const ranked = [...r.visits.entries()].sort((x, y) => y[1] - x[1]);
    const [aIdx, bIdx] = [ranked[0][0], ranked[1][0]];
    if (bIdx === undefined || ranked[1][1] < 1) continue;
    drawCount.set(h, (drawCount.get(h) ?? 0) + 1);
    out.push({
      kind: 'action',
      sourceGameId: te.gameId,
      eventId: te.eventId,
      seat: state.currentSeat,
      actionA: actionToIntent(state, aIdx),
      actionB: actionToIntent(state, bIdx),
    });
  }
  return out;
}

function logFor(te: TurnEndPosition, logs: ParsedLog[]): ParsedLog {
  return logs.find((l) => l.gameId === te.gameId)!;
}

/** 加载全部日志（跨 round 目录） */
export function loadAllLogs(): ParsedLog[] {
  const out: ParsedLog[] = [];
  const idx = getLogIndex();
  for (const gameId of [...idx.keys()].sort()) {
    const log = loadLog(gameId);
    if (log) out.push(log);
  }
  return out;
}
