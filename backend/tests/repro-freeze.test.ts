// 临时诊断：服务器侧重放 g4fa34897 的共识流（事件67：seat1攻占seat3唯一据点 → FORCE_CLEAR）
// 用真实 GameManager + ConsensusManager，模拟网关 onConsensusConfirmed 行为，喂入按日志时序的投票。
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { GameStartMsg, PlayerIntent, ConsensusPayload } from '@dl/shared';
import { applyIntent, initState } from '@dl/shared';
import { GameManager } from '../src/game/manager.js';
import { ConsensusManager } from '../src/game/consensus.js';

const LOG = 'D:/DATA/things/NumeralLordEverything/nl4ssh/glmtest01/本地数字领主/backend/data/game_logs/g4fa34897.jsonl';

// 网关 onConsensusConfirmed 的最小复刻（allocateEventId + appendEvent + addClearedSeat）
// 返回 server 侧共识状态
function runServerReplay() {
  const dir = mkdtempSync(path.join(tmpdir(), 'dl-repro-'));
  const games = new GameManager(path.join(dir, 'logs'));
  const lines = readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  const first = JSON.parse(lines[0]) as GameStartMsg;
  const seats = first.seatAssignments;
  const { game } = games.create({
    roomId: 'r1',
    map: first.map,
    seatAssignments: seats,
    aiTakeover: false,
    timeSettings: first.timeSettings,
    reducerVersion: 'test',
  });
  for (const s of seats) games.setConnected(game, s.seat, true, Date.now());

  let confirmed: Array<{ consensusId: string; payload: ConsensusPayload }> = [];
  let fatal: Array<string> = [];
  const consensus = new ConsensusManager(
    games,
    {
      onConfirmed: (gameId, consensusId, payload) => {
        if (game.status !== 'in_game') return;
        // 共识消息用非意图 refId（"{触发意图eventId}*"），不占用意图 eventId 序
        const triggerEventId = Number(consensusId.split(':')[0]);
        games.appendEvent(game, { type: 'CONSENSUS_CONFIRMED', consensusId, confirmed: payload, refId: `${triggerEventId}*` });
        confirmed.push({ consensusId, payload });
        if (payload.kind === 'FORCE_CLEAR') games.addClearedSeat(game, payload.seat);
        if (payload.kind === 'VICTORY') games.markFinished(game);
      },
      onFatal: (gameId, code) => fatal.push(code),
    },
    1000,
  );

  // 重放：按日志顺序，每条 INTENT_BROADCAST 由所有在线 client 应用并投票
  // 同时广播消息（模拟网关 broadcast）
  const clientStates = new Map<number, ReturnType<typeof initState>['state']>();
  for (const s of seats) clientStates.set(s.seat, initState({ map: first.map, seatAssignments: seats, timeSettings: first.timeSettings, seed: first.seed }).state);

  const problems: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const msg = JSON.parse(lines[i]);
    if (msg.type === 'INTENT_BROADCAST' && typeof msg.eventId === 'number' && msg.intent) {
      // 每个 client 应用意图 → 生成共识节点 → 投票
      for (const [seat, state] of clientStates) {
        const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: msg.fromSeat }, intent: msg.intent as PlayerIntent });
        if (r.ok) clientStates.set(seat, r.state);
        if (r.ok && r.chain) {
          for (const ev of r.chain) {
            if (ev.kind === 'FORCE_CLEAR') {
              consensus.submit(game, seat, `${msg.eventId}:force_clear:${ev.seat}`, { kind: 'FORCE_CLEAR', seat: ev.seat, reason: ev.reason });
            } else if (ev.kind === 'VICTORY') {
              consensus.submit(game, seat, `${msg.eventId}:victory:0`, { kind: 'VICTORY', winningTeam: ev.winningTeam, winners: ev.winners, losers: ev.losers });
            }
          }
        }
      }
    }
  }
  rmSync(dir, { recursive: true, force: true });
  return { confirmed, fatal, problems };
}

describe('服务器侧重放 g4fa34897 共识流', () => {
  it('事件67 后所有共识应被确认', () => {
    const { confirmed, fatal } = runServerReplay();
    console.log('已确认共识:', JSON.stringify(confirmed, null, 2));
    console.log('fatal:', fatal);
    expect(fatal).toEqual([]);
  });
});
