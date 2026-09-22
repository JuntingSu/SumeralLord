// 临时诊断：重放 game-004172.jsonl，在指定事件前输出棋盘
import { readFileSync } from 'node:fs';
import { applyIntent, initState, TERRAIN } from '@dl/shared';
import type { GameState } from '@dl/shared';
import { extractBoard } from '../lib/board.js';

const file = process.argv[2];
const stopAt = Number(process.argv[3] ?? -1); // 事件号（含）之前输出，-1 = 不限制
const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const start = lines.find((o) => o.type === 'GAME_START');
let state = initState({
  map: start.map,
  seatAssignments: start.seatAssignments,
  seed: start.seed,
  timeSettings: start.timeSettings,
}).state;

function dump(state: GameState, label: string, seats: number[]) {
  const b = extractBoard(state);
  const cols = b.geo.columns;
  console.log(`\n===== ${label} (turn=${state.turn}, currentSeat=${state.currentSeat}, phase=${state.phase ?? ''}) =====`);
  for (const s of seats) {
    const f = state.forces.find((x) => x.seat === s);
    console.log(`seat ${s}: alive=${f?.alive} points=${f?.points ?? '-'} strongholds=${f?.strongholdCount ?? '-'}`);
  }
  // 兵列表
  for (let i = 0; i < b.size; i++) {
    if (b.owner[i] < 0) continue;
    const t = b.terrain[i];
    const tname = t === TERRAIN.PLAIN ? 'P' : t === TERRAIN.CITY ? 'C' : t === TERRAIN.OCEAN ? 'O' : t === TERRAIN.MOUNTAIN ? 'M' : 'V';
    const s = b.strength[i];
    const lk = b.linked[i] ? '连' : '断';
    console.log(
      `  #${i} (r${Math.floor(i / cols)},c${i % cols}) ${tname} seat${b.owner[i]} 兵力${s} ${lk}`,
    );
  }
}

dump(state, `初始`, [1, 2]);
let eventId = 0;
for (const o of lines) {
  if (o.type !== 'INTENT_BROADCAST') continue;
  eventId++;
  const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: o.fromSeat }, intent: o.intent });
  if (!r.ok) {
    console.log(`evt${eventId} REJECTED seat${o.fromSeat}`, JSON.stringify(o.intent));
    continue;
  }
  state = r.state;
  if (eventId === stopAt) dump(state, `evt${eventId} 之后 seat${o.fromSeat} ${JSON.stringify(o.intent)}`, [1, 2]);
  if (stopAt > 0 && eventId >= stopAt) break;
}
if (stopAt < 0) dump(state, `终局`, [1, 2]);
