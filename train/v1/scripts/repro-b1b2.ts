// 复现脚本：连兵 A 邻两个敌连兵 B1/B2（B1 通过 B2 → B3 → 敌据点，均 1 兵力）
// 检查：①攻 B2 是否级联删除 B1；②行动候选 top-6 是否含 ATTACK B1 / ATTACK B2；③MCTS argmax 选谁；④E_te/E_ape 对比
import { TERRAIN, applyIntent } from '@dl/shared';
import type { GameState, PlayerIntent } from '@dl/shared';
import { planActionPhase } from '../lib/action.js';
import { mctsDecide } from '../lib/mcts.js';
import { evalTe, SEED_TE_WEIGHTS, APE_WEIGHTS, isLatePhase } from '../lib/eval.js';
import { apeFeatures, teFeatures } from '../lib/features.js';

const P = TERRAIN.PLAIN;
const C = TERRAIN.CITY;

function soldier(owner: number, strength: number, isLinked: boolean, hasMovement = true) {
  return { owner, strength, isLinked, hasMovement, counter: 1 };
}

// 3 行 × 5 列（odd-r：0 基奇数行右移半格；行 0 在下）
//  行0: (0,0)敌据点5  (1,0)敌B3=1  (2,0)敌B2=1  (3,0)敌B1=1  (4,0)空
//  行1: (0,1)空       (1,1)空      (2,1)我A=3    (3,1)空      (4,1)空
//  行2: (0,2)空       (1,2)空      (2,2)我据点3  (3,2)空      (4,2)空
// A(7) 邻 B1(3) 与 B2(2)；B1 仅通过 B2 连通；B2 通过 B3 连敌据点(0)。
function buildState(): GameState {
  const tiles = [
    { terrain: C, soldier: soldier(2, 5, true) }, // 0  (0,0) 敌据点
    { terrain: P, soldier: soldier(2, 1, true) }, // 1  (1,0) B3
    { terrain: P, soldier: soldier(2, 1, true) }, // 2  (2,0) B2
    { terrain: P, soldier: soldier(2, 1, true) }, // 3  (3,0) B1
    { terrain: P, soldier: null }, // 4
    { terrain: P, soldier: null }, // 5
    { terrain: P, soldier: null }, // 6
    { terrain: P, soldier: soldier(1, 3, true) }, // 7  (2,1) A
    { terrain: P, soldier: null }, // 8
    { terrain: P, soldier: null }, // 9
    { terrain: P, soldier: null }, // 10
    { terrain: P, soldier: null }, // 11
    { terrain: C, soldier: soldier(1, 3, true, false) }, // 12 (2,2) 我据点（不动）
    { terrain: P, soldier: null }, // 13
    { terrain: P, soldier: null }, // 14
  ];
  return {
    rows: 3,
    columns: 5,
    cylindrical: false,
    seed: 'repro',
    turn: 5,
    currentSeat: 1,
    phase: 'ACTION',
    forces: [
      { seat: 1, team: 1, name: 'A', flag: 1, playerId: 900001, isAI: false, computer: 2, exists: true, alive: true, points: 3 },
      { seat: 2, team: 2, name: 'B', flag: 2, playerId: 900002, isAI: false, computer: 2, exists: true, alive: true, points: 3 },
    ],
    tiles,
    timeSettings: { stepTime: 30, gameTime: 600, additionalTime: 10 },
    finished: false,
    winners: null,
    winningTeam: null,
  };
}

function replay(state: GameState, seat: number, intents: PlayerIntent[]): GameState {
  let cur = state;
  for (const intent of intents) {
    const r = applyIntent(cur, { actor: { kind: 'PLAYER', seat }, intent });
    if (r.ok) cur = r.state;
  }
  return cur;
}

const fmt = (i: PlayerIntent): string =>
  i.intentType === 'MOVE' ? `MOVE ${i.from}->${i.to}` : i.intentType === 'ATTACK' ? `ATTACK ${i.from}->${i.to}` : i.intentType;

function evalApeL(post: GameState, start: GameState): number {
  const f = apeFeatures(post, start, 1);
  const w = isLatePhase(post) ? APE_WEIGHTS.late : APE_WEIGHTS.pre;
  return w.reduce((s, wi, i) => s + wi * f[i], 0);
}

const state = buildState();
console.log('== 局面 ==');
console.log('A=7(连,3)  B1=3(连,1)  B2=2(连,1)  B3=1(连,1)  敌据点=0(连,5)  我据点=12(连,3)');
console.log('isLatePhase:', isLatePhase(state));

console.log('\n== 攻 B2(2) 与攻 B1(3) 的后果 ==');
const leafB2 = replay(state, 1, [{ intentType: 'ATTACK', from: 7, to: 2 }]);
const leafB1 = replay(state, 1, [{ intentType: 'ATTACK', from: 7, to: 3 }]);
console.log('攻B2后 B1格(3):', leafB2.tiles[3].soldier ? `存活(兵力${leafB2.tiles[3].soldier.strength})` : '已级联删除');
console.log('攻B2后 B3格(1):', leafB2.tiles[1].soldier ? `存活(兵力${leafB2.tiles[1].soldier.strength})` : '已删');
console.log('攻B1后 B2格(2):', leafB1.tiles[2].soldier ? `存活(兵力${leafB1.tiles[2].soldier.strength})` : '已删');
console.log('攻B2后 A: t7=', leafB2.tiles[7].soldier?.strength, ' t2=', leafB2.tiles[2].soldier?.strength);
console.log('攻B1后 A: t7=', leafB1.tiles[7].soldier?.strength, ' t3=', leafB1.tiles[3].soldier?.strength);
console.log('敌总兵力 攻B2后:', leafB2.tiles.filter((t) => t.soldier?.owner === 2).reduce((s, t) => s + t.soldier!.strength, 0),
  ' 攻B1后:', leafB1.tiles.filter((t) => t.soldier?.owner === 2).reduce((s, t) => s + t.soldier!.strength, 0));

console.log('\n== E_te / E_ape 对比（种子权重） ==');
console.log('E_te(攻B2):', evalTe(leafB2, state, 1, SEED_TE_WEIGHTS).toFixed(3),
  ' f=', teFeatures(leafB2, state, 1).map((x) => x.toFixed(2)).join(','));
console.log('E_te(攻B1):', evalTe(leafB1, state, 1, SEED_TE_WEIGHTS).toFixed(3),
  ' f=', teFeatures(leafB1, state, 1).map((x) => x.toFixed(2)).join(','));
console.log('E_ape(攻B2):', evalApeL(leafB2, state).toFixed(3),
  ' f=', apeFeatures(leafB2, state, 1).map((x) => x.toFixed(2)).join(','));
console.log('E_ape(攻B1):', evalApeL(leafB1, state).toFixed(3),
  ' f=', apeFeatures(leafB1, state, 1).map((x) => x.toFixed(2)).join(','));

console.log('\n== planActionPhase top-6 ==');
const plans = planActionPhase(state, 1);
plans.forEach((p, i) => {
  console.log(`[${i}] score=${p.score.toFixed(3)}  ${p.intents.map(fmt).join(' | ')}`);
});

console.log('\n== mctsDecide argmax（300 模拟） ==');
const res = mctsDecide(state, 1, SEED_TE_WEIGHTS, { simulations: 300, mode: 'argmax' });
res.plans.forEach((p, i) => {
  console.log(`[${i}] visits=${res.visits[i]} mean=${res.meanValues[i].toFixed(3)}  ${p.actionIntents.map(fmt).join(' | ') || '(空)'}`);
});
console.log('chosen:', res.plan.actionIntents.map(fmt).join(' | ') || '(空)');

console.log('\n== 温度采样 τ=6 的根动作分布（10 万次抽样） ==');
const visits = res.visits;
const tau = 6;
const weights = visits.map((n) => Math.pow(Math.max(1, n), 1 / tau));
const total = weights.reduce((a, b) => a + b, 0);
const dist = weights.map((w) => (w / total) * 100);
dist.forEach((d, i) => console.log(`[${i}] visits=${visits[i]} 采样概率=${d.toFixed(1)}%  ${res.plans[i].actionIntents.map(fmt).join(' | ') || '(空)'}`));
