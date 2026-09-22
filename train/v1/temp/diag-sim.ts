// 临时诊断：模拟 93 的 2断兵 进攻 92，看断电后果
import { readFileSync } from 'node:fs';
import { applyIntent, initState } from '@dl/shared';
import { extractBoard, soldiersOf } from '../lib/board.js';

const lines = readFileSync('runs/logs/game-004172.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const start = lines.find((o) => o.type === 'GAME_START');
let state = initState({ map: start.map, seatAssignments: start.seatAssignments, seed: start.seed, timeSettings: start.timeSettings }).state;
let eventId = 0;
for (const o of lines) {
  if (o.type !== 'INTENT_BROADCAST') continue;
  eventId++;
  if (eventId > 45) break;
  const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: o.fromSeat }, intent: o.intent });
  if (r.ok) state = r.state;
}
const before = extractBoard(state);
const snap = (label: string, b: ReturnType<typeof extractBoard>) => {
  const f2 = soldiersOf(b, 2).map((t) => `#${t}:${b.strength[t]}${b.linked[t] ? '连' : '断'}`);
  const f1 = soldiersOf(b, 1).map((t) => `#${t}:${b.strength[t]}${b.linked[t] ? '连' : '断'}`);
  console.log(label);
  console.log('  势力1:', f1.join(' '));
  console.log('  势力2:', f2.join(' '));
};
snap('进攻前', before);
// 意图：ATTACK 93 -> 92
const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: { intentType: 'ATTACK', from: 93, to: 92 } });
console.log('\nATTACK 93->92 ok=', r.ok, r.ok ? '' : ('reason=' + JSON.stringify(r)));
if (r.ok) {
  const after = extractBoard(r.state);
  snap('进攻后', after);
  // 断电统计：势力2 连兵数变化
  const c2Before = soldiersOf(before, 2).filter((t) => before.linked[t] === 1).length;
  const c2After = soldiersOf(after, 2).filter((t) => after.linked[t] === 1).length;
  console.log(`\n势力2 连兵数: ${c2Before} -> ${c2After}`);
}
