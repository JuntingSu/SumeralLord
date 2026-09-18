// M3 验证 v2：确定性 + m vs 规则AI + m vs m（详细日志，实时落盘）
// 用法：LOG_FILE=train/data/verify.log GAMES=4 MM=2 SIMS=40 npx tsx train/scripts/verify-mcts.ts
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initState, applyIntent } from '@dl/shared';
import type { MapFullData, SeatAssignment, PlayerIntent, GameState } from '@dl/shared';
import { generateTrainMap } from '../lib/mapgen.js';
import { rulePolicy, scoreFor, withSeed } from '../lib/game.js';
import { chooseMove } from '../lib/mcts.js';
import type { MctsConfig } from '../lib/mcts.js';
import type { Policy } from '../lib/game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = process.env.LOG_FILE ?? path.join(__dirname, '..', 'data', 'verify.log');
const GAMES = parseInt(process.env.GAMES ?? '4', 10);
const MM = parseInt(process.env.MM ?? '2', 10);
const SIMS = parseInt(process.env.SIMS ?? '40', 10);
const PROGRESS_EVERY = parseInt(process.env.PROGRESS_EVERY ?? '50', 10);
mkdirSync(path.dirname(LOG_FILE), { recursive: true });

function log(msg: string): void {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  appendFileSync(LOG_FILE, line + '\n');
}

function cfgOf(map: MapFullData): MctsConfig {
  return {
    simsPerMove: SIMS,
    explorationC: 1.0,
    cStronghold: parseFloat(process.env.C_SH ?? '0.1'),
    damageCoeff: parseFloat(process.env.DAMAGE_D ?? '0.001'),
    stuckPenalty: parseFloat(process.env.STUCK_Q ?? '0.002'),
    terminalScale: 5,
    rolloutRounds: 8,
    turnCap: 5 * map.row * map.column, // 临时 c_cap=5，M5 标定
    b: 0.5,
  };
}

function mctsPolicy(cfg: MctsConfig): Policy {
  return (state, seat, aiSeed) => chooseMove(state, cfg, aiSeed);
}

function seatAssignmentsFor(map: MapFullData): SeatAssignment[] {
  return map.player_list.map((p) => ({ seat: p.seat, playerId: null, isAI: true, computer: 1, name: p.name }));
}

function sameIntent(a: PlayerIntent, b: PlayerIntent): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface GameStats {
  state: GameState;
  mPlies: number;
  rPlies: number;
  mMoveMs: number[]; // 采样 m 每步耗时
  plies: number;
  turns: number;
  finished: boolean;
  truncated: boolean;
  winningTeam: number | null;
  ms: number;
}

/** 手工驱动一局（逐步进度日志 + 计时采样） */
function playDetailed(
  map: MapFullData,
  policies: Record<number, Policy>,
  aiSeeds: Record<number, string>,
  tag: string,
): GameStats {
  const cfg = cfgOf(map);
  const asg = seatAssignmentsFor(map);
  let st = initState({
    map,
    seatAssignments: asg,
    seed: 'verify',
    timeSettings: { stepTime: 60, gameTime: 600, additionalTime: 0 },
    allowAiOnly: true,
  }).state;
  const stats: GameStats = { state: st, mPlies: 0, rPlies: 0, mMoveMs: [], plies: 0, turns: 0, finished: false, truncated: false, winningTeam: null, ms: 0 };
  const t0 = performance.now();
  const maxPlies = 5000;
  for (let ply = 0; ply < maxPlies; ply++) {
    if (st.finished) break;
    if (cfg.turnCap > 0 && st.turn > cfg.turnCap) break;
    const seat = st.currentSeat;
    const tMove = performance.now();
    let intent: PlayerIntent;
    if (seat === 1) {
      intent = policies[1](withSeed(st, aiSeeds[1]), seat, aiSeeds[1]);
      stats.mPlies++;
      if (stats.mMoveMs.length < 5 || ply % 50 === 0) stats.mMoveMs.push(performance.now() - tMove);
    } else {
      intent = policies[2](withSeed(st, aiSeeds[2]), seat, aiSeeds[2]);
      stats.rPlies++;
    }
    const r = applyIntent(st, { actor: { kind: 'PLAYER', seat }, intent });
    if (r.ok) st = r.state;
    else {
      const s = applyIntent(st, { actor: { kind: 'PLAYER', seat }, intent: { intentType: 'SWITCH_PHASE' } });
      if (!s.ok) {
        log(`[${tag}] ply=${ply} 无法推进，异常结束`);
        break;
      }
      st = s.state;
    }
    stats.plies = ply + 1;
    stats.turns = st.turn;
    if (ply % PROGRESS_EVERY === 0) {
      const str = (s: number) => st.tiles.filter((t) => t.soldier?.owner === s).reduce((a, t) => a + t.soldier!.strength, 0);
      const sh = (s: number) => st.tiles.filter((t) => t.soldier?.owner === s && t.terrain === 1).length;
      log(`[${tag}] ply=${ply} turn=${st.turn} seat${seat} phase=${st.phase} S1=${str(1)}/${sh(1)} S2=${str(2)}/${sh(2)} 耗时=${((performance.now() - t0) / 1000).toFixed(0)}s`);
    }
  }
  stats.ms = performance.now() - t0;
  stats.finished = st.finished;
  stats.truncated = !st.finished && cfg.turnCap > 0 && st.turn > cfg.turnCap;
  stats.winningTeam = st.finished ? st.winningTeam : null;
  stats.state = st;
  return stats;
}

log(`== M3 验证 v2 开始 GAMES=${GAMES} MM=${MM} SIMS=${SIMS} ==`);

// 1) 确定性
const detMap = generateTrainMap('det-test');
const detState = initState({
  map: detMap,
  seatAssignments: seatAssignmentsFor(detMap),
  seed: 'det-game',
  timeSettings: { stepTime: 60, gameTime: 600, additionalTime: 0 },
  allowAiOnly: true,
}).state;
const d1 = chooseMove(detState, cfgOf(detMap), 'ai1');
const d2 = chooseMove(detState, cfgOf(detMap), 'ai1');
log(`[1] 确定性：${sameIntent(d1, d2) ? 'OK' : 'FAIL'} (${JSON.stringify(d1)})`);

// 2) m vs 规则 AI
let mWins = 0;
let mTrunc = 0;
let mFinished = 0;
let sumMs = 0;
for (let i = 0; i < GAMES; i++) {
  const map = generateTrainMap(`verify-m-${i}`);
  const cfg = cfgOf(map);
  const mSeat = i % 2 === 0 ? 1 : 2;
  const policies: Record<number, Policy> = {
    1: mSeat === 1 ? mctsPolicy(cfg) : rulePolicy,
    2: mSeat === 2 ? mctsPolicy(cfg) : rulePolicy,
  };
  const aiSeeds = { 1: `vm-${i}-a`, 2: `vm-${i}-b` };
  const tag = `m-vs-rule#${i}(m座${mSeat})`;
  const s = playDetailed(map, policies, aiSeeds, tag);
  sumMs += s.ms;
  const score = scoreFor(s, mSeat, 0.5);
  if (s.finished) {
    mFinished++;
    if (s.winningTeam === mSeat) mWins++;
  } else if (s.truncated) mTrunc++;
  const moveMs = s.mMoveMs.length ? (s.mMoveMs.reduce((a, b) => a + b, 0) / s.mMoveMs.length).toFixed(0) : '-';
  log(`[2] ${tag} 结果=${s.finished ? `终局胜队${s.winningTeam}` : s.truncated ? '截断' : '异常'} 回合=${s.turns} 步=${s.plies} m步=${s.mPlies} 规则步=${s.rPlies} m均步时=${moveMs}ms 总耗时=${(s.ms / 1000).toFixed(0)}s m分=${score.toFixed(2)}`);
}
log(`[2] m vs 规则AI 汇总：${GAMES} 局 终局=${mFinished} 截断=${mTrunc} m胜=${mWins} 平均耗时=${(sumMs / GAMES / 1000).toFixed(0)}s`);

// 3) m vs m
if (MM > 0) {
  let mmFinished = 0;
  let mmTrunc = 0;
  let mmMs = 0;
  for (let i = 0; i < MM; i++) {
    const map = generateTrainMap(`verify-mm-${i}`);
    const cfg = cfgOf(map);
    const p = mctsPolicy(cfg);
    const s = playDetailed(map, { 1: p, 2: p }, { 1: `vmm-${i}-a`, 2: `vmm-${i}-b` }, `m-vs-m#${i}`);
    mmMs += s.ms;
    if (s.finished) {
      mmFinished++;
      log(`[3] m-vs-m#${i} 终局胜队${s.winningTeam} 回合=${s.turns} 步=${s.plies} 耗时=${(s.ms / 1000).toFixed(0)}s`);
    } else {
      mmTrunc++;
      log(`[3] m-vs-m#${i} 截断 回合=${s.turns} 步=${s.plies} 耗时=${(s.ms / 1000).toFixed(0)}s`);
    }
  }
  log(`[3] m vs m 汇总：${MM} 局 终局=${mmFinished} 截断=${mmTrunc} 平均耗时=${(mmMs / MM / 1000).toFixed(0)}s`);
}
log('== M3 验证完成 ==');
