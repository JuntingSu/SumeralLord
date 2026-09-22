// logs.ts — 对局日志基础设施（Node 侧）：按 gameId 索引 / 加载 / 重放 / 回合末局面采集
// 浏览器侧（判题工作台）使用 lib/logparse.ts（无 node 依赖）。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { applyIntent, initState } from '@dl/shared';
import type { GameStartMsg, GameState } from '@dl/shared';
import { parseLogText, replayLog, type ReplayIntent } from './logparse.js';
import { LOGS_DIR } from './paths.js';

export type { ReplayIntent } from './logparse.js';

export interface ParsedLog {
  gameId: string;
  mapId: string;
  start: GameStartMsg;
  intents: ReplayIntent[];
}

/** 日志索引：gameId → 日志文件（跨 round 目录扫描，进程内缓存 + mtime 失效） */
const indexCache = new Map<string, { file: string; mtimeMs: number }[]>();
let indexBuiltFor = '';

export function buildLogIndex(): Map<string, { file: string; mtimeMs: number }> {
  const out = new Map<string, { file: string; mtimeMs: number }>();
  if (!existsSync(LOGS_DIR)) return out;
  for (const roundDir of readdirSync(LOGS_DIR)) {
    const dir = path.join(LOGS_DIR, roundDir);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue; // 早期松散 jsonl 文件跳过
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(dir, f);
      try {
        const first = readFileSync(file, 'utf8').split('\n').find((l) => l.trim());
        if (!first) continue;
        const msg = JSON.parse(first) as { type?: string; gameId?: string };
        if (msg.type === 'GAME_START' && typeof msg.gameId === 'string') {
          out.set(msg.gameId, { file, mtimeMs: 0 });
        }
      } catch {
        /* 坏文件跳过 */
      }
    }
  }
  return out;
}

let logIndex: Map<string, { file: string; mtimeMs: number }> | null = null;
let logIndexRoundDirs = '';

/** 获取 gameId → 日志文件 索引（round 目录集合变化时重建） */
export function getLogIndex(): Map<string, { file: string; mtimeMs: number }> {
  const dirs = existsSync(LOGS_DIR) ? readdirSync(LOGS_DIR).sort().join(',') : '';
  if (!logIndex || logIndexRoundDirs !== dirs) {
    logIndex = buildLogIndex();
    logIndexRoundDirs = dirs;
  }
  return logIndex;
}

/** 按 gameId 读取并解析日志；不存在返回 null */
export function loadLog(gameId: string): ParsedLog | null {
  const idx = getLogIndex();
  const hit = idx.get(gameId);
  if (!hit) return null;
  const text = readFileSync(hit.file, 'utf8');
  const parsed = parseLogText(text);
  if (!parsed) return null;
  const start = parsed.start;
  return {
    gameId,
    mapId: start.map.id ?? '',
    start,
    intents: parsed.intents,
  };
}

/** 重放到第 n 条意图（含），返回静止局面；n 越界裁剪 */
export function replayTo(log: ParsedLog, n: number): GameState {
  return replayLog(log.start, log.intents, n);
}

/** 回合末局面：某座次完成自己回合后的静止局面（下一行动方已切换至其 ACTION 相位），
 *  视角 = 该座次（价值换算由训练侧按行动方处理）。 */
export interface TurnEndPosition {
  gameId: string;
  eventId: number;
  seat: number;
  turn: number;
  state: GameState;
}

/** 重放一遍并采集全部回合末局面（首回合起始不采集；终结对局不采集） */
export function collectTurnEnds(log: ParsedLog): TurnEndPosition[] {
  const out: TurnEndPosition[] = [];
  const start = log.start;
  let state = initState({
    map: start.map,
    seatAssignments: start.seatAssignments,
    timeSettings: start.timeSettings,
    seed: start.seed,
  }).state;
  for (let i = 0; i < log.intents.length; i++) {
    const item = log.intents[i];
    const prevSeat = state.currentSeat;
    const prevTurn = state.turn;
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: item.fromSeat }, intent: item.intent });
    if (!r.ok) continue;
    const next = r.state;
    if (!next.finished && next.phase === 'ACTION' && next.currentSeat !== prevSeat) {
      // prevSeat 刚结束回合：采集其回合末局面（下一行动方已就位）
      out.push({ gameId: log.gameId, eventId: i + 1, seat: prevSeat, turn: prevTurn, state: next });
    }
    state = next;
  }
  return out;
}
