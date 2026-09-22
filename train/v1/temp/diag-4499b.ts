// 临时诊断：对比 直接进攻(32->33->19) vs 绕步(32->33->18->19) 的终止局面 E_ape / E_te
import { readFileSync } from 'node:fs';
import { applyIntent, initState } from '@dl/shared';
import { evalApe, evalTe, SEED_TE_WEIGHTS } from '../lib/eval.js';
import { extractBoard, soldiersOf } from '../lib/board.js';

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
  if (!r.ok) throw new Error('reject ' + JSON.stringify(intent) + ' ' + JSON.stringify(r));
  return r.state;
};

// 链A：绕步 32->33 -> 33->18 -> ATTACK18->19
let A = apply(state, { intentType: 'MOVE', from: 32, to: 33 });
A = apply(A, { intentType: 'MOVE', from: 33, to: 18 });
A = apply(A, { intentType: 'ATTACK', from: 18, to: 19 });
// 链B：直接 32->33 -> ATTACK33->19
let B = apply(state, { intentType: 'MOVE', from: 32, to: 33 });
B = apply(B, { intentType: 'ATTACK', from: 33, to: 19 });

const snap = (label: string, s: any) => {
  const b = extractBoard(s);
  const s2 = soldiersOf(b, 2).map((t) => `#${t}:${b.strength[t]}${b.linked[t] ? '连' : '断'}`);
  console.log(label, 'seat2:', s2.join(' '));
};
snap('链A(绕步) 终止:', A);
snap('链B(直接) 终止:', B);
console.log('\nE_ape 链A:', evalApe(A, turnStart, 2).toFixed(3), ' 链B:', evalApe(B, turnStart, 2).toFixed(3));
console.log('E_te  链A:', evalTe(A, turnStart, 2, SEED_TE_WEIGHTS).toFixed(3), ' 链B:', evalTe(B, turnStart, 2, SEED_TE_WEIGHTS).toFixed(3));

// 链B 继续：从 19(2连) 往敌方深处切：就近进攻 19->20（20 是敌 1连）
let B2 = apply(B, { intentType: 'ATTACK', from: 19, to: 20 });
snap('链B+19->20:', B2);
console.log('E_ape 链B+20:', evalApe(B2, turnStart, 2).toFixed(3), ' E_te:', evalTe(B2, turnStart, 2, SEED_TE_WEIGHTS).toFixed(3));

// 链A 能否从 19(1连) 继续？
let A2 = apply(A, { intentType: 'ATTACK', from: 19, to: 20 });
console.log('\n链A 从 19(1连) 攻击 20: 拒绝或成功？');
try { const s = apply(A2, { intentType: 'X' }); } catch (e) {}
const rA2 = applyIntent(A, { actor: { kind: 'PLAYER', seat: 2 }, intent: { intentType: 'ATTACK', from: 19, to: 20 } });
console.log('  A 19->20 ok=', rA2.ok, rA2.ok ? '' : JSON.stringify(rA2));
const rB2 = applyIntent(B, { actor: { kind: 'PLAYER', seat: 2 }, intent: { intentType: 'ATTACK', from: 19, to: 20 } });
console.log('  B 19->20 ok=', rB2.ok);
