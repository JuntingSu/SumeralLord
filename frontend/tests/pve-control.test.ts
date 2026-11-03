// 战役控制转移：transport 与 store 同步切换 mySeat，切换后玩家可用新势力继续行动。
import { afterEach, describe, expect, it } from 'vitest';
import { initState } from '@dl/shared';
import type { BattlefieldTile, MapFullData, PveGameConfig, SeatAssignment, TriggerDef } from '@dl/shared';
import { attachTransport, useGame } from '../src/stores/game';
import { PveTransport } from '../src/game/pveTransport';

const TIME = { stepTime: 90, gameTime: 1200, additionalTime: 0 };
const SEATS: SeatAssignment[] = [
  { seat: 1, playerId: 1, isAI: false },
  { seat: 2, playerId: null, isAI: true, computer: 1 },
  { seat: 3, playerId: null, isAI: true, computer: 1 },
];

function makeMap(): MapFullData {
  const rows = 3;
  const columns = 3;
  const battlefield: BattlefieldTile[] = Array.from({ length: rows * columns }, (_, i) =>
    i === 0 ? [0, 1, 1] : [0, 128, 0],
  );
  const triggers: TriggerDef[] = [
    {
      id: 'clear-player',
      class: 'action',
      when: { op: 'tile_owner_appeared', tile: 1, force: 1 },
      effects: [{ op: 'clear_force', force: 1 }],
    },
    {
      id: 'transfer',
      class: 'action',
      when: { op: 'force_gone', force: 1 },
      effects: [{ op: 'transfer_control', to_force: 2, ai_level: 1 }],
    },
  ];
  return {
    id: 'pve-control',
    version: 1,
    title: '控制转移',
    description: '',
    author: 'test',
    timestamp: '2026-01-01 00:00:00.0',
    row: rows,
    column: columns,
    random_spawn: false,
    cylindrical_map: false,
    fog_mode: false,
    online_time_settings: { total_time: 600, round_time: 60, time_bonus: 0 },
    tags: [],
    player_num: 3,
    player_list: [
      { name: '红方', team: 1, computer: 255, seat: 1, flag: 1 },
      { name: '蓝方', team: 2, computer: 255, seat: 2, flag: 2 },
      { name: '绿方', team: 3, computer: 255, seat: 3, flag: 3 },
    ],
    battlefield,
    trigger_schema_version: 1,
    triggers,
  };
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('战役控制转移（transport + store）', () => {
  let transport: PveTransport | null = null;

  afterEach(() => {
    transport?.close();
    transport = null;
    useGame.getState().reset();
  });

  it('switches mySeat to the new force and accepts its intent', async () => {
    const map = makeMap();
    const config: PveGameConfig = {
      gameId: 'pve-control-1',
      map,
      mapTitle: map.title,
      seatAssignments: SEATS,
      seed: 'control-seed',
      timeSettings: TIME,
      fogMode: false,
      usePersonalSkin: false,
      playerSeat: 1,
      humanUserId: 1,
      reducerVersion: 'test',
      campaign: true,
    };
    const init = initState({
      map,
      seatAssignments: SEATS,
      timeSettings: TIME,
      seed: config.seed,
      triggerMode: true,
      controlledSeat: 1,
      humanPlayerId: 1,
    });
    transport = new PveTransport({ config, initialState: init.state, stepDelayMs: 0 });
    useGame.getState().reset();
    attachTransport(transport);
    useGame.getState().startPveGame({
      roomId: 'pve',
      gameId: config.gameId,
      state: init.state,
      chain: init.chain,
      seatAssignments: config.seatAssignments,
      myUserId: config.humanUserId,
      fogMode: config.fogMode,
      map,
    });
    await transport.connect();

    expect(useGame.getState().mySeat).toBe(1);
    useGame.getState().submitIntent({ intentType: 'MOVE', from: 0, to: 1 });

    await waitFor(() => useGame.getState().board?.controlledSeat === 2);
    const b = useGame.getState().board!;
    expect(b.finished).toBe(false);
    expect(useGame.getState().mySeat).toBe(2);
    expect(useGame.getState().undoAvailable).toBe(false);
    expect(b.forces.find((f) => f.seat === 2)).toMatchObject({ isAI: false, playerId: 1 });

    useGame.getState().submitIntent({ intentType: 'SWITCH_PHASE' });
    await waitFor(() => useGame.getState().board?.phase === 'ADD_POINT');
    expect(useGame.getState().board?.phase).toBe('ADD_POINT');
  });
});
