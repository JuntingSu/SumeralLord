// 临时诊断：模拟用户路线 32->33->19->6（正确 odd-r 邻接），与 AI 实际走法 32->33->18->19 对比
import { readFileSync } from 'node:fs';
import { applyIntent, initState } from '@dl/shared';
import { evalTe, evalApe, SEED_TE_WEIGHTS } from '../lib/eval.js';
import { extractBoard, soldiersOf, linkedCountOf, totalStrengthOf } from '../lib/board.js';

const lines = readFileSync('runs/logs/game-004499.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const start = lines.find((o) => o.type === 'GAME_START');
let state = initState({ map: start.map, seatAssignments: start.seatAssignments, seed: start.seed, timeSettings: start.timeSettings }).state;
let eventId = 0;
for (const o of lines) {
  if (o.type !== 'INTENT_BROADCAST') continue;
  eventId++;
  if (eventId > 34) break;
  const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: o.fromSeat }, intent: o.intent });
  if (r.ok) state = r.state;
}
const turnStart = state;
const apply = (s: any, intent: any) => {
  const r = applyIntent(s, { actor: { kind: 'PLAYER', seat: 2 }, intent });
  if (!r.ok) throw new Error('reject ' + JSON.stringify(intent) + ' -> ' + JSON.stringify(r.reason));
  return r.state;
};
const snap = (label: string, s: any) => {
  const b = extractBoard(s);
  const s1 = soldiersOf(b, 1).map((t) => `#${t}:${b.strength[t]}${b.linked[t] ? '连' : '断'}`);
  const s2 = soldiersOf(b, 2).map((t) => `#${t}:${b.strength[t]}${b.linked[t] ? '连' : '断'}`);
  console.log(label);
  console.log('  seat1:', s1.join(' ') || '(无)');
  console.log('  seat2:', s2.join(' ') || '(无)');
  console.log(`  seat1 连兵=${linkedCountOf(b, 1)} 总兵力=${totalStrengthOf(b, 1)} | seat2 连兵=${linkedCountOf(b, 2)} 总兵力=${totalStrengthOf(b, 2)} | finished=${s.finished}`);
};

snap('进攻前 (evt34后):', state);

// 用户路线：32->33 -> 33->19 -> 19->6
let U = apply(apply(apply(state, { intentType: 'MOVE', from: 32, to: 33 }), { intentType: 'ATTACK', from: 33, to: 19 }), { intentType: 'ATTACK', from: 19, to: 6 });
snap('\n用户路线 32->33->19->6 之后:', U);
console.log('  E_ape(用户路线终局):', evalApe(U, turnStart, 2).toFixed(3), ' E_te(种子):', evalTe(U, turnStart, 2, SEED_TE_WEIGHTS).toFixed(3));

// 中间态：只到 19（2连，未打 6）
let B = apply(apply(state, { intentType: 'MOVE', from: 32, to: 33 }), { intentType: 'ATTACK', from: 33, to: 19 });
snap('\n只到 19 (2连) 未打 6:', B);
console.log('  E_ape:', evalApe(B, turnStart, 2).toFixed(3), ' E_te:', evalTe(B, turnStart, 2, SEED_TE_WEIGHTS).toFixed(3));

// AI 实际走法：32->33->18->19
let A = apply(apply(apply(state, { intentType: 'MOVE', from: 32, to: 33 }), { intentType: 'MOVE', from: 33, to: 18 }), { intentType: 'ATTACK', from: 18, to: 19 });
snap('\nAI实际 32->33->18->19 之后:', A);
console.log('  E_ape:', evalApe(A, turnStart, 2).toFixed(3), ' E_te:', evalTe(A, turnStart, 2, SEED_TE_WEIGHTS).toFixed(3));
