// EventAnimator 单测（M5.1）：播放推进 / 动画态推进 / 演出控制（暂停/单步/变速/快进）/ 多链
// 时间线由 frame(now) 参数驱动（不依赖真实时钟），确定性可测。
import { describe, it, expect } from 'vitest';
import { EventAnimator, EVENT_DURATION, type EventQueueItem } from '../src/canvas/animator';
import { applyIntent, initState } from '@dl/shared';
import type {
  BattlefieldTile,
  GameEvent,
  MapFullData,
  PlayerIntent,
  SeatAssignment,
  SoldierState,
} from '@dl/shared';

function soldier(owner: number, strength = 1, isLinked = true): SoldierState {
  return { owner, strength, isLinked, hasMovement: true, counter: 1 };
}

function item(chain: GameEvent[], beforeTiles: Array<SoldierState | null> = []): EventQueueItem {
  return { chain, beforeTiles };
}

/** 队列驱动的测试封装：真实 pop 语义 */
function makeAnim(initial: EventQueueItem[] = []) {
  let queue = initial;
  const anim = new EventAnimator(
    () => queue,
    () => {
      queue = queue.slice(1);
    },
  );
  return { anim, get queue() { return queue; } };
}

const SWITCH = (): GameEvent => ({ level: 1, kind: 'SWITCH_PHASE', seat: 1, from: 'PREPARE', to: 'ACTION' });
const ADD_POINT = (): GameEvent => ({ level: 1, kind: 'ADD_POINT', seat: 1, coordinate: 3, amount: 1 });

describe('EventAnimator 取链与播放推进', () => {
  it('队列空返回 null；isPlaying 为 false', () => {
    const { anim } = makeAnim();
    expect(anim.frame(0)).toBeNull();
    expect(anim.isPlaying).toBe(false);
  });

  it('有链时取第一条并播放，progress 随事件时长推进', () => {
    const { anim } = makeAnim([item([SWITCH()])]);
    const dur = EVENT_DURATION.SWITCH_PHASE;
    const f0 = anim.frame(0); // 取链帧：当前事件进度 0
    expect(f0).not.toBeNull();
    expect(f0!.event!.kind).toBe('SWITCH_PHASE');
    expect(f0!.progress).toBe(0);
    expect(anim.isPlaying).toBe(true);
    expect(anim.frame(dur / 2)!.progress).toBeCloseTo(0.5);
  });

  it('事件按时长逐个推进；链播完自动弹出队列并返回 null', () => {
    const m = makeAnim([
      item([
        { level: 1, kind: 'ADD_POINT', seat: 1, coordinate: 3, amount: 1 },
        { level: 2, kind: 'UPDATE', tile: 3, before: soldier(1, 1), after: soldier(1, 2) },
      ]),
    ]);
    const d1 = EVENT_DURATION.ADD_POINT;
    const d2 = EVENT_DURATION.UPDATE;
    m.anim.frame(0); // 取链
    expect(m.anim.frame(d1)!.event!.kind).toBe('UPDATE'); // 播完第一个事件 → 进入第二个
    expect(m.queue.length).toBe(1); // 链未播完不弹出
    expect(m.anim.frame(d1 + d2)).toBeNull(); // 链播完 → null
    expect(m.queue.length).toBe(0);
    expect(m.anim.isPlaying).toBe(false);
  });

  it('多链连续播放：链条交界帧返回「链末态」帧，最后一条播完才返回 null', () => {
    const m = makeAnim([item([SWITCH()]), item([SWITCH()])]);
    const dur = EVENT_DURATION.SWITCH_PHASE;
    m.anim.frame(0); // 取链（第一条）
    const boundary = m.anim.frame(dur); // 第一条链播完：队列仍有待播链 → 链末态帧（不回落当前局面）
    expect(boundary).not.toBeNull();
    expect(boundary!.event).toBeNull();
    expect(m.queue.length).toBe(1);
    expect(m.anim.frame(dur + 1)!.event!.kind).toBe('SWITCH_PHASE'); // 下一帧取第二条
    expect(m.queue.length).toBe(1); // 第二条播放中未弹出
    expect(m.anim.frame(dur + 1 + dur)).toBeNull(); // 队列排空（已追平）→ null
    expect(m.queue.length).toBe(0);
  });

  it('回归：队列未排空前 frame() 不返回 null（回放期间不回落当前局面，防交替闪烁）', () => {
    const m = makeAnim([item([SWITCH()]), item([ADD_POINT()]), item([SWITCH()])]);
    const total = EVENT_DURATION.SWITCH_PHASE * 2 + EVENT_DURATION.ADD_POINT;
    let firstNullAt = -1;
    for (let i = 0, t = 0; i < 600; i++, t += 1) {
      const f = m.anim.frame(t);
      if (f === null) {
        // 不变量：返回 null ⟺ 队列已排空且无播放（回放已追平最新）
        expect(m.queue.length).toBe(0);
        expect(m.anim.isPlaying).toBe(false);
        if (firstNullAt < 0) firstNullAt = t;
      }
    }
    expect(m.queue.length).toBe(0);
    // 三条链全部播完（两个交界帧各占 1 帧）之后才可能出现 null
    expect(firstNullAt).toBeGreaterThanOrEqual(total);
  });

  it('INIT 零时长事件立即通过', () => {
    const { anim } = makeAnim([
      item([
        { level: 1, kind: 'INIT' },
        { level: 1, kind: 'SWITCH_PHASE', seat: 1, from: 'PREPARE', to: 'ACTION' },
      ]),
    ]);
    const f = anim.frame(0); // 取链即播完 INIT → 当前事件为 SWITCH_PHASE
    expect(f!.event!.kind).toBe('SWITCH_PHASE');
  });
});

describe('EventAnimator 动画态推进（与 reducer 语义一致）', () => {
  it('SPAWN → UPDATE → DESPAWN 序列推进 tiles', () => {
    const { anim } = makeAnim([
      item(
        [
          { level: 2, kind: 'SPAWN', tile: 0, soldier: soldier(1, 1) },
          { level: 2, kind: 'UPDATE', tile: 0, before: soldier(1, 1), after: soldier(1, 3) },
          { level: 2, kind: 'DESPAWN', tile: 2, soldier: soldier(1, 2) },
        ],
        [null, null, soldier(1, 2)],
      ),
    ]);
    const d1 = EVENT_DURATION.SPAWN;
    const d2 = EVENT_DURATION.UPDATE;
    const d3 = EVENT_DURATION.DESPAWN;
    anim.frame(0); // 取链（SPAWN 起始）
    expect(anim.frame(d1)!.event!.kind).toBe('UPDATE');
    expect(anim.currentTiles[0]).toEqual(soldier(1, 1)); // SPAWN 已落位
    expect(anim.frame(d1 + d2)!.event!.kind).toBe('DESPAWN');
    expect(anim.currentTiles[0]).toEqual(soldier(1, 3)); // UPDATE 已生效
    anim.frame(d1 + d2 + d3); // 链播完
    expect(anim.currentTiles[2]).toBeNull(); // DESPAWN 已移除
  });

  it('BREAK_JUDGE 未连通：region 内断兵 -1，归零删兵', () => {
    const { anim } = makeAnim([
      item(
        [{ level: 4, kind: 'BREAK_JUDGE', tile: 0, connected: false, region: [0, 1, 2] }],
        [soldier(1, 3, true), soldier(1, 1, true), null],
      ),
    ]);
    const dur = EVENT_DURATION.BREAK_JUDGE;
    anim.frame(0);
    anim.frame(dur); // 播完
    const t0 = anim.currentTiles[0]!;
    expect(t0.strength).toBe(2);
    expect(t0.isLinked).toBe(false);
    expect(anim.currentTiles[1]).toBeNull(); // 1-1=0 → 删兵
  });

  it('BREAK 分支高亮在播完时设置；BREAK_JUDGE 已连通清空高亮且不扣血', () => {
    const { anim } = makeAnim([
      item(
        [
          { level: 3, kind: 'BREAK', tile: 0, branches: [3, 5] },
          { level: 4, kind: 'BREAK_JUDGE', tile: 3, connected: true, region: [] },
        ],
        [soldier(1, 3), null, null, soldier(1, 2)],
      ),
    ]);
    const d1 = EVENT_DURATION.BREAK;
    const d2 = EVENT_DURATION.BREAK_JUDGE;
    anim.frame(0); // BREAK 起始
    expect(anim.frame(d1 - 1)!.breakTiles).toEqual([]); // 播放中未设置
    expect(anim.frame(d1)!.breakTiles).toEqual([3, 5]); // BREAK 播完 → 高亮设置
    expect(anim.frame(d1 + d2 - 1)!.breakTiles).toEqual([3, 5]); // BREAK_JUDGE 播放中高亮保持
    expect(anim.frame(d1 + d2)).toBeNull(); // BREAK_JUDGE 播完（已连通）→ 链完
    expect(anim.currentTiles[3]!.strength).toBe(2); // 不扣血
  });

  it('FORCE_CLEAR 记录清除势力（红闪来源），保持到链播完', () => {
    const { anim } = makeAnim([
      item(
        [
          { level: 4, kind: 'FORCE_CLEAR', seat: 2, reason: 'timeout' },
          SWITCH(),
        ],
        [],
      ),
    ]);
    const d1 = EVENT_DURATION.FORCE_CLEAR;
    anim.frame(0);
    expect(anim.frame(d1)!.event!.kind).toBe('SWITCH_PHASE');
    expect(anim.frame(d1)!.clearingSeats).toEqual([2]);
  });
});

describe('EventAnimator 演出控制', () => {
  it('变速：2x 时长减半', () => {
    const { anim } = makeAnim([item([SWITCH()])]);
    const dur = EVENT_DURATION.SWITCH_PHASE;
    anim.setSpeed(2);
    anim.frame(0); // 取链
    expect(anim.frame(dur / 2)).toBeNull(); // 2x 下半个时长即播完
  });

  it('暂停冻结进度，恢复后从冻结点继续', () => {
    const { anim } = makeAnim([item([SWITCH()])]);
    const dur = EVENT_DURATION.SWITCH_PHASE;
    anim.frame(0);
    anim.frame(dur / 4); // 进度 0.25
    anim.setPaused(true, dur / 4); // 暂停（冻结于 0.25）
    const p1 = anim.frame(20_000)!.progress; // 暂停后任意时间进度不变
    expect(p1).toBeCloseTo(0.25);
    expect(anim.frame(30_000)!.progress).toBe(p1);
    anim.setPaused(false, 30_000); // 恢复：从冻结点（0.25）继续
    expect(anim.frame(30_000)!.progress).toBeCloseTo(0.25);
    expect(anim.frame(30_000 + (dur * 3) / 4)).toBeNull(); // 再播剩余 3/4 时长即完成
  });

  it('单步：立即结束当前事件推进到下一事件', () => {
    const { anim } = makeAnim([
      item([
        { level: 1, kind: 'ADD_POINT', seat: 1, coordinate: 3, amount: 1 },
        { level: 2, kind: 'UPDATE', tile: 3, before: soldier(1, 1), after: soldier(1, 2) },
      ]),
    ]);
    anim.frame(0);
    expect(anim.frame(0)!.event!.kind).toBe('ADD_POINT');
    anim.step();
    expect(anim.frame(0)!.event!.kind).toBe('UPDATE'); // 已推进
  });

  it('快进 reset：停止播放；队列由调用方清空后不再取链', () => {
    const { anim, queue } = makeAnim([item([SWITCH()])]);
    anim.frame(0);
    expect(anim.isPlaying).toBe(true);
    anim.reset();
    expect(anim.isPlaying).toBe(false);
    expect(queue.length).toBe(1); // reset 不清队列（快进按钮组合 clearEventQueue）
    // 清队列后 frame 返回 null
    queue.length = 0;
    expect(anim.frame(0)).toBeNull();
  });
});

// ---------- 等价性守卫（回放期间画面权威 = animator 动画态） ----------
// 修复后：队列未排空前渲染层只画 animator 的动画态，不再回落权威 board；因此链末态必须与
// reducer 权威态逐地块一致，否则回放结束后会出现一次"跳变"。用真实 reducer 链驱动验证。
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

/** 按意图序驱动 reducer，并把每条链（含链前兵表快照）交给 animator 逐帧播完 */
function driveAndPlay(map: MapFullData, intents: Array<{ seat: number; intent: PlayerIntent }>) {
  let state = initState({ map, seatAssignments: ASG, timeSettings: TIME, seed: 'test-seed' }).state;
  let queue: EventQueueItem[] = [];
  const kinds: string[] = [];
  for (const { seat, intent } of intents) {
    const r = applyIntent(state, { actor: { kind: 'PLAYER', seat }, intent });
    if (!r.ok) throw new Error(`意图被拒：seat ${seat} ${intent.intentType}（${r.reason}）`);
    const beforeTiles = state.tiles.map((t) => (t.soldier ? { ...t.soldier } : null));
    state = r.state;
    kinds.push(...r.chain.map((e) => e.kind));
    queue = [...queue, { chain: r.chain, beforeTiles }];
  }
  const anim = new EventAnimator(
    () => queue,
    () => {
      queue = queue.slice(1);
    },
  );
  for (let i = 0, t = 0; (queue.length > 0 || anim.isPlaying) && i < 10_000; i++, t += 1000) anim.frame(t);
  return { state, anim, kinds };
}

describe('EventAnimator 动画态与 reducer 权威态等价', () => {
  it('MOVE 链（SPAWN/UPDATE/REJOIN）：动画态与权威态一致', () => {
    // seat1 连兵网络 6(据点) - 7 - 13；7(str2) 移动至空地 8
    const map = makeMap({ 6: [CITY, 1, 2], 7: [PLAIN, 1, 2], 13: [PLAIN, 1, 2], 2: [CITY, 2, 6] });
    const { state, anim, kinds } = driveAndPlay(map, [{ seat: 1, intent: { intentType: 'MOVE', from: 7, to: 8 } }]);
    expect(kinds).toEqual(expect.arrayContaining(['MOVE', 'SPAWN', 'UPDATE']));
    expect(anim.currentTiles).toEqual(state.tiles.map((t) => t.soldier));
  });

  it('ATTACK 致断连锁（DESPAWN/BREAK/BREAK_JUDGE）：动画态与权威态一致', () => {
    // seat2 据点 2(str6) 击杀 7(str2) → 13 失连（断兵、兵力 -1）
    const map = makeMap({ 6: [CITY, 1, 2], 7: [PLAIN, 1, 2], 13: [PLAIN, 1, 2], 2: [CITY, 2, 6] });
    const { state, anim, kinds } = driveAndPlay(map, [
      { seat: 1, intent: { intentType: 'SWITCH_PHASE' } }, // 行动 → 加点
      { seat: 1, intent: { intentType: 'SWITCH_PHASE' } }, // 加点 → 结束（轮转至 seat2）
      { seat: 2, intent: { intentType: 'ATTACK', from: 2, to: 7 } },
    ]);
    expect(kinds).toEqual(expect.arrayContaining(['DESPAWN', 'BREAK', 'BREAK_JUDGE']));
    expect(state.tiles[13].soldier).toMatchObject({ isLinked: false, strength: 1 });
    expect(anim.currentTiles).toEqual(state.tiles.map((t) => t.soldier));
  });
});
