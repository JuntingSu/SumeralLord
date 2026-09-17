// 临时诊断：重放卡死对局 g4fa34897，定位多人对局消灭一方后卡死原因
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import type { GameStartMsg, PlayerIntent } from '../src/index.js';
import { applyIntent, initState } from '../src/index.js';

const LOG = 'D:/DATA/things/NumeralLordEverything/nl4ssh/glmtest01/本地数字领主/backend/data/game_logs/g4fa34897.jsonl';

interface Broad {
  type: string;
  eventId?: number;
  fromSeat?: number;
  intent?: PlayerIntent;
  consensusId?: string;
  confirmed?: { kind: string };
}

describe('重放 g4fa34897（三足鼎立卡死局）', () => {
  it('重放至卡死点', () => {
    const lines = readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
    const first = JSON.parse(lines[0]) as GameStartMsg;
    const init = initState({
      map: first.map,
      seatAssignments: first.seatAssignments,
      timeSettings: first.timeSettings,
      seed: first.seed,
    });
    let state = init.state;
    let applied = 0;
    const appliedEvents: number[] = [];
    for (let i = 1; i < lines.length; i++) {
      const msg = JSON.parse(lines[i]) as Broad;
      if (msg.type === 'INTENT_BROADCAST' && typeof msg.eventId === 'number' && msg.intent) {
        const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: msg.fromSeat ?? 0 }, intent: msg.intent });
        applied += 1;
        appliedEvents.push(msg.eventId);
        if (r.ok) state = r.state;
        else if (msg.eventId >= 67) {
          console.log(`eventId ${msg.eventId} ${msg.intent.intentType} fromSeat ${msg.fromSeat} => 拒绝 ${r.reason}`);
        }
      }
    }
    console.log('应用事件数:', applied, '最终 eventId:', appliedEvents[appliedEvents.length - 1]);
    console.log('当前回合:', state.turn, 'currentSeat:', state.currentSeat, 'phase:', state.phase, 'finished:', state.finished);
    console.log('forces:', state.forces.map((f) => ({ seat: f.seat, team: f.team, alive: f.alive, exists: f.exists })));
    // 打印 tile 16/28 及 seat1 相关兵
    for (const idx of [16, 28, 67, 56, 27, 48, 38, 49]) {
      const t = state.tiles[idx];
      console.log(
        `tile ${idx} terrain=${t.terrain} soldier=${t.soldier ? JSON.stringify({ owner: t.soldier.owner, strength: t.soldier.strength, linked: t.soldier.isLinked, mv: t.soldier.hasMovement }) : null}`,
      );
    }
    // 模拟 seat1 再发一次 MOVE 16->28
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: 1 }, intent: { intentType: 'MOVE', from: 16, to: 28 } });
    console.log('seat1 MOVE 16->28 结果:', r.ok ? 'ok' : `拒绝 ${r.reason}`);
    expect(true).toBe(true);
  });
});
