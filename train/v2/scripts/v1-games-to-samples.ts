// v1-games-to-samples.ts — 将 v1 自对弈日志转换为 v2 训练样本（示范数据集）
//
// 用法：npx tsx v2/scripts/v1-games-to-samples.ts [--dir ../v1/runs/logs] [--max-games 300]
//   [--max-samples 50000] [--out ../runs/v1-samples]
// 每局 v1 对局 → 每步一条样本：π = v1 实际动作 one-hot、z = 行动方视角终局胜负（GAME_OVER 回填）。
// 取日志末尾 --max-games 局（v20 收敛后质量最高）；总量达 --max-samples 即止。
// 产物为 v2 二进制样本（writeSamplesBinary），供 train.py --samples-dir/--extra-samples-dir 直接加载。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { applyIntent, initState } from '@dl/shared';
import type { GameState, PlayerIntent } from '@dl/shared';
import { actionToIntent, intentToAction, legalActionList } from '../lib/actions.js';
import { encodeState } from '../lib/encode.js';
import { parseLogText } from '../lib/logparse.js';
import type { TrainSample } from '../lib/driver.js';
import { writeSamplesBinary } from '../lib/sampleio.js';
import { V2_ROOT } from '../lib/paths.js';

function get(key: string): string | undefined {
  const i = process.argv.indexOf(`--${key}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const srcDir = get('dir') ?? path.join(V2_ROOT, '..', 'v1', 'runs', 'logs');
const outDir = get('out') ?? path.join(V2_ROOT, 'runs', 'v1-samples');
const maxGames = Number(get('max-games') ?? '300');
const maxSamples = Number(get('max-samples') ?? '50000');

interface StepRec {
  state: GameState;
  intent: PlayerIntent;
  seat: number;
}

/** 重放一局 v1 日志：收集每个决策点的动作前局面 + 实际意图；返回样本（z 终局回填） */
function logToSamples(text: string): { gameId: string; mapId: string; samples: TrainSample[] } | null {
  const parsed = parseLogText(text);
  if (!parsed) return null;
  const { start, intents } = parsed;

  let state = initState({
    map: start.map,
    seatAssignments: start.seatAssignments,
    timeSettings: start.timeSettings,
    seed: start.seed,
  }).state;

  // 一遍重放：先收集所有决策点记录（动作前局面不可变，applyIntent 克隆）
  const steps: StepRec[] = [];
  for (const item of intents) {
    if (state.phase === 'ACTION' || state.phase === 'ADD_POINT') {
      const actionIdx = intentToAction(state, item.intent);
      const legal = legalActionList(state);
      const pos = actionIdx !== null ? legal.indexOf(actionIdx) : -1;
      if (pos >= 0) {
        steps.push({ state, intent: item.intent, seat: item.fromSeat });
      }
    }
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: item.fromSeat }, intent: item.intent });
    if (r.ok) state = r.state;
  }

  // z：终局行动方视角胜负（上限判平 = 0）
  const wt = state.finished ? state.winningTeam : null;
  const teamOf = (s: number) => state.forces.find((f) => f.seat === s)?.team ?? -1;

  const out: TrainSample[] = [];
  for (const rec of steps) {
    const actionIdx = intentToAction(rec.state, rec.intent)!;
    const legal = legalActionList(rec.state);
    const pos = legal.indexOf(actionIdx);
    if (pos < 0) continue; // 防御：非法/不可映射动作（v1 日志只记录被接受的意图，理论不可达）
    const enc = encodeState(rec.state);
    const pi: [number, number][] = legal.map((idx, i) => [idx, i === pos ? 1 : 0]);
    out.push({
      gameId: `v1-${start.gameId}`,
      mapId: `v1-${start.map.id ?? 'unknown'}`, // 与当前图池同 id 的地图实际布局不同，标签加 v1- 前缀避免局面题抽样跨池配对
      turn: rec.state.turn,
      seat: rec.seat,
      phase: rec.state.phase,
      nTiles: rec.state.tiles.length,
      rows: rec.state.rows,
      columns: rec.state.columns,
      cls: enc.cls,
      tiles: enc.tiles,
      pi,
      z: wt === null || wt < 0 ? 0 : teamOf(rec.seat) === wt ? 1 : -1,
    });
  }
  return out.length > 0 ? { gameId: start.gameId, mapId: start.map.id ?? 'unknown', samples: out } : null;
}

async function main(): Promise<void> {
  if (!existsSync(srcDir)) throw new Error(`v1 日志目录不存在：${srcDir}`);
  const files = readdirSync(srcDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .slice(-maxGames); // 末尾 maxGames 局（收敛后质量最高）

  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) rmSync(path.join(outDir, f), { force: true }); // 清旧产物，避免跨次累积

  let games = 0;
  let samples = 0;
  let skipped = 0;
  for (const f of files) {
    const text = readFileSync(path.join(srcDir, f), 'utf8');
    const conv = logToSamples(text);
    if (!conv) {
      skipped++;
      continue;
    }
    writeSamplesBinary(outDir, `v1-${conv.gameId}`, conv.samples);
    games++;
    samples += conv.samples.length;
    if (samples >= maxSamples) {
      console.log(`已到样本上限 ${maxSamples}，提前停止（已取 ${files.length} 局中的前 ${games} 局）`);
      break;
    }
  }
  console.log(`[v1-games-to-samples] 完成：${games} 局 / ${samples} 条样本 → ${outDir}（跳过 ${skipped} 局）`);
}

main().catch((e) => {
  console.error('[v1-games-to-samples] 失败：', e);
  process.exit(1);
});
