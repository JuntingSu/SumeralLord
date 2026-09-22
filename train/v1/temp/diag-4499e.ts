// 临时诊断：种子权重 vs v45 训练权重 对三条路线的 E_te 评分 + 特征分解
import { readFileSync } from 'node:fs';
import { applyIntent, initState } from '@dl/shared';
import { SEED_TE_WEIGHTS } from '../lib/eval.js';
import { teFeatures } from '../lib/features.js';
import { isLatePhase } from '../lib/eval.js';

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

// 三条路线
const U = apply(apply(apply(state, { intentType: 'MOVE', from: 32, to: 33 }), { intentType: 'ATTACK', from: 33, to: 19 }), { intentType: 'ATTACK', from: 19, to: 6 });
const B = apply(apply(state, { intentType: 'MOVE', from: 32, to: 33 }), { intentType: 'ATTACK', from: 33, to: 19 });
const A = apply(apply(apply(state, { intentType: 'MOVE', from: 32, to: 33 }), { intentType: 'MOVE', from: 33, to: 18 }), { intentType: 'ATTACK', from: 18, to: 19 });

const v45 = JSON.parse(readFileSync('runs/weights/v45.json', 'utf8')).weights;
const score = (s: any, w: any) => {
  const f = teFeatures(s, turnStart, 2);
  const ww = isLatePhase(s) ? w.late : w.mid;
  return { sum: f.reduce((a, x, i) => a + ww[i] * x, 0), f, ww, late: isLatePhase(s) };
};
const show = (label: string, s: any) => {
  const seed = score(s, SEED_TE_WEIGHTS);
  const tr = score(s, v45);
  console.log(`${label}  isLate=${seed.late}`);
  console.log(`  特征 f=[${seed.f.map((x) => x.toFixed(1)).join(', ')}]`);
  console.log(`  种子权重 E_te=${seed.sum.toFixed(2)}   v45训练权重 E_te=${tr.sum.toFixed(2)}`);
  console.log(`    v45(${seed.late ? 'late' : 'mid'})=[${tr.ww.map((x) => x.toFixed(3)).join(', ')}] 贡献=[${seed.f.map((x, i) => (tr.ww[i] * x).toFixed(1)).join(', ')}]`);
};
show('用户路线 32->33->19->6 (大断电):', U);
show('只到 19 (2连):', B);
show('AI实际 32->33->18->19:', A);
