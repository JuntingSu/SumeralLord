// 临时诊断：重放到指定事件，打印地形+兵力网格
import { readFileSync } from 'node:fs';
import { applyIntent, initState, TERRAIN } from '@dl/shared';
import { extractBoard } from '../lib/board.js';

const lines = readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const stopAt = Number(process.argv[3] ?? -1);
const start = lines.find((o) => o.type === 'GAME_START');
let state = initState({ map: start.map, seatAssignments: start.seatAssignments, seed: start.seed, timeSettings: start.timeSettings }).state;

function grid(s: typeof state, label: string) {
  const b = extractBoard(s);
  const R = b.geo.rows, C = b.geo.columns;
  console.log(`\n===== ${label} (turn=${s.turn}, seat=${s.currentSeat}) =====`);
  for (let r = R - 1; r >= 0; r--) {
    let line = '';
    for (let c = 0; c < C; c++) {
      const i = r * C + c;
      const t = b.terrain[i];
      const tc = t === TERRAIN.PLAIN ? '.' : t === TERRAIN.CITY ? 'C' : t === TERRAIN.OCEAN ? '~' : t === TERRAIN.MOUNTAIN ? 'M' : 'V';
      if (b.owner[i] === 1) line += `[1${b.strength[i]}${b.linked[i] ? 'L' : 'd'}]`;
      else if (b.owner[i] === 2) line += `[2${b.strength[i]}${b.linked[i] ? 'L' : 'd'}]`;
      else if (b.owner[i] === 0) line += `[w${b.strength[i]} ]`;
      else line += `  ${tc}  `;
    }
    console.log(line);
  }
  // 坐标标注（每格）
  console.log('--- 坐标 ---');
  for (let r = R - 1; r >= 0; r--) {
    let line = '';
    for (let c = 0; c < C; c++) {
      const i = r * C + c;
      line += String(i).padStart(4) + ' ';
    }
    console.log(line);
  }
}
grid(state, '初始');
let eventId = 0;
for (const o of lines) {
  if (o.type !== 'INTENT_BROADCAST') continue;
  eventId++;
  const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: o.fromSeat }, intent: o.intent });
  if (!r.ok) { console.log(`evt${eventId} REJECT`, JSON.stringify(o.intent)); continue; }
  state = r.state;
  if (eventId === stopAt) grid(state, `evt${eventId} 后 seat${o.fromSeat} ${JSON.stringify(o.intent)}`);
  if (stopAt >= 0 && eventId >= stopAt) break;
}
