// demos.ts — 人工示范注入训练：加载 train/demos/*.json → 按 sourceGameId 定位源对局日志 →
// 重放至演示起点并应用用户 intents → 构造 200 倍权重的 E_te 胜样本（模仿用户偏好的局面）。
// 容错：日志缺失 / 重放不一致 / 意图被拒 → 返回 null，调用方跳过并警告，不影响训练。
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { applyIntent, initState } from '@dl/shared';
import type { GameStartMsg, GameState, PlayerIntent } from '@dl/shared';
import { teFeatures } from './features.js';
import { isLatePhase } from './eval.js';
import type { TrainSample } from './driver.js';
import { LOGS_DIR } from './paths.js';

/** 示范样本学习权重（200 倍；见修改技术文档 §5.2） */
export const DEMO_WEIGHT = 200;

export interface DemoFile {
  id: string;
  createdAt: string;
  sourceGameId: string;
  seat: number;
  turnStartEventId: number;
  startEventId: number;
  positionHash?: string;
  intents: PlayerIntent[];
  note?: string;
}

interface ParsedLog {
  start: GameStartMsg;
  intents: Array<{ intent: PlayerIntent; fromSeat: number }>;
}

/** 解析源对局日志（同 replay-viewer 规则）：首行 GAME_START + 其余行意图流，坏行跳过 */
function parseLogFile(text: string): ParsedLog | null {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  let start: GameStartMsg | null = null;
  const intents: ParsedLog['intents'] = [];
  lines.forEach((line, i) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 坏行跳过
    }
    if (i === 0) {
      if (msg.type === 'GAME_START') start = msg as unknown as GameStartMsg;
      return;
    }
    const m = msg as { type?: string; intent?: PlayerIntent; fromSeat?: number };
    if (m.type === 'INTENT_BROADCAST' && m.intent && typeof m.fromSeat === 'number') {
      intents.push({ intent: m.intent, fromSeat: m.fromSeat });
    }
  });
  return start ? { start, intents } : null;
}

// 源日志索引：logsDir → (gameId → 文件 + mtime)。mtime 变化或文件缺失时按需重建，避免每次拟合全量重扫。
const logIndexCache = new Map<string, Map<string, { file: string; mtimeMs: number }>>();

function buildLogIndex(logsDir: string): Map<string, { file: string; mtimeMs: number }> {
  const idx = new Map<string, { file: string; mtimeMs: number }>();
  if (existsSync(logsDir)) {
    for (const f of readdirSync(logsDir)) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(logsDir, f);
      try {
        const first = readFileSync(file, 'utf8').split('\n').find((l) => l.trim());
        if (!first) continue;
        const msg = JSON.parse(first) as { type?: string; gameId?: string };
        if (msg.type === 'GAME_START' && typeof msg.gameId === 'string') {
          idx.set(msg.gameId, { file, mtimeMs: statSync(file).mtimeMs });
        }
      } catch {
        /* 坏文件跳过 */
      }
    }
  }
  logIndexCache.set(logsDir, idx);
  return idx;
}

/** 按 gameId 定位源日志文件（进程内缓存，mtime 不符则重建索引）；未找到返回 null */
function locateLog(gameId: string, logsDir: string): string | null {
  let idx = logIndexCache.get(logsDir);
  if (!idx) idx = buildLogIndex(logsDir);
  const hit = idx.get(gameId);
  if (hit) {
    try {
      if (statSync(hit.file).mtimeMs === hit.mtimeMs) return hit.file;
    } catch {
      /* 文件被删 → 重建 */
    }
  }
  idx = buildLogIndex(logsDir);
  return idx.get(gameId)?.file ?? null;
}

function warn(msg: string): void {
  console.warn(`[demos] ${msg}`);
}

/** 从日志首行解析起始状态 */
function initFromLog(parsed: ParsedLog): GameState {
  const { start } = parsed;
  return initState({
    map: start.map,
    seatAssignments: start.seatAssignments,
    timeSettings: start.timeSettings,
    seed: start.seed,
  }).state;
}

/** 重放到第 n 条意图（0..n-1）后的局面 */
function replayTo(init: GameState, parsed: ParsedLog, n: number): GameState {
  let cur = init;
  const k = Math.max(0, Math.min(n, parsed.intents.length));
  for (let i = 0; i < k; i++) {
    const r = applyIntent(cur, {
      actor: { kind: 'PLAYER', seat: parsed.intents[i].fromSeat },
      intent: parsed.intents[i].intent,
    });
    if (r.ok) cur = r.state;
  }
  return cur;
}

/** 读取示范目录（字段校验，非法文件警告跳过；目录不存在返回空数组） */
export function loadDemos(dir: string): DemoFile[] {
  if (!existsSync(dir)) return [];
  const out: DemoFile[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as Partial<DemoFile>;
      if (
        typeof d.id === 'string' &&
        typeof d.sourceGameId === 'string' &&
        typeof d.seat === 'number' &&
        typeof d.turnStartEventId === 'number' &&
        typeof d.startEventId === 'number' &&
        Array.isArray(d.intents)
      ) {
        out.push(d as DemoFile);
      } else {
        warn(`跳过非法示范文件 ${f}（字段缺失或类型不符）`);
      }
    } catch {
      warn(`跳过无法解析的示范文件 ${f}`);
    }
  }
  return out;
}

/** 示范 → 训练样本。任一环节不一致（源日志缺失/回合初相位不符/意图被拒）→ null，调用方跳过并警告。 */
export function demoToSample(demo: DemoFile, logsDir: string = LOGS_DIR): TrainSample | null {
  const file = locateLog(demo.sourceGameId, logsDir);
  if (!file) {
    warn(`示范 ${demo.id}：源对局日志 ${demo.sourceGameId} 缺失，跳过`);
    return null;
  }
  let parsed: ParsedLog | null;
  try {
    parsed = parseLogFile(readFileSync(file, 'utf8'));
  } catch {
    parsed = null;
  }
  if (!parsed) {
    warn(`示范 ${demo.id}：源对局日志 ${file} 解析失败，跳过`);
    return null;
  }
  const init = initFromLog(parsed);

  // 回合初局面（E_te 双快照之一）：重放到 turnStartEventId 后必须是该势力的 ACTION 相位
  const turnStart = replayTo(init, parsed, demo.turnStartEventId);
  if (turnStart.phase !== 'ACTION' || turnStart.currentSeat !== demo.seat) {
    warn(`示范 ${demo.id}：回合初局面不一致（turnStartEventId=${demo.turnStartEventId} 不在 ${demo.seat} 号势力 ACTION 相位），跳过`);
    return null;
  }
  // 演示起点局面：须在该势力的回合内（ACTION 或 ADD_POINT 相位）
  const startState = replayTo(init, parsed, demo.startEventId);
  if (startState.currentSeat !== demo.seat || (startState.phase !== 'ACTION' && startState.phase !== 'ADD_POINT')) {
    warn(`示范 ${demo.id}：演示起点局面不一致（startEventId=${demo.startEventId} 不在 ${demo.seat} 号势力回合内），跳过`);
    return null;
  }

  // 逐条应用用户 intents（viewer 已保证合法，此处为兜底一致性校验）
  let cur = startState;
  for (const intent of demo.intents) {
    const r = applyIntent(cur, { actor: { kind: 'PLAYER', seat: demo.seat }, intent });
    if (!r.ok) {
      warn(`示范 ${demo.id}：意图 ${intent.intentType} 被拒绝（${r.reason}），整个示范跳过`);
      return null;
    }
    cur = r.state;
  }

  return {
    gameId: demo.id,
    mapId: parsed.start.map.id ?? 'unknown',
    seat: demo.seat,
    turn: cur.turn,
    area: parsed.start.map.row * parsed.start.map.column,
    late: isLatePhase(cur),
    features: teFeatures(cur, turnStart, demo.seat),
    dToEnd: 1,
    label: 1,
    weight: DEMO_WEIGHT,
  };
}
