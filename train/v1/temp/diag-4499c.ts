// 临时诊断：E_ape 特征分解（链A 绕步 vs 链B 直接）+ 理想切断模拟
import { readFileSync } from 'node:fs';
import { applyIntent, initState } from '@dl/shared';
import { apeFeatures, teFeatures } from '../lib/features.js';
import { isLatePhase, SEED_TE_WEIGHTS, APE_WEIGHTS } from '../lib/eval.js';
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
  if (!r.ok) throw new Error('reject ' + JSON.stringify(intent));
  return r.state;
};

let A = apply(apply(apply(state, { intentType: 'MOVE', from: 32, to: 33 }), { intentType: 'MOVE', from: 33, to: 18 }), { intentType: 'ATTACK', from: 18, to: 19 });
let B = apply(apply(state, { intentType: 'MOVE', from: 32, to: 33 }), { intentType: 'ATTACK', from: 33, to: 19 });

const show = (label: string, s: any) => {
  const f = apeFeatures(s, turnStart, 2);
  const w = isLatePhase(s) ? APE_WEIGHTS.late : APE_WEIGHTS.pre;
  const te = teFeatures(s, turnStart, 2);
  const sum = f.reduce((a, x, i) => a + w[i] * x, 0);
  console.log(`${label} isLate=${isLatePhase(s)}`);
  console.log(`  ape f=[${f.map((x) => x.toFixed(2)).join(', ')}] w=${isLatePhase(s) ? 'late' : 'pre'} 各贡献=[${f.map((x, i) => (w[i] * x).toFixed(2)).join(', ')}] 合计=${sum.toFixed(3)}`);
  console.log(`  te f=[${te.map((x) => x.toFixed(1)).join(', ')}]`);
};
show('链A(绕步 32->33->18->19):', A);
show('链B(直接 32->33->19):', B);

// 理想切断模拟：链B 继续 19->20（夺 20 → 34 断电）
let C = apply(B, { intentType: 'ATTACK', from: 19, to: 20 });
const b = extractBoard(C);
console.log('\n理想切断 32->33->19->20 后 seat1 兵:', soldiersOf(b, 1).map((t) => `#${t}:${b.strength[t]}${b.linked[t] ? '连' : '断'}`).join(' '));
show('链C(直接+19->20):', C);
console.log('E_te 链C:', (() => { const f = teFeatures(C, turnStart, 2); const w = isLatePhase(C) ? SEED_TE_WEIGHTS.late : SEED_TE_WEIGHTS.mid; return f.reduce((a, x, i) => a + w[i] * x, 0).toFixed(3); })());
