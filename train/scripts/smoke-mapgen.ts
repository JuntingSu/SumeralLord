// M2 冒烟验证：均衡生成器批量产出 + initState 兼容 + 公平性统计
import { initState, hexDistance } from '@dl/shared';
import { generateTrainMap } from '../lib/mapgen.js';

const N = 100;
let failures = 0;
let sh1 = 0;
let sh2 = 0;
let minDist = Infinity;
let maxDist = 0;
const distSum = { n: 0, sum: 0 };

for (let i = 0; i < N; i++) {
  const seed = `smoke-${i}`;
  try {
    const strongholdsPerSide: 1 | 2 = i % 2 === 0 ? 1 : 2;
    const map = generateTrainMap(seed, undefined, strongholdsPerSide);
    const seatAssignments = map.player_list.map((p) => ({ seat: p.seat, playerId: null, isAI: true, computer: 1, name: p.name }));
    const { state } = initState({
      map,
      seatAssignments,
      seed: `game-${seed}`,
      timeSettings: { stepTime: 60, gameTime: 600, additionalTime: 0 },
      allowAiOnly: true,
    });
    // 校验：2 势力存活、据点兵力归位
    const forces = state.forces.filter((f) => f.exists);
    if (forces.length !== 2) throw new Error(`势力数=${forces.length}`);
    const countSh = (seat: number) =>
      state.tiles.filter((t) => t.soldier && t.soldier.owner === seat && t.terrain === 1).length;
    const c1 = countSh(1);
    const c2 = countSh(2);
    if (c1 !== strongholdsPerSide || c2 !== strongholdsPerSide) {
      throw new Error(`据点数 seat1=${c1} seat2=${c2} 期望=${strongholdsPerSide}`);
    }
    // 后手补偿：先手据点兵力 3、后手 4
    const str1 = state.tiles.filter((t) => t.soldier?.owner === 1 && t.terrain === 1).map((t) => t.soldier!.strength);
    const str2 = state.tiles.filter((t) => t.soldier?.owner === 2 && t.terrain === 1).map((t) => t.soldier!.strength);
    if (str1.some((s) => s !== 3) || str2.some((s) => s !== 4)) {
      throw new Error(`据点兵力不符 seat1=${str1.join(',')} seat2=${str2.join(',')}（期望 3/4）`);
    }
    sh1 += c1;
    sh2 += c2;
    // 出生点距离（跨队据点的最小 hex 距离）
    const s1 = state.tiles.map((t, i) => (t.soldier?.owner === 1 && t.terrain === 1 ? i : -1)).filter((i) => i >= 0);
    const s2 = state.tiles.map((t, i) => (t.soldier?.owner === 2 && t.terrain === 1 ? i : -1)).filter((i) => i >= 0);
    const geo = { rows: state.rows, columns: state.columns, cylindrical: false };
    let minCross = Infinity;
    for (const a of s1) {
      for (const b of s2) {
        minCross = Math.min(minCross, hexDistance(a, b, geo));
      }
    }
    if (minCross < 4) throw new Error(`跨队据点 hex 距离过近: ${minCross}`);
    minDist = Math.min(minDist, minCross);
    maxDist = Math.max(maxDist, minCross);
    distSum.n += 1;
    distSum.sum += minCross;
  } catch (e) {
    failures++;
    console.error(`seed=${seed} 失败:`, (e as Error).message);
  }
}

console.log(`生成 ${N} 张：失败 ${failures}`);
console.log(`据点数合计 seat1=${sh1} seat2=${sh2}（应相等）`);
console.log(`跨队据点最小 hex 距离 min=${minDist} max=${maxDist} 均值=${distSum.n ? (distSum.sum / distSum.n).toFixed(1) : '-'}`);
