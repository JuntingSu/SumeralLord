// 观战/重连回放积压的显示回归（P0）：沿"新加入观战 → 全量重放"真实路径喂 store，
// 断言**积压未播完之前 EventAnimator 不返回 null**——即渲染层（BoardCanvas: af ? af.tiles : boardSoldiers）
// 不会回落渲染权威 board（= 最新局面），也就不会出现"回放位置 ↔ 最新局面"交替的高频闪烁。
import { describe, it, expect, beforeEach } from 'vitest';
import { applyIntent, initState } from '@dl/shared';
import type {
  BattlefieldTile,
  GameStartMsg,
  MapFullData,
  PlayerIntent,
  SeatAssignment,
  SoldierState,
} from '@dl/shared';
import { EventAnimator } from '../src/canvas/animator';
import { useGame } from '../src/stores/game';

const PLAIN = 0;
const CITY = 1;
const EMPTY = 128;
const TIME = { stepTime: 90, gameTime: 1200, additionalTime: 0 };
const ASG: SeatAssignment[] = [
  { seat: 1, playerId: 101, isAI: false },
  { seat: 2, playerId: 102, isAI: false },
];

/** 小地图（4 行 5 列；tiles: index → [地形, 归属, 兵力]，未列出为 [平原, 无主, 0]） */
function makeMap(tiles: Record<number, [number, number, number]>): MapFullData {
  const rows = 4;
  const columns = 5;
  const battlefield: BattlefieldTile[] = Array.from(
    { length: rows * columns },
    (_, i): [number, number, number] => tiles[i] ?? [PLAIN, EMPTY, 0],
  );
  return {
    id: 'test-map',
    version: 1,
    title: '测试图',
    description: '',
    author: 'test',
    timestamp: '2026-08-16 00:00:00.0',
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

function tilesOf(state: { tiles: Array<{ soldier: SoldierState | null }> }): Array<SoldierState | null> {
  return state.tiles.map((t) => t.soldier);
}

/** 用真实 reducer 驱动一串意图，产出与服务器下发同构的 INTENT_BROADCAST 批次（eventId 自 1 递增） */
function buildBatch(
  map: MapFullData,
  intents: PlayerIntent[],
): { batch: Array<Record<string, unknown>>; state: ReturnType<typeof initState>['state'] } {
  let state = initState({ map, seatAssignments: ASG, timeSettings: TIME, seed: 'test-seed' }).state;
  const batch: Array<Record<string, unknown>> = [];
  for (const intent of intents) {
    const seat = state.currentSeat;
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat }, intent });
    if (!r.ok) throw new Error(`脚本意图被拒：seat ${seat} ${intent.intentType}（${r.reason}）`);
    batch.push({ type: 'INTENT_BROADCAST', from: String(seat), fromSeat: seat, intent, eventId: batch.length + 1 });
    state = r.state;
  }
  return { batch, state };
}

/** 双势力交替推进若干回合：每回合 2 次 SWITCH_PHASE 轮转（含准备阶段刷移动力/反击的 UPDATE），
 *  并在可加点时补一条 ADD_POINT（改变兵力 → 回放位置与最终局面必然不同，便于验证"不回落当前局面"）。 */
function scriptIntents(map: MapFullData, rounds: number): PlayerIntent[] {
  let state = initState({ map, seatAssignments: ASG, timeSettings: TIME, seed: 'test-seed' }).state;
  const out: PlayerIntent[] = [];
  const push = (intent: PlayerIntent) => {
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat: state.currentSeat }, intent });
    if (!r.ok) return false;
    state = r.state;
    out.push(intent);
    return true;
  };
  for (let i = 0; i < rounds; i++) {
    const seat = state.currentSeat;
    const force = state.forces.find((f) => f.seat === seat);
    if (state.phase === 'ACTION' && force && force.points > 0) {
      // 己方连兵所在地块
      const tile = state.tiles.findIndex((t) => t.soldier && t.soldier.owner === seat && t.soldier.isLinked);
      if (tile >= 0) push({ intentType: 'ADD_POINT', coordinate: tile, amount: 1 });
    }
    while (state.currentSeat === seat && out.length < 500) {
      if (!push({ intentType: 'SWITCH_PHASE' })) break;
    }
  }
  return out;
}

const MAP = makeMap({
  6: [CITY, 1, 4],
  7: [PLAIN, 1, 3],
  13: [PLAIN, 1, 3],
  2: [CITY, 2, 4],
  3: [PLAIN, 2, 3],
  4: [PLAIN, 2, 3],
});

describe('观战/重连回放积压：不回落当前局面（防交替闪烁）', () => {
  beforeEach(() => useGame.getState().reset());

  it('积压未播完前 frame() 不返回 null；播完才与权威 board 一致', () => {
    const map = MAP;
    const { batch, state: finalState } = buildBatch(map, scriptIntents(map, 6));
    expect(batch.length).toBeGreaterThan(10); // 场景须形成足够的回放积压

    // 新加入观战者：startGame（myUserId 不在席位 → isSpectator）→ 收到整段重放批次
    const startMsg: GameStartMsg = {
      type: 'GAME_START',
      roomId: 'r-test',
      gameId: 'g-test',
      map,
      seatAssignments: ASG,
      spawnAssignments: [],
      seed: 'test-seed',
      timeSettings: TIME,
      reducerVersion: 'test',
    };
    useGame.getState().startGame({ roomId: 'r-test', startMsg, myUserId: 999, fogMode: false });
    expect(useGame.getState().isSpectator).toBe(true);
    useGame.getState().onServerMessage({
      type: 'RECONNECT_ACK',
      gameId: 'g-test',
      lastEventId: batch.length,
      batch,
      nextBatchCursor: 0,
    });

    // 重放批次已全部应用到权威 board（游标追平），但动画队列仍积压整段历史
    const applied = useGame.getState();
    expect(applied.appliedEventId).toBe(batch.length);
    expect(applied.eventQueue.length).toBe(batch.length);

    const anim = new EventAnimator(
      () => useGame.getState().eventQueue,
      () => useGame.getState().popChain(),
    );
    let sawBehindBoard = false; // 播放位置与"当前局面"不同（闪烁前提）
    let framesWithBacklog = 0;
    /** 仍有余量却返回 null 的帧数：旧实现每播完一条链就出现一次（渲染层当帧回落渲染最新局面） */
    let nullWithBacklog = 0;
    for (let i = 0, t = 0; i < 20_000; i++, t += 50) {
      const before = useGame.getState().eventQueue.length;
      const frame = anim.frame(t);
      const after = useGame.getState().eventQueue.length;
      if (before > 0) framesWithBacklog += 1;
      if (before > 0 && frame === null) nullWithBacklog += 1;
      // 核心不变量（BoardCanvas：af ? af.tiles : boardSoldiers）：回放仍有余量就不得返回 null，
      // 否则该帧会回落渲染权威 board = 最新局面，与回放位置交替显示造成高频闪烁。
      if (after > 0) {
        expect(frame).not.toBeNull();
        const board = useGame.getState().board!;
        if (anim.currentTiles.length > 0 && JSON.stringify(anim.currentTiles) !== JSON.stringify(tilesOf(board))) {
          sawBehindBoard = true;
        }
      }
      if (after === 0 && !anim.isPlaying) break;
    }
    expect(framesWithBacklog).toBeGreaterThan(10);
    expect(nullWithBacklog).toBeLessThanOrEqual(1); // 至多最后一条链播完那一帧（此时已追平）
    expect(sawBehindBoard).toBe(true); // 回放期间画的是历史位置，而不是最新局面
    // 播完后动画态与权威态收敛（不会跳变）
    expect(anim.currentTiles).toEqual(tilesOf(finalState));
  });

  it('空队列时仍返回 null（追平后正常回落权威 board）', () => {
    const anim = new EventAnimator(
      () => useGame.getState().eventQueue,
      () => useGame.getState().popChain(),
    );
    expect(useGame.getState().eventQueue.length).toBe(0);
    expect(anim.frame(0)).toBeNull();
  });
});
