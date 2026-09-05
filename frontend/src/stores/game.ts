// 对局状态机（前端规划 §4.2 / §5.1）：前端本地权威。
// - boardState：reducer 演算结果（权威）；eventQueue：动画队列（与状态解耦）
// - appliedEventId 游标：严格按 eventId 序应用；跳号（EVENT_GAP）→ 补发拉取后继续
// - 演算到共识节点立即上报（与动画解耦）；CONSENSUS_CONFIRMED 与本地比对
// - 回合轮转驱动计时器（规则 v2 §10）；计时归零 → 本地发起超时投降意图
import { create } from 'zustand';
import type {
  ConsensusPayload,
  GameEvent,
  GameOverMsg,
  GameStartMsg,
  MapFullData,
  PlayerIntent,
  RoomServerMsg,
  RoomTimeSettings,
  SeatAssignment,
  SoldierState,
} from '@dl/shared';
import { applyIntent, initState } from '@dl/shared';
import type { GameState } from '@dl/shared';
import { collectConsensusNodes, sameConsensus } from '../game/consensus';
import { initialTimer, onTurnChange, tick, type TimerState } from '../game/timer';
import type { EventQueueItem } from '../canvas/animator';
import type { ChatEntry } from './room';
import type { WsStatus } from '../ws/client';

export interface GameTransport {
  onMessage(handler: (msg: RoomServerMsg) => void): () => void;
  onStatus(handler: (status: WsStatus) => void): () => void;
  connect(): Promise<void>;
  close(): void;
  submitIntent(clientTempId: string, intent: PlayerIntent): void;
  submitConsensus(consensusId: string, result: ConsensusPayload): void;
  sendTimeSync(gameId: string, seat: number, stepTimeRemain: number, gameTimeRemain: number): void;
  sendReconnect(lastEventId: number, gameId: string): void;
  /** 对局内聊天（M5.3） */
  sendChat(text: string): boolean;
  /** 结算页关闭上报（对局结束后；全员上报后房间立即回落等待中） */
  sendSettlementDismissed(gameId: string): void;
  /** EVENT_GAP / RECONNECT 续拉（同构接口） */
  fetchEvents(gameId: string, after: number, limit?: number): Promise<{ events: Array<Record<string, unknown>>; nextCursor: number }>;
}

let tempIdSeq = 0;
function nextTempId(): string {
  tempIdSeq += 1;
  return `c${Date.now().toString(36)}-${tempIdSeq}`;
}

export interface FatalError {
  code: string;
  message: string;
}

interface GameStore {
  /** 对局传输通道（真实 WS 或 Mock；由 attachTransport 注入，不参与渲染） */
  transport: GameTransport | null;
  gameId: string | null;
  roomId: string | null;
  map: MapFullData | null;
  seatAssignments: SeatAssignment[] | null;
  mySeat: number | null;
  isSpectator: boolean;
  timeSettings: RoomTimeSettings;
  fogMode: boolean;

  board: GameState | null;
  appliedEventId: number;
  /** 动画队列：事件链 + 链应用前兵表快照（M5.1 动画插值用；board 权威不变） */
  eventQueue: EventQueueItem[];
  lastChain: GameEvent[];
  /** clientTempId → eventId（ACK 关联表） */
  ackMap: Record<string, number>;
  /** 本端已提交待 ACK 的意图（clientTempId → intent） */
  localIntents: Record<string, PlayerIntent>;
  /** 已上报待确认的共识（consensusId → payload） */
  pendingConsensus: Record<string, ConsensusPayload>;
  /** 加点长按当前目标地块（UI 交互状态） */
  lastPointTile: number | null;

  connection: WsStatus;
  timer: TimerState;
  /** TIME_SYNC 校正的对手计时显示 */
  opponentClocks: Record<number, { stepTimeRemain: number; gameTimeRemain: number }>;
  /** 断线状态（PLAYER_DISCONNECT 的 seat 集合） */
  disconnectedSeats: number[];

  gameOver: GameOverMsg | null;
  fatal: FatalError | null;
  /** 客户端意图发送回执（用于 UI 禁用反馈） */
  submitting: boolean;
  /** 对局内聊天记录（M5.3；房间期聊天由 room store 维护） */
  chat: ChatEntry[];

  /** 我方回合/行动阶段/加点阶段开始提示队列（实时路径收集；重连重放不触发） */
  phaseAnnouncements: string[];
  /** 局内系统通知队列（实时路径收集；重连重放不触发；页面 drain 后转聊天/飘字） */
  systemNotices: SystemNotice[];
  /** 本局击杀计数（seat → 击杀数；驱动「大杀四方」通知） */
  killCounts: Record<number, number>;

  startGame(params: { roomId: string; startMsg: GameStartMsg; myUserId: number | null; fogMode: boolean }): void;
  onServerMessage(msg: RoomServerMsg): void;
  onStatus(status: WsStatus): void;
  submitIntent(intent: PlayerIntent): void;
  /** 超时投降（本地计时归零） */
  submitTimeoutSurrender(): void;
  /** 对局内聊天（M5.3）：返回是否发送成功 */
  sendChat(text: string): boolean;
  tickClock(): void;
  /** 动画播放器弹出已播完的链 */
  popChain(): void;
  /** 快进：清空动画队列（动画播放器另调 reset） */
  clearEventQueue(): void;
  /** 断线重连后全量重放追平 */
  reconnectCatchUp(): void;
  /** 原子取出并清空阶段提示队列（消费与追加不竞态） */
  drainPhaseAnnouncements(): string[];
  /** 原子取出并清空系统通知队列（消费与追加不竞态） */
  drainSystemNotices(): SystemNotice[];
  /** 追加一条本地系统聊天（kind:'system'，橙色渲染） */
  pushSystemChat(text: string): void;
  reset(): void;
}

type ApplyOutcome = 'applied' | 'duplicate' | 'gap' | 'ignored';

/** 从事件链提取我方回合/阶段开始提示（END_TURN 转到己座；SWITCH_PHASE 切入 ACTION/ADD_POINT） */
function collectPhaseAnnouncements(chain: GameEvent[], mySeat: number | null): string[] {
  if (mySeat === null) return [];
  const out: string[] = [];
  for (const e of chain) {
    if (e.kind === 'END_TURN' && e.toSeat === mySeat) out.push('你的回合');
    else if (e.kind === 'SWITCH_PHASE' && e.seat === mySeat && e.to === 'ACTION') out.push('行动阶段');
    else if (e.kind === 'SWITCH_PHASE' && e.seat === mySeat && e.to === 'ADD_POINT') out.push('加点阶段');
  }
  return out;
}

/** 局内系统通知（本地生成，由页面 drain 后转聊天/飘字；重连重放不触发） */
export type SystemNotice =
  | { kind: 'turnStart'; seat: number }
  | {
      kind: 'forceCleared';
      seat: number;
      killerSeat: number | null;
      reason: 'no_stronghold' | 'surrender' | 'timeout';
    }
  | { kind: 'killStreak'; seat: number; kills: number };

/** 从事件链收集局内系统通知并更新击杀计数（纯函数，供 store 与单测共用）。
 *  击杀者 = 意图发起者（no_stronghold 清除必由进攻产生）；击杀数 ≥ 3 后每次击杀都发 killStreak。 */
export function collectSystemNotices(
  chain: GameEvent[],
  fromSeat: number,
  prevKillCounts: Record<number, number>,
): { notices: SystemNotice[]; killCounts: Record<number, number> } {
  const notices: SystemNotice[] = [];
  const killCounts = { ...prevKillCounts };
  for (const e of chain) {
    if (e.kind === 'FORCE_CLEAR') {
      const killerSeat = e.reason === 'no_stronghold' ? fromSeat : null;
      notices.push({ kind: 'forceCleared', seat: e.seat, killerSeat, reason: e.reason });
      if (killerSeat !== null) {
        killCounts[killerSeat] = (killCounts[killerSeat] ?? 0) + 1;
        const kills = killCounts[killerSeat];
        if (kills >= 3) notices.push({ kind: 'killStreak', seat: killerSeat, kills });
      }
    } else if (e.kind === 'END_TURN' && e.toSeat !== e.fromSeat) {
      notices.push({ kind: 'turnStart', seat: e.toSeat });
    }
  }
  return { notices, killCounts };
}

/** 严格按 eventId 序应用一条对局流消息（纯逻辑，供 store 与补发共用） */
/** 严格按 eventId 序应用一条对局流消息（经 set 提交，保证订阅者收到通知） */
function applyStreamMessage(
  get: () => GameStore,
  set: (partial: Partial<GameStore>) => void,
  eventId: number,
  intent: PlayerIntent,
  fromSeat: number,
  transport: GameTransport | null,
  replay = false,
): ApplyOutcome {
  const s = get();
  if (s.gameOver || s.fatal) return 'ignored';
  if (eventId <= s.appliedEventId) return 'duplicate';
  if (eventId !== s.appliedEventId + 1) return 'gap';
  const board = s.board;
  if (!board) return 'ignored';
  const r = applyIntent(board, { actor: { kind: 'PLAYER', seat: fromSeat }, intent });
  if (!r.ok) {
    // 非法意图：确定性拒绝，游标照常前进（各端一致）
    set({ appliedEventId: eventId });
    return 'applied';
  }
  // 共识节点：立即上报（与动画解耦）
  const nodes = collectConsensusNodes(eventId, r.chain);
  const pendingConsensus = { ...s.pendingConsensus };
  for (const node of nodes) {
    pendingConsensus[node.consensusId] = node.payload;
    transport?.submitConsensus(node.consensusId, node.payload);
  }
  // 回合轮转 → 计时器重置（加时 + 步时重置）
  let timer = s.timer;
  const endTurn = r.chain.find((e) => e.kind === 'END_TURN');
  if (endTurn && endTurn.kind === 'END_TURN') {
    timer = onTurnChange(timer, endTurn.toSeat, s.timeSettings);
  }
  // 链应用前兵表快照（动画插值起点；board 权威不变）
  const beforeTiles: Array<SoldierState | null> = board.tiles.map((t) => (t.soldier ? { ...t.soldier } : null));
  // 实时路径（非重放）收集我方回合/阶段开始提示
  const announcements = replay ? [] : collectPhaseAnnouncements(r.chain, s.mySeat);
  // 实时路径（非重放）收集局内系统通知（回合开始/被击败/大杀四方）并更新击杀计数
  const sys = replay ? null : collectSystemNotices(r.chain, fromSeat, s.killCounts);
  set({
    board: r.state,
    appliedEventId: eventId,
    eventQueue: [...s.eventQueue, { chain: r.chain, beforeTiles }],
    lastChain: r.chain,
    pendingConsensus,
    timer,
    phaseAnnouncements:
      announcements.length > 0 ? [...s.phaseAnnouncements, ...announcements] : s.phaseAnnouncements,
    killCounts: sys ? sys.killCounts : s.killCounts,
    systemNotices:
      sys && sys.notices.length > 0 ? [...s.systemNotices, ...sys.notices] : s.systemNotices,
  });
  return 'applied';
}

export const useGame = create<GameStore>((set, get) => {
  let hasOpenedOnce = false;

  /** EVENT_GAP：补发拉取后按序继续应用（真实后端 GET /api/game/:id/events；Mock 同构） */
  async function catchUp(): Promise<void> {
    const s = get();
    const transport = s.transport;
    if (!transport || !s.gameId) return;
    try {
      const { events, nextCursor } = await transport.fetchEvents(s.gameId, s.appliedEventId);
      for (const raw of events) {
        const msg = raw as { eventId?: number; intent?: PlayerIntent; fromSeat?: number };
        if (typeof msg.eventId !== 'number' || !msg.intent) continue;
        applyStreamMessage(get, set, msg.eventId, msg.intent, msg.fromSeat ?? 0, transport, true);
      }
      if (nextCursor > 0) void catchUp();
    } catch {
      // 补发失败：保持游标不动，等待下一条消息再次触发
    }
  }

  return {
    transport: null,
    gameId: null,
    roomId: null,
    map: null,
    seatAssignments: null,
    mySeat: null,
    isSpectator: false,
    timeSettings: { stepTime: 90, gameTime: 1200, additionalTime: 0 },
    fogMode: false,

    board: null,
    appliedEventId: 0,
    eventQueue: [],
    lastChain: [],
    ackMap: {},
    localIntents: {},
    pendingConsensus: {},
    lastPointTile: null,

    connection: 'connecting',
    timer: initialTimer({ stepTime: 90, gameTime: 1200, additionalTime: 0 }),
    opponentClocks: {},
    disconnectedSeats: [],

    gameOver: null,
    fatal: null,
    submitting: false,
    chat: [],
    phaseAnnouncements: [],
    systemNotices: [],
    killCounts: {},

    startGame: ({ roomId, startMsg, myUserId, fogMode }) => {
      const init = initState({
        map: startMsg.map,
        seatAssignments: startMsg.seatAssignments,
        timeSettings: startMsg.timeSettings,
      });
      const mySeat = startMsg.seatAssignments.find((a) => a.playerId !== null && a.playerId === myUserId)?.seat ?? null;
      const isSpectator = myUserId !== null && mySeat === null;
      // 开局首个回合若即我方：收集开局链中的阶段提示（回合开始补「你的回合」）
      const initAnnouncements = collectPhaseAnnouncements(init.chain, mySeat);
      if (mySeat !== null && mySeat === init.state.currentSeat) initAnnouncements.unshift('你的回合');
      // 开局首个回合：补「现在是[势力]的回合」系统通知（开局链不含 END_TURN）
      const initNotices: SystemNotice[] = [];
      if (init.state.currentSeat > 0) initNotices.push({ kind: 'turnStart', seat: init.state.currentSeat });
      set({
        gameId: startMsg.gameId,
        roomId,
        map: startMsg.map,
        seatAssignments: startMsg.seatAssignments,
        mySeat,
        isSpectator,
        timeSettings: startMsg.timeSettings,
        fogMode,
        board: init.state,
        appliedEventId: 0,
        eventQueue: [],
        lastChain: init.chain,
        ackMap: {},
        localIntents: {},
        pendingConsensus: {},
        lastPointTile: null,
        timer: initialTimer(startMsg.timeSettings),
        gameOver: null,
        fatal: null,
        disconnectedSeats: [],
        opponentClocks: {},
        chat: [],
        phaseAnnouncements: initAnnouncements,
        systemNotices: initNotices,
        killCounts: {},
      });
      // 首个回合的计时基准（initState 已自动完成首势力准备 → 行动）
      const seat = init.state.currentSeat;
      if (seat > 0) {
        set({ timer: onTurnChange(initialTimer(startMsg.timeSettings), seat, startMsg.timeSettings) });
      }
    },

    onServerMessage: (msg) => {
      const s = get();
      switch (msg.type) {
        case 'INTENT_ACK': {
          const intent = s.localIntents[msg.clientTempId];
          const localIntents = { ...s.localIntents };
          delete localIntents[msg.clientTempId];
          const ackMap = { ...s.ackMap, [msg.clientTempId]: msg.eventId };
          set({ ackMap, localIntents, submitting: false });
          // 自己的意图：ACK 后按 eventId 序应用（服务器不回环广播）
          if (intent && s.mySeat !== null) {
            const outcome = applyStreamMessage(get, set, msg.eventId, intent, s.mySeat, s.transport);
            if (outcome === 'gap') void catchUp();
          }
          return;
        }
        case 'INTENT_BROADCAST': {
          const outcome = applyStreamMessage(get, set, msg.eventId, msg.intent, msg.fromSeat, s.transport);
          if (outcome === 'gap') void catchUp();
          return;
        }
        case 'CONSENSUS_CONFIRMED': {
          const local = s.pendingConsensus[msg.consensusId];
          const pendingConsensus = { ...s.pendingConsensus };
          delete pendingConsensus[msg.consensusId];
          if (!local) {
            set({ pendingConsensus });
            return; // 未上报过该节点（如重放路径）：忽略
          }
          if (!sameConsensus(local, msg.confirmed)) {
            set({
              pendingConsensus,
              fatal: { code: 'CONSENSUS_MISMATCH', message: '对局状态异常，本局中止不结算' },
            });
            return;
          }
          set({ pendingConsensus });
          return;
        }
        case 'GAME_OVER': {
          set({ gameOver: msg });
          return;
        }
        case 'TIME_SYNC': {
          set({
            opponentClocks: {
              ...s.opponentClocks,
              [msg.seat]: { stepTimeRemain: msg.stepTimeRemain, gameTimeRemain: msg.gameTimeRemain },
            },
          });
          return;
        }
        case 'PLAYER_DISCONNECT': {
          set({
            disconnectedSeats: s.disconnectedSeats.includes(msg.seat) ? s.disconnectedSeats : [...s.disconnectedSeats, msg.seat],
          });
          return;
        }
        case 'PLAYER_RECONNECT': {
          set({ disconnectedSeats: s.disconnectedSeats.filter((x) => x !== msg.seat) });
          return;
        }
        case 'RECONNECT_ACK': {
          // 重连重放：batch 按 eventId 序应用（INTENT_BROADCAST 重放、CONFIRMED 清理、GAME_OVER 结算）
          for (const raw of msg.batch) {
            const m = raw as {
              type?: string;
              eventId?: number;
              intent?: PlayerIntent;
              fromSeat?: number;
              consensusId?: string;
              confirmed?: ConsensusPayload;
              type_: 'GAME_OVER' | string;
            };
            if (m.type === 'INTENT_BROADCAST' && typeof m.eventId === 'number' && m.intent) {
              applyStreamMessage(get, set, m.eventId, m.intent, m.fromSeat ?? 0, s.transport, true);
            } else if (m.type === 'CONSENSUS_CONFIRMED' && m.consensusId) {
              const pendingConsensus = { ...get().pendingConsensus };
              delete pendingConsensus[m.consensusId];
              set({ pendingConsensus });
            } else if (m.type === 'GAME_OVER') {
              set({ gameOver: m as unknown as GameOverMsg });
            }
          }
          if (msg.nextBatchCursor && msg.nextBatchCursor > 0) void catchUp();
          return;
        }
        case 'ERROR': {
          if (msg.fatal) set({ fatal: { code: msg.code, message: msg.message } });
          return;
        }
        case 'ROOM_DISBANDED': {
          set({
            fatal: {
              code: 'ROOM_DISBANDED',
              message: msg.reason === 'game_timeout' ? '对局超时，房间已解散' : '房间已解散',
            },
          });
          return;
        }
        case 'CHAT': {
          set({
            chat: [...s.chat, { from: msg.from, username: msg.username, text: msg.text, ts: msg.ts }].slice(-200),
          });
          return;
        }
        default:
          return; // 房间阶段消息由房间 store 处理
      }
    },

    onStatus: (status) => {
      set({ connection: status });
      if (status === 'open' && hasOpenedOnce) {
        // 断线重连成功：全量重放追平（RECONNECT → RECONNECT_ACK → 重放）
        get().reconnectCatchUp();
      }
      if (status === 'open') hasOpenedOnce = true;
    },

    submitIntent: (intent) => {
      const s = get();
      if (s.isSpectator || s.gameOver || s.fatal || s.board === null) return;
      if (s.mySeat === null) return;
      const clientTempId = nextTempId();
      set({
        submitting: true,
        localIntents: { ...s.localIntents, [clientTempId]: intent },
      });
      s.transport?.submitIntent(clientTempId, intent);
    },

    submitTimeoutSurrender: () => {
      const s = get();
      if (s.mySeat === null || s.isSpectator || s.gameOver || s.fatal) return;
      get().submitIntent({ intentType: 'SURRENDER', seat: s.mySeat, reason: 'timeout' });
    },

    sendChat: (text) => {
      const s = get();
      // 观战可发言（后端不限制观战 CHAT）；对局结束/中止后不发言
      if (s.gameOver || s.fatal) return false;
      return s.transport?.sendChat(text) ?? false;
    },

    tickClock: () => {
      const s = get();
      const { next, stepTimeout, gameTimeout } = tick(s.timer);
      set({ timer: next });
      if (gameTimeout) {
        // 局时归零（含步时同时归零）：超时投降
        get().submitTimeoutSurrender();
        return;
      }
      if (stepTimeout) {
        // 步时归零（局时未归零）：代玩家跳过本回合（连续切换阶段至回合结束）
        const phase = s.board?.phase;
        if (phase === 'ACTION' || phase === 'ADD_POINT') {
          get().submitIntent({ intentType: 'SWITCH_PHASE' });
          if (phase === 'ACTION') get().submitIntent({ intentType: 'SWITCH_PHASE' });
        }
      }
    },

    popChain: () => {
      const s = get();
      if (s.eventQueue.length === 0) return;
      set({ eventQueue: s.eventQueue.slice(1) });
    },

    clearEventQueue: () => set({ eventQueue: [] }),

    reconnectCatchUp: () => {
      const s = get();
      if (!s.transport || !s.gameId) return;
      s.transport.sendReconnect(s.appliedEventId, s.gameId);
    },

    drainPhaseAnnouncements: () => {
      const drained = get().phaseAnnouncements;
      set({ phaseAnnouncements: [] });
      return drained;
    },

    drainSystemNotices: () => {
      const drained = get().systemNotices;
      set({ systemNotices: [] });
      return drained;
    },

    pushSystemChat: (text) => {
      const s = get();
      set({
        chat: [...s.chat, { from: 0, username: '', text, ts: Date.now(), kind: 'system' as const }].slice(-200),
      });
    },

    reset: () => {
      hasOpenedOnce = false;
      set({
        transport: null,
        gameId: null,
        roomId: null,
        map: null,
        seatAssignments: null,
        mySeat: null,
        isSpectator: false,
        board: null,
        appliedEventId: 0,
        eventQueue: [],
        lastChain: [],
        ackMap: {},
        localIntents: {},
        pendingConsensus: {},
        lastPointTile: null,
        gameOver: null,
        fatal: null,
        timer: initialTimer({ stepTime: 90, gameTime: 1200, additionalTime: 0 }),
        opponentClocks: {},
        disconnectedSeats: [],
        submitting: false,
        chat: [],
        phaseAnnouncements: [],
        systemNotices: [],
        killCounts: {},
      });
    },
  };
});

/** 注入对局传输通道（Game 页面挂载时调用；返回解绑函数） */
export function attachTransport(t: GameTransport): () => void {
  useGame.setState({ transport: t });
  const offMsg = t.onMessage((msg) => useGame.getState().onServerMessage(msg));
  const offStatus = t.onStatus((status) => useGame.getState().onStatus(status));
  return () => {
    offMsg();
    offStatus();
    useGame.setState({ transport: null });
  };
}
