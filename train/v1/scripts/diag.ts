// diag.ts — 定位卡点：文件直写日志
import { appendFileSync, writeFileSync, rmSync } from 'node:fs';
import { initState } from '@dl/shared';
import type { GameState, PlayerIntent } from '@dl/shared';
import { applyIntent } from '@dl/shared';
import { mctsDecide } from '../lib/mcts.js';
import { SEED_TE_WEIGHTS } from '../lib/eval.js';
import { MapPool } from '../lib/pool.js';
import { MAPS_DIR } from '../lib/paths.js';
import { TIME_SETTINGS } from '../lib/driver.js';

const LOG = 'train/runs/diag.log';
try { rmSync(LOG); } catch {}
const say = (s: string) => appendFileSync(LOG, s + '\n');

say('start');
const pool = new MapPool(MAPS_DIR);
say('pool loaded');
const map = pool.rotate(0);
let state: GameState = initState({
  map,
  seatAssignments: [
    { seat: 1, playerId: 900001, isAI: false },
    { seat: 2, playerId: 900002, isAI: false },
  ],
  seed: 'diag',
  timeSettings: TIME_SETTINGS,
}).state;
say(`init ok turn=${state.turn} seat=${state.currentSeat} phase=${state.phase}`);
let forceTurns = 0;
const t0 = Date.now();
while (!state.finished && state.turn <= 40) {
  const seat = state.currentSeat;
  const td = Date.now();
  const decision = mctsDecide(state, seat, SEED_TE_WEIGHTS, { simulations: 300, mode: 'sample', temperature: 1 });
  const dt = Date.now() - td;
  forceTurns++;
  let applied = 0;
  let rejected = 0;
  for (const intent of [...decision.plan.actionIntents, ...decision.plan.addPointIntents] as PlayerIntent[]) {
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat }, intent });
    if (r.ok) { state = r.state; applied++; } else rejected++;
  }
  say(`ft=${forceTurns} turn=${state.turn} seat=${seat} 决策=${dt}ms 应用=${applied} 拒绝=${rejected} 节点=${decision.nodeCount} 累计=${((Date.now()-t0)/1000).toFixed(1)}s heap=${(process.memoryUsage().heapUsed/1048576).toFixed(0)}MB`);
}
say('done');
