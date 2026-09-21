// 临时诊断：在第5回合势力1行动开始局面下，检查 93 的 2 断兵能枚举出哪些行为，
// 以及 planActionPhase 生成的 top 方案里是否包含 93 的任何动作。
import { readFileSync } from 'node:fs';
import { applyIntent, initState, TERRAIN, neighborsOf } from '@dl/shared';
import { extractBoard, soldiersOf, attackPowerOf } from '../lib/board.js';
import { planActionPhase } from '../lib/action.js';
import { SEED_TE_WEIGHTS } from '../lib/eval.js';

const lines = readFileSync('runs/logs/game-004172.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const start = lines.find((o) => o.type === 'GAME_START');
let state = initState({
  map: start.map,
  seatAssignments: start.seatAssignments,
  seed: start.seed,
  timeSettings: start.timeSettings,
}).state;

let eventId = 0;
for (const o of lines) {
  if (o.type !== 'INTENT_BROADCAST') continue;
  eventId++;
  if (eventId > 45) break;
  const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: o.fromSeat }, intent: o.intent });
  if (r.ok) state = r.state;
}
console.log(`回合 ${state.turn}，行动势力 ${state.currentSeat}，阶段 ${state.phase}`);

const b = extractBoard(state);
// 93 与 92 的信息
for (const t of [93, 92, 78]) {
  const s = state.tiles[t].soldier;
  const terr = state.tiles[t].terrain;
  console.log(`#${t} (r${Math.floor(t / 16)},c${t % 16}) terrain=${terr} seat=${b.owner[t]} 兵力=${b.strength[t]} 连=${b.linked[t]} 移动力=${s?.hasMovement}`);
}

// 邻接
console.log('\n93 的邻居:', (() => {
  const geo = { rows: state.rows, columns: state.columns, cylindrical: state.cylindrical };
  return neighborsOf(93, geo).map((nb) => `#${nb}(t=${state.tiles[nb].terrain},o=${b.owner[nb]},s=${b.strength[nb]})`).join(' ');
})());

// 势力1全部有移动力的兵与其可枚举行为
console.log('\n势力1 全部兵：');
const geo = { rows: state.rows, columns: state.columns, cylindrical: state.cylindrical };
for (const t of soldiersOf(b, 1)) {
  const s = state.tiles[t].soldier!;
  const nbEnemies = neighborsOf(t, geo).filter((nb) => b.owner[nb] >= 1 && b.owner[nb] !== 1);
  console.log(
    `#${t} seat${s.owner} 兵力${s.strength} ${s.isLinked ? '连' : '断'} 移动力=${s.hasMovement}` +
      (nbEnemies.length ? ` 相邻敌兵: ${nbEnemies.join(',')}` : ''),
  );
}

// 方案生成
const plans = planActionPhase(state, 1, {});
console.log(`\nplanActionPhase 共生成 ${plans.length} 个方案：`);
plans.forEach((p, i) => {
  console.log(`  [${i}] score=${p.score.toFixed(3)} intents=${JSON.stringify(p.intents.map((x) => x.intentType === 'ADD_POINT' ? `ADD#${x.coordinate}` : `${x.intentType}${x.from}->${x.to}`))}`);
});
const has93 = plans.filter((p) => p.intents.some((x) => (x.intentType === 'MOVE' || x.intentType === 'ATTACK') && x.from === 93));
console.log('\n含 from=93 动作的方案数:', has93.length);
