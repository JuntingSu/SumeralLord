import { readFileSync } from 'node:fs';
import { applyIntent, initState } from './packages/shared/src/index.ts';
const LOG = 'backend/data/game_logs/g4fa34897.jsonl';
const lines = readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
const first = JSON.parse(lines[0]);
let state = initState({ map: first.map, seatAssignments: first.seatAssignments, timeSettings: first.timeSettings }).state;
const fmt = (s) => `turn=${s.turn} seat=${s.currentSeat} phase=${s.phase} finished=${s.finished} forces=${s.forces.map(f=>`${f.seat}:${f.alive?'A':'X'}`).join(',')}`;
for (let i = 1; i < lines.length; i++) {
  const msg = JSON.parse(lines[i]);
  if (msg.type !== 'INTENT_BROADCAST' || typeof msg.eventId !== 'number' || !msg.intent) continue;
  const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: msg.fromSeat ?? 0 }, intent: msg.intent });
  const ev = msg.eventId;
  if (ev >= 66) {
    console.log(`--- event ${ev} ${msg.intent.intentType} seat${msg.fromSeat} ${JSON.stringify(msg.intent)} => ${r.ok ? 'OK' : 'REJECT ' + r.reason}`);
    if (r.ok) {
      state = r.state;
      console.log('   after:', fmt(state));
      if (ev >= 67) {
        for (const idx of [16, 27, 28]) {
          const t = state.tiles[idx];
          console.log(`   tile ${idx} terrain=${t.terrain} soldier=${t.soldier ? JSON.stringify({owner:t.soldier.owner,st:t.soldier.strength,link:t.soldier.isLinked,mv:t.soldier.hasMovement}) : null}`);
        }
      }
    }
  } else if (r.ok) {
    state = r.state;
  }
}
