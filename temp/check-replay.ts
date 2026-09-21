import { readFileSync } from 'node:fs';
import { applyIntent, initState } from '../packages/shared/src/index.ts';
const LOG = 'backend/data/game_logs/g12345678.jsonl';
const lines = readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
const first = JSON.parse(lines[0]);
let state = initState({ map: first.map, seatAssignments: first.seatAssignments, timeSettings: first.timeSettings, seed: first.seed }).state;
let ok = 0, reject = 0, chains = 0;
const rejTypes: Record<string, number> = {};
for (let i = 1; i < lines.length; i++) {
  const msg = JSON.parse(lines[i]);
  if (msg.type !== 'INTENT_BROADCAST' || !msg.intent) continue;
  const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: msg.fromSeat ?? 0 }, intent: msg.intent });
  if (r.ok) { ok++; state = r.state; chains += r.chain.length; }
  else { reject++; rejTypes[msg.intent.intentType] = (rejTypes[msg.intent.intentType] ?? 0) + 1; }
}
console.log('intents ok:', ok, 'rejected:', reject, 'chains:', chains);
console.log('reject by type:', JSON.stringify(rejTypes));
console.log('turn:', state.turn, 'finished:', state.finished, 'winners:', JSON.stringify(state.winners));
console.log('alive:', JSON.stringify(state.forces.filter(f => f.alive).map(f => f.seat)));
console.log('map:', first.map.title, first.map.row + 'x' + first.map.column, 'players:', JSON.stringify(first.map.player_list.map((p: any) => ({ name: p.name, flag: p.flag, seat: p.seat }))));
