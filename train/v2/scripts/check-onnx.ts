// scripts/check-onnx.ts — TS↔Python 前向一致性：编码一个真实局面 → TS 推理 → 落盘 → Python 对比
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { applyIntent, initState } from '@dl/shared';
import type { MapFullData } from '@dl/shared';
import { actionToIntent, legalActionList } from '../lib/actions.js';
import { encodeState } from '../lib/encode.js';
import { NeuralNet } from '../lib/nn.js';
import { MAPS_DIR } from '../lib/paths.js';

async function main(): Promise<void> {
  const mapFiles = readdirSync(MAPS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (mapFiles.length === 0) throw new Error('图池为空');
  const map = JSON.parse(readFileSync(path.join(MAPS_DIR, mapFiles[0]), 'utf8')) as MapFullData;

  let state = initState({
    map,
    seatAssignments: [
      { seat: 1, playerId: 900001, isAI: false },
      { seat: 2, playerId: 900002, isAI: false },
    ],
    seed: 'check-onnx',
    timeSettings: { stepTime: 30, gameTime: 600, additionalTime: 10 },
  }).state;

  // 随机走若干步，得到一个真实中局局面
  for (let i = 0; i < 6 && !state.finished; i++) {
    const legal = legalActionList(state);
    const idx = legal[Math.floor(Math.random() * legal.length)];
    const r = applyIntent(state, {
      actor: { kind: 'PLAYER', seat: state.currentSeat },
      intent: actionToIntent(state, idx),
    });
    if (r.ok) state = r.state;
  }

  const enc = encodeState(state);
  const net = await NeuralNet.load(path.join(process.cwd(), 'v2/runs/weights/model.onnx'));
  const out = await net.forward(state, enc);

  const dump = {
    rows: state.rows,
    columns: state.columns,
    cls: enc.cls,
    tiles: enc.tiles,
    tsPolicy: Array.from(out.policy),
    tsValue: out.value,
  };
  const dumpPath = path.join(process.cwd(), 'v2/runs/weights/check-ts-dump.json');
  writeFileSync(dumpPath, JSON.stringify(dump));
  console.log(`dumped ${dumpPath}（nTiles=${enc.tiles.length}, policy len=${out.policy.length}, value=${out.value.toFixed(4)}）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
