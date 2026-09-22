// 临时诊断：evt34 后局面 → planActionPhase 全部方案 + mctsDecide argmax 结果
import { readFileSync } from 'node:fs';
import { applyIntent, initState } from '@dl/shared';
import { planActionPhase } from '../lib/action.js';
import { mctsDecide } from '../lib/mcts.js';
import { SEED_TE_WEIGHTS } from '../lib/eval.js';

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
console.log('回合', state.turn, '行动势力', state.currentSeat);

const fmt = (xs: any[]) => xs.map((x) => (x.intentType === 'MOVE' || x.intentType === 'ATTACK' ? `${x.intentType}${x.from}->${x.to}` : x.intentType === 'ADD_POINT' ? `ADD#${x.coordinate}` : x.intentType)).join(' ');

console.log('\n=== planActionPhase 生成的方案 ===');
const plans = planActionPhase(state, 2, {});
plans.forEach((p, i) => console.log(`[${i}] score=${p.score.toFixed(3)} :: ${fmt(p.intents)}`));

console.log('\n=== 是否包含直接进攻 33->19 的链 ===');
plans.forEach((p, i) => {
  const hasDirect = p.intents.some((x) => (x.intentType === 'ATTACK' || x.intentType === 'MOVE') && x.from === 33 && x.to === 19);
  const has18 = p.intents.some((x) => (x.intentType === 'ATTACK' || x.intentType === 'MOVE') && x.from === 33 && x.to === 18);
  if (hasDirect || has18) console.log(`[${i}] direct33->19=${hasDirect} via18=${has18} :: ${fmt(p.intents)}`);
});

console.log('\n=== mctsDecide argmax（种子权重, 300 模拟） ===');
const dec = mctsDecide(state, 2, SEED_TE_WEIGHTS, { simulations: 300, mode: 'argmax' });
console.log('nodeCount:', dec.nodeCount);
dec.plans.forEach((p, i) => {
  console.log(`plan[${i}] visits=${dec.visits[i]} mean=${dec.meanValues[i].toFixed(4)} :: ${fmt([...p.actionIntents, ...p.addPointIntents])}`);
});
console.log('选中 plan 索引: 访问数最大', dec.visits.indexOf(Math.max(...dec.visits)));
console.log('选中计划:', fmt([...dec.plan.actionIntents, ...dec.plan.addPointIntents]));
