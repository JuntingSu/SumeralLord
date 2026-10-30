import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashGameState, initState, stableStringify } from '@dl/shared';
import type { BattlefieldTile, MapFullData, PveGameConfig, SeatAssignment } from '@dl/shared';
import { attachTransport, useGame } from '../src/stores/game';
import { PveTransport } from '../src/game/pveTransport';

const TIME = { stepTime: 90, gameTime: 1200, additionalTime: 0 };
const SEAT_ASSIGNMENTS: SeatAssignment[] = [
  { seat: 1, playerId: 1, isAI: false },
  { seat: 2, playerId: null, isAI: true, computer: 1 },
];

/** 4×5：seat1 平原兵(0,力5)，seat2 平原兵(1,力3) */
function makeMap(): MapFullData {
  const rows = 4;
  const columns = 5;
  const battlefield: BattlefieldTile[] = Array.from({ length: rows * columns }, (_, i) =>
    i === 0 ? [0, 1, 5] : i === 1 ? [0, 2, 3] : [0, 128, 0],
  );
  return {
    id: 'pve-test',
    version: 1,
    title: 'PVE 测试',
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
    player_num: 2,
    player_list: [
      { name: '红方', team: 1, computer: 255, seat: 1, flag: 1 },
      { name: '蓝方', team: 2, computer: 255, seat: 2, flag: 2 },
    ],
    battlefield,
  };
}

function makeConfig(map: MapFullData): PveGameConfig {
  return {
    gameId: 'pve-test-1',
    map,
    mapTitle: map.title,
    seatAssignments: SEAT_ASSIGNMENTS,
    seed: 'pve-seed',
    timeSettings: TIME,
    fogMode: false,
    usePersonalSkin: false,
    playerSeat: 1,
    humanUserId: 1,
    reducerVersion: 'test',
  };
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function startPve(transportStepDelayMs = 0): PveTransport {
  const map = makeMap();
  const config = makeConfig(map);
  const init = initState({ map, seatAssignments: SEAT_ASSIGNMENTS, timeSettings: TIME, seed: config.seed });
  const transport = new PveTransport({ config, initialState: init.state, stepDelayMs: transportStepDelayMs });
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
  void transport.connect();
  return transport;
}

describe('PveTransport + 对局 store', () => {
  let transport: PveTransport | null = null;

  beforeEach(() => {
    useGame.getState().reset();
  });

  afterEach(() => {
    transport?.close();
    transport = null;
    useGame.getState().reset();
  });

  it('玩家结束回合后简单 AI 自动行动并回到玩家', async () => {
    transport = startPve();
    expect(useGame.getState().board?.currentSeat).toBe(1);
    expect(useGame.getState().board?.phase).toBe('ACTION');

    useGame.getState().submitIntent({ intentType: 'SWITCH_PHASE' }); // ACTION → ADD_POINT
    useGame.getState().submitIntent({ intentType: 'SWITCH_PHASE' }); // → 结束，轮到 AI

    await waitFor(() => {
      const b = useGame.getState().board;
      return Boolean(b && b.currentSeat === 1 && useGame.getState().appliedEventId >= 3);
    });
    const b = useGame.getState().board!;
    expect(b.currentSeat).toBe(1);
    expect(useGame.getState().appliedEventId).toBeGreaterThanOrEqual(3);
  });

  it('悔棋回退最后一条玩家意图，eventId 可复用，AI 不被触发', async () => {
    transport = startPve();
    const before = useGame.getState().board!;
    const beforeHash = hashGameState(before);

    useGame.getState().submitIntent({ intentType: 'MOVE', from: 0, to: 5 });
    await waitFor(() => useGame.getState().appliedEventId === 1);
    const afterMove = useGame.getState().board!;
    expect(hashGameState(afterMove)).not.toBe(beforeHash);
    expect(useGame.getState().undoAvailable).toBe(true);

    useGame.getState().undoLastIntent();
    const restored = useGame.getState().board!;
    expect(stableStringify(restored)).toBe(stableStringify(before));
    expect(useGame.getState().appliedEventId).toBe(0);
    expect(useGame.getState().undoAvailable).toBe(false);

    // eventId 复用：悔棋后再走同一步仍从 1 开始
    useGame.getState().submitIntent({ intentType: 'MOVE', from: 0, to: 5 });
    await waitFor(() => useGame.getState().appliedEventId === 1);
    expect(hashGameState(useGame.getState().board!)).toBe(hashGameState(afterMove));
  });

  it('AI 行动后清空悔棋栈', async () => {
    transport = startPve();
    useGame.getState().submitIntent({ intentType: 'SWITCH_PHASE' });
    useGame.getState().submitIntent({ intentType: 'SWITCH_PHASE' });
    await waitFor(() => useGame.getState().board?.currentSeat === 1 && useGame.getState().appliedEventId >= 3);
    expect(useGame.getState().undoAvailable).toBe(false);
  });

  it('投降触发本地共识确认与 GAME_OVER', async () => {
    transport = startPve();
    useGame.getState().submitIntent({ intentType: 'SURRENDER', seat: 1, reason: 'voluntary' });
    await waitFor(() => useGame.getState().gameOver !== null);
    const over = useGame.getState().gameOver!;
    expect(over.type).toBe('GAME_OVER');
    expect(over.winningTeam).toBe(2);
    expect(over.winners).toEqual([]);
    expect(useGame.getState().undoAvailable).toBe(false);
  });

  it('snapshot 返回与 store 一致的完整 GameState', async () => {
    transport = startPve();
    useGame.getState().submitIntent({ intentType: 'MOVE', from: 0, to: 5 });
    await waitFor(() => useGame.getState().appliedEventId === 1);
    const snap = transport.snapshot();
    expect(stableStringify(snap.state)).toBe(stableStringify(useGame.getState().board!));
    expect(snap.meta).toMatchObject({
      turn: useGame.getState().board!.turn,
      phase: useGame.getState().board!.phase,
      currentSeat: useGame.getState().board!.currentSeat,
    });
  });

  it('restorePveGame 直接落完整状态：无历史动画、eventId 从 0 重新开始', async () => {
    transport = startPve();
    useGame.getState().submitIntent({ intentType: 'MOVE', from: 0, to: 5 });
    await waitFor(() => useGame.getState().appliedEventId === 1);
    const snap = transport.snapshot();
    const map = makeMap();
    const config = makeConfig(map);
    transport.close();
    transport = null;
    useGame.getState().reset();

    const restored = new PveTransport({ config, initialState: snap.state, stepDelayMs: 0 });
    transport = restored;
    attachTransport(restored);
    useGame.getState().restorePveGame({
      roomId: 'pve',
      gameId: config.gameId,
      state: snap.state,
      seatAssignments: config.seatAssignments,
      myUserId: config.humanUserId,
      fogMode: config.fogMode,
      map,
    });
    void restored.connect();

    const board = useGame.getState().board!;
    expect(stableStringify(board)).toBe(stableStringify(snap.state));
    expect(useGame.getState().eventQueue).toEqual([]);
    expect(useGame.getState().appliedEventId).toBe(0);
    expect(useGame.getState().undoAvailable).toBe(false);

    useGame.getState().submitIntent({ intentType: 'SWITCH_PHASE' });
    await waitFor(() => useGame.getState().appliedEventId === 1);
  });
});
