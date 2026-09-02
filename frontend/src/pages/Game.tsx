// 对局主界面（前端规划 §3 / §4.4/4.5/4.6）：左状态栏 / 上个人状态栏 / 中间战场 / 底部阶段按钮 + 聊天。
// - 行动阶段：点兵 → 周围反击着色 → 选目标 → MOVE/ATTACK；多点兵取消前选中
// - 加点阶段：pointerdown 150ms 连续累计，500ms 聚合为一条 ADD_POINT，pointerup 发尾量，点数耗尽即停
// - SWITCH_PHASE 意图化（不乐观切换）；投降按钮；本地计时归零自动 SURRENDER(timeout)
// - 观战：全图无迷雾、无操作按钮、灰禁提示
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { applyIntent } from '@dl/shared';
import type { GameEvent, GameState, PlayerIntent, RoomServerMsg } from '@dl/shared';
import { useAuth } from '../stores/auth';
import { useGame, attachTransport } from '../stores/game';
import { useRoom } from '../stores/room';
import { WsClient } from '../ws/client';
import { MockWsServer } from '../mock/wsServer';
import { fetchGameMeta, fetchGameResult } from '../api/game';
import { getRoom } from '../api/room';
import type { GameResultData } from '@dl/shared';
import { computeFog, type FogLevel } from '../game/fog';
import { formatClock } from '../game/timer';
import { EventAnimator } from '../canvas/animator';
import { flagImgUrl } from '../lib/flags';
import BoardCanvas from '../components/BoardCanvas';
import GameChat from '../components/GameChat';
import ResultModal from './Result';

const USE_MOCK = import.meta.env.VITE_USE_MOCK === 'true';
const PHASE_LABEL: Record<string, string> = {
  PREPARE: '准备阶段',
  ACTION: '行动阶段',
  ADD_POINT: '加点阶段',
  END: '结束阶段',
};

export default function Game() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const me = useAuth((s) => s.user);
  const room = useRoom((s) => s.room);

  const board = useGame((s) => s.board);
  const gameId = useGame((s) => s.gameId);
  const mySeat = useGame((s) => s.mySeat);
  const isSpectator = useGame((s) => s.isSpectator);
  const connection = useGame((s) => s.connection);
  const timer = useGame((s) => s.timer);
  const opponentClocks = useGame((s) => s.opponentClocks);
  const timeSettings = useGame((s) => s.timeSettings);
  const gameOver = useGame((s) => s.gameOver);
  const fatal = useGame((s) => s.fatal);
  const disconnectedSeats = useGame((s) => s.disconnectedSeats);
  const eventQueue = useGame((s) => s.eventQueue);
  const fogMode = useGame((s) => s.fogMode);
  const chat = useGame((s) => s.chat);

  const [selected, setSelected] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [exploredMemo, setExploredMemo] = useState<Set<number>>(new Set());
  const addPointRef = useRef<{ timer: number | null; accumulated: number; lastSend: number }>({
    timer: null,
    accumulated: 0,
    lastSend: 0,
  });
  /** 侧边栏简略模式（默认开启：仅旗帜+势力名+点数+倒计时进度条，浮在棋盘上） */
  const [compactSidebar, setCompactSidebar] = useState(true);

  // ---------- 回合/阶段提示浮层（我的回合/行动/加点开始时居中展示，0.7s 后淡出） ----------
  const phaseAnnouncements = useGame((s) => s.phaseAnnouncements);
  const [announceText, setAnnounceText] = useState<string | null>(null);
  const [announceFading, setAnnounceFading] = useState(false);
  const announceQueueRef = useRef<string[]>([]);
  const announceTextRef = useRef<string | null>(null);
  announceTextRef.current = announceText;

  // 消费 store 提示队列 → 排入本地播放队列（当前无展示则立即开播）
  useEffect(() => {
    if (phaseAnnouncements.length === 0) return;
    const drained = useGame.getState().drainPhaseAnnouncements();
    if (drained.length === 0) return;
    announceQueueRef.current.push(...drained);
    if (announceTextRef.current === null) {
      const next = announceQueueRef.current.shift()!;
      setAnnounceFading(false);
      setAnnounceText(next);
    }
  }, [phaseAnnouncements]);

  // 当前提示播放：展示 0.7s → 淡出 0.3s → 下一条 / 结束
  useEffect(() => {
    if (announceText === null) return;
    const t1 = window.setTimeout(() => setAnnounceFading(true), 700);
    const t2 = window.setTimeout(() => {
      const next = announceQueueRef.current.shift();
      if (next !== undefined) {
        setAnnounceFading(false);
        setAnnounceText(next);
      } else {
        setAnnounceFading(false);
        setAnnounceText(null);
      }
    }, 1000);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [announceText]);

  // ---------- 动画播放器（M5.1）：驱动 eventQueue 逐链演出；board 权威不变。固定 4 倍速，无倍速调节 ----------
  const animatorRef = useRef<EventAnimator | null>(null);
  if (animatorRef.current === null) {
    animatorRef.current = new EventAnimator(
      () => useGame.getState().eventQueue,
      () => useGame.getState().popChain(),
    );
    animatorRef.current.setSpeed(4);
  }
  const [animPaused, setAnimPaused] = useState(false);
  /** 演出中（粗粒度同步，仅变化时 setState；操作守卫用 ref 实时判断） */
  const [animating, setAnimating] = useState(false);
  useEffect(() => {
    const iv = window.setInterval(() => {
      const playing = animatorRef.current?.isPlaying ?? false;
      setAnimating((prev) => (prev === playing ? prev : playing));
    }, 200);
    return () => window.clearInterval(iv);
  }, []);
  const togglePause = () => {
    const next = !animPaused;
    animatorRef.current?.setPaused(next);
    setAnimPaused(next);
  };
  const stepEvent = () => animatorRef.current?.step();
  const fastForward = () => {
    animatorRef.current?.reset();
    useGame.getState().clearEventQueue();
  };

  // 断线重连检测：本会话重连成功后标记为「重连者」（与观战者一样可一键跳转至现在）
  const [reconnected, setReconnected] = useState(false);
  const openedOnceRef = useRef(false);
  useEffect(() => {
    if (connection === 'open') {
      if (openedOnceRef.current) setReconnected(true);
      openedOnceRef.current = true;
    }
  }, [connection]);

  // ---------- 传输通道 + 初始化（挂载时一次） ----------
  // 初始化路径：
  //  1. Room 跳转：board 已由 GAME_START 初始化（startGame 已在 Room 页调用）
  //  2. 刷新/观战加入：CONNECT_ACK 带 gameId → meta 恢复 board → 重连重放追平
  useEffect(() => {
    if (!roomId) return;
    const transport = USE_MOCK ? new MockWsServer() : new WsClient(roomId);
    const detach = attachTransport(transport);
    const offAck = transport.onMessage((msg) => {
      if (msg.type !== 'CONNECT_ACK') return;
      if (!msg.gameId) {
        // 房间无进行中对局（未开局/对局已结束）：回房间页继续（等待中/已结束）
        navigate(`/room/${roomId}`, { replace: true });
        return;
      }
      const s = useGame.getState();
      if (s.board === null) {
        void (async () => {
          try {
            const meta = await fetchGameMeta(msg.gameId!);
            useGame.getState().startGame({
              roomId: roomId,
              startMsg: { type: 'GAME_START', ...meta },
              myUserId: me?.id ?? null,
              fogMode: useRoom.getState().room?.fogMode ?? false,
            });
            const g = useGame.getState();
            if ((msg.lastEventId ?? 0) > g.appliedEventId) {
              setReconnected(true); // 刷新/新加入追平：视同重连，提供跳转至现在
              g.reconnectCatchUp();
            }
          } catch {
            navigate('/lobby', { replace: true });
          }
        })();
        return;
      }
      // board 已就绪（Room 跳转路径）：若服务器已有本端未应用的事件 → 重放追平
      if ((msg.lastEventId ?? 0) > s.appliedEventId) {
        setReconnected(true);
        s.reconnectCatchUp();
      }
    });
    transport.connect().catch(() => undefined);
    return () => {
      offAck();
      detach();
      transport.close();
      animatorRef.current?.reset();
      useGame.getState().reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  // ---------- 房间信息（势力列表需玩家用户名；Room 页已填则跳过，刷新/直连对局页时拉取） ----------
  useEffect(() => {
    if (!roomId) return;
    getRoom(roomId)
      .then((data) => {
        if (useRoom.getState().room?.id !== data.id) useRoom.getState().setRoom(data);
      })
      .catch(() => undefined);
  }, [roomId]);

  // ---------- 结算结果（结算页用户名 + 全员积分变动；GAME_OVER 后拉取） ----------
  const [settleResult, setSettleResult] = useState<GameResultData | null>(null);
  useEffect(() => {
    if (!gameOver || !gameId) {
      setSettleResult(null);
      return;
    }
    fetchGameResult(gameId)
      .then(setSettleResult)
      .catch(() => setSettleResult(null));
  }, [gameOver, gameId]);

  // 用户名兜底（结算结果未返回时先显示房间内用户名，避免闪现 id）
  const playerNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const p of room?.players ?? []) m.set(p.id, p.username);
    return m;
  }, [room]);

  // ---------- 本地计时器（规则 v2 §10）：1s tick + 5s TIME_SYNC ----------
  const myTurn = board !== null && mySeat !== null && board.currentSeat === mySeat && !isSpectator;
  useEffect(() => {
    if (!myTurn || gameOver || fatal) return;
    const iv = window.setInterval(() => useGame.getState().tickClock(), 1000);
    return () => window.clearInterval(iv);
  }, [myTurn, board?.currentSeat, board?.phase, gameOver, fatal]);

  useEffect(() => {
    if (!myTurn || !gameId || mySeat === null) return;
    const iv = window.setInterval(() => {
      const s = useGame.getState();
      s.transport?.sendTimeSync(gameId, mySeat, s.timer.stepTimeRemain, s.timer.gameTimeRemain);
    }, 5000);
    return () => window.clearInterval(iv);
  }, [myTurn, gameId, mySeat]);

  // ---------- 迷雾 ----------
  const fogEnabled = fogMode && !isSpectator;
  const mySoldierTiles = useMemo(() => {
    if (!board || mySeat === null) return [];
    const tiles: number[] = [];
    board.tiles.forEach((t, i) => {
      if (t.soldier && t.soldier.owner === mySeat) tiles.push(i);
    });
    return tiles;
  }, [board, mySeat]);
  const fogLevels: FogLevel[] | null = useMemo(() => {
    if (!board) return null;
    return computeFog(board.rows, board.columns, board.cylindrical, mySoldierTiles, fogEnabled, exploredMemo).levels;
  }, [board, mySoldierTiles, fogEnabled, exploredMemo]);
  // 跨回合已探索记忆（渲染期外更新）
  useEffect(() => {
    if (!board) return;
    const { explored } = computeFog(board.rows, board.columns, board.cylindrical, mySoldierTiles, fogEnabled, exploredMemo);
    setExploredMemo(explored);
  }, [board, mySoldierTiles, fogEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- 行动交互 ----------
  const handleTileClick = useCallback(
    (tile: number) => {
      const s = useGame.getState();
      const b = s.board;
      if (!b || s.isSpectator || s.gameOver || s.fatal) return;
      if (animatorRef.current?.isPlaying) return; // 演出中禁操作（可快进跳过）
      if (b.currentSeat !== s.mySeat) return;
      if (b.phase !== 'ACTION') return;
      const soldier = b.tiles[tile].soldier;
      if (soldier && soldier.owner === s.mySeat) {
        // 点己方兵：可移动则选中，否则取消选中
        if (soldier.hasMovement && !(soldier.isLinked && soldier.strength === 1)) setSelected(tile === selected ? null : tile);
        else setSelected(null);
        return;
      }
      if (selected === null) return;
      const selSoldier = b.tiles[selected].soldier;
      if (!selSoldier || selSoldier.owner !== s.mySeat) {
        setSelected(null);
        return;
      }
      const target = b.tiles[tile].soldier;
      let intent: PlayerIntent;
      if (target && target.owner !== s.mySeat) {
        intent = { intentType: 'ATTACK', from: selected, to: tile };
      } else if (!target) {
        intent = { intentType: 'MOVE', from: selected, to: tile };
      } else {
        return; // 同队兵目标：无效
      }
      s.submitIntent(intent);
      setSelected(nextSelectedTile(b, intent));
    },
    [selected],
  );

  // ---------- 加点长按（150ms 累计 / 500ms 聚合 / 尾量） ----------
  const stopAddPoint = useCallback(() => {
    const r = addPointRef.current;
    if (r.timer !== null) {
      window.clearInterval(r.timer);
      r.timer = null;
    }
    if (r.accumulated > 0) {
      const s = useGame.getState();
      s.submitIntent({ intentType: 'ADD_POINT', coordinate: s.lastPointTile ?? 0, amount: r.accumulated });
      r.accumulated = 0;
    }
  }, []);

  const startAddPoint = useCallback(
    (tile: number) => {
      const s = useGame.getState();
      const b = s.board;
      if (!b || s.isSpectator || s.gameOver || s.fatal) return;
      if (animatorRef.current?.isPlaying) return; // 演出中禁操作
      if (b.currentSeat !== s.mySeat || b.phase !== 'ADD_POINT') return;
      const soldier = b.tiles[tile].soldier;
      if (!soldier || soldier.owner !== s.mySeat || !soldier.isLinked) return;
      const force = b.forces.find((f) => f.seat === s.mySeat);
      if (!force || force.points <= 0) return;
      const r = addPointRef.current;
      stopAddPoint();
      useGame.setState({ lastPointTile: tile });
      r.accumulated = 1;
      r.lastSend = Date.now();
      r.timer = window.setInterval(() => {
        const g = useGame.getState();
        const f = g.board?.forces.find((x) => x.seat === g.mySeat);
        const maxPoints = f?.points ?? 0;
        if (r.accumulated >= maxPoints) {
          stopAddPoint();
          return;
        }
        r.accumulated += 1;
        // 500ms 聚合发送
        if (Date.now() - r.lastSend >= 500) {
          g.submitIntent({ intentType: 'ADD_POINT', coordinate: tile, amount: r.accumulated });
          r.accumulated = 0;
          r.lastSend = Date.now();
        }
      }, 150);
    },
    [stopAddPoint],
  );

  // 页面卸载清理长按
  useEffect(() => () => stopAddPoint(), [stopAddPoint]);

  // ---------- 阶段/投降按钮 ----------
  const phase = board?.phase ?? 'PREPARE';
  const isMyActionTurn = myTurn && (phase === 'ACTION' || phase === 'ADD_POINT');
  const handleSwitchPhase = () => {
    const s = useGame.getState();
    if (!s.board) return;
    if (animatorRef.current?.isPlaying) return;
    if (s.board.currentSeat !== s.mySeat) return;
    s.submitIntent({ intentType: 'SWITCH_PHASE' });
    setSelected(null);
  };
  const handleSurrender = () => {
    if (animatorRef.current?.isPlaying) return;
    if (!window.confirm('确定投降？')) return;
    const s = useGame.getState();
    if (s.mySeat === null) return;
    s.submitIntent({ intentType: 'SURRENDER', seat: s.mySeat, reason: 'voluntary' });
  };

  if (!board) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900 text-slate-400">
        {fatal ? fatal.message : '对局加载中…'}
      </div>
    );
  }

  const currentForce = board.forces.find((f) => f.seat === board.currentSeat);
  const aliveForces = board.forces.filter((f) => f.exists);

  return (
    <div className="flex min-h-screen flex-col bg-slate-900 text-white">
      {/* 顶部个人状态栏 */}
      <header className="flex items-center justify-between border-b border-slate-700 px-6 py-2.5">
        <div className="flex items-center gap-4">
          <span className="text-sm text-slate-400">第 {board.turn} 回合</span>
          <span className="text-sm">
            <span className="text-slate-400">当前行动：</span>
            <span className="font-medium" style={{ color: seatColor(currentForce?.seat) }}>
              {currentForce?.name ?? '—'}
            </span>
            <span className="ml-2 text-xs text-slate-500">{PHASE_LABEL[phase]}</span>
          </span>
          {disconnectedSeats.length > 0 && (
            <span className="text-xs text-amber-400">⚠ 断线：{disconnectedSeats.map((x) => `#${x}`).join(', ')}</span>
          )}
        </div>
        <div className="flex items-center gap-4">
          {isSpectator && <span className="rounded bg-indigo-700 px-2 py-0.5 text-xs">观战中，无法影响对局</span>}
          <span
            className={`flex items-center gap-1 text-xs ${connection === 'open' ? 'text-emerald-400' : 'text-amber-400'}`}
          >
            ● {connection === 'open' ? '已连接' : '重连中…'}
          </span>
          {!isSpectator && (
            <button
              onClick={handleSurrender}
              disabled={board.finished}
              className="rounded bg-red-800 px-3 py-1 text-sm text-red-100 hover:bg-red-700 disabled:opacity-40"
            >
              投降
            </button>
          )}
          <button onClick={() => navigate('/lobby')} className="rounded bg-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-600">
            返回大厅
          </button>
        </div>
      </header>

      <main className="flex flex-1 gap-4 overflow-hidden px-6 py-4">
        {/* 完整模式：左侧边栏（四行卡片）；简略模式默认开启时隐藏 */}
        {!compactSidebar && (
          <aside className="w-40 shrink-0 space-y-1.5 overflow-y-auto rounded-lg bg-slate-800 p-2">
            {aliveForces.map((f) => {
              const player = room?.players.find((p) => p.id === f.playerId);
              const isCurrent = f.seat === board.currentSeat;
              const isMine = f.seat === mySeat;
              const clock =
                f.seat === mySeat
                  ? { stepTimeRemain: timer.stepTimeRemain, gameTimeRemain: timer.gameTimeRemain }
                  : opponentClocks[f.seat];
              const lowTime =
                isMine && clock !== undefined && (clock.stepTimeRemain < 10 || clock.gameTimeRemain < 10);
              return (
                <div
                  key={f.seat}
                  className={`rounded border px-2 py-1.5 ${isCurrent ? 'border-amber-400 bg-slate-700' : 'border-slate-700 bg-slate-800'} ${
                    !f.alive ? 'opacity-40' : ''
                  }`}
                >
                  {/* 行1：旗帜 + 势力名（"我"保留绿色标记） */}
                  <div className="flex items-center gap-1.5">
                    <img
                      src={flagImgUrl(f.flag)}
                      alt=""
                      className="h-5 w-4 object-contain"
                      onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
                    />
                    <span className="flex-1 truncate text-xs font-medium" style={{ color: seatColor(f.seat) }}>
                      {f.name}
                      {isMine && <span className="ml-0.5 text-[10px] text-emerald-400">（我）</span>}
                    </span>
                  </div>
                  {/* 行2：扮演玩家 + 当前积分 */}
                  <div className="mt-0.5 flex items-baseline justify-between gap-1 text-[11px]">
                    <span className="truncate text-slate-300">{player ? player.username : f.isAI ? 'AI（休闲）' : '—'}</span>
                    {player && <span className="shrink-0 text-slate-400">{player.score.toFixed(1)}</span>}
                  </div>
                  {/* 行3：点数 + 可加点（a 灰色、b 粉色；b = 按连兵数量统计的可支配加点数） */}
                  <div className="mt-0.5 text-[11px] text-slate-400">
                    {f.alive ? (
                      <>
                        点数 <span className="text-slate-300">{f.points}</span>
                        <span className="text-pink-400">
                          (+{board.tiles.filter((t) => t.soldier !== null && t.soldier.owner === f.seat && t.soldier.isLinked).length})
                        </span>
                      </>
                    ) : (
                      '已清除'
                    )}
                  </div>
                  {/* 行4：步时 + 局时（数据源与逻辑同原「对手计时」） */}
                  {f.alive && (
                    <div className={`mt-0.5 text-center text-[11px] tabular-nums ${lowTime ? 'text-red-400' : 'text-slate-300'}`}>
                      {clock ? `${formatClock(clock.stepTimeRemain)}/${formatClock(clock.gameTimeRemain)}` : '—'}
                    </div>
                  )}
                </div>
              );
            })}
          </aside>
        )}

        {/* 中间战场 */}
        <section className="relative min-w-0 flex-1 rounded-lg bg-slate-800/50">
          {/* 左上角三横杠：切换侧边栏模式（简略 ↔ 完整） */}
          <button
            onClick={() => setCompactSidebar((v) => !v)}
            className="absolute left-2 top-2 z-20 rounded bg-slate-800/80 p-1.5 leading-none text-white shadow hover:bg-slate-700"
            title={compactSidebar ? '展开完整侧边栏' : '收起为简略模式'}
            aria-label="切换侧边栏模式"
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M2 4h12M2 8h12M2 12h12" />
            </svg>
          </button>

          {/* 简略模式（默认开启）：势力信息浮在棋盘左上角（旗帜+势力名+点数+倒计时进度条） */}
          {compactSidebar && (
            <div className="pointer-events-none absolute left-2 top-10 z-10 space-y-1.5">
              {aliveForces.map((f) => {
                const isCurrent = f.seat === board.currentSeat;
                const clock =
                  f.seat === mySeat
                    ? { stepTimeRemain: timer.stepTimeRemain, gameTimeRemain: timer.gameTimeRemain }
                    : opponentClocks[f.seat];
                const stepPct = clock
                  ? Math.max(0, Math.min(100, (clock.stepTimeRemain / timeSettings.stepTime) * 100))
                  : 0;
                return (
                  <div
                    key={f.seat}
                    className={`flex items-center gap-1.5 rounded bg-slate-900/70 px-1.5 py-1 ${!f.alive ? 'opacity-40' : ''}`}
                  >
                    <img
                      src={flagImgUrl(f.flag)}
                      alt=""
                      className="h-5 w-4 object-contain"
                      onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
                    />
                    {/* 名称+点数 与进度条合计高度 = 旗帜高度（h-5） */}
                    <div className="flex w-28 flex-col justify-between" style={{ height: '1.25rem' }}>
                      <div className="flex items-baseline gap-1">
                        <span
                          className={`truncate text-xs leading-none ${isCurrent ? 'font-bold' : 'font-medium'}`}
                          style={{ color: seatColor(f.seat) }}
                        >
                          {f.name}
                        </span>
                        <span className="shrink-0 text-xs leading-none text-white">{f.points}</span>
                      </div>
                      <div className="h-1 w-full overflow-hidden rounded bg-white/20">
                        <div className="h-full bg-white" style={{ width: `${stepPct}%` }} />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <BoardCanvas
            board={board}
            mySeat={mySeat}
            isSpectator={isSpectator}
            fogEnabled={fogEnabled}
            fogLevels={fogLevels}
            phase={phase}
            selected={selected}
            onTileClick={handleTileClick}
            onTileHover={setHovered}
            onTilePointerDown={(tile) => {
              // 加点阶段：长按入口（行动阶段仍走 click）
              if (useGame.getState().board?.phase === 'ADD_POINT') startAddPoint(tile);
              else handleTileClick(tile);
            }}
            onTilePointerUp={stopAddPoint}
            animatorRef={animatorRef}
            className="h-full w-full"
          />
          {/* 结束行动/加点：浮在地图区正下方、距底边一段距离 */}
          {isMyActionTurn && (
            <button
              onClick={handleSwitchPhase}
              className="absolute bottom-14 left-1/2 z-10 -translate-x-1/2 rounded bg-indigo-600 px-4 py-2 font-medium text-white shadow-lg hover:bg-indigo-500"
            >
              {phase === 'ACTION' ? '结束行动' : '结束加点'}
            </button>
          )}
          {/* 底部提示条 + 演出控制（固定 4 倍速；仅重连/观战提供跳转至现在） */}
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-slate-900/80 px-4 py-2 text-xs text-slate-300">
            <span>
              {animating
                ? '演出中…'
                : isSpectator
                  ? '观战中，无法影响对局'
                  : myTurn
                    ? phase === 'ACTION'
                      ? hovered !== null && board.tiles[hovered]?.soldier && board.tiles[hovered]!.soldier!.owner !== mySeat
                        ? '目标有敌军：点击发起进攻'
                        : '点击己方有移动力的兵，再点击目标地块'
                      : phase === 'ADD_POINT'
                        ? '长按己方连兵加点（每 0.15 秒 1 点，自动聚合）'
                        : '准备阶段…'
                    : `等待 ${currentForce?.name ?? ''} 行动…`}
            </span>
            <span className="flex items-center gap-2">
              {eventQueue.length > 0 && (
                <>
                  <button
                    onClick={togglePause}
                    className="rounded bg-slate-700 px-2 py-0.5 text-amber-300 hover:bg-slate-600"
                  >
                    {animPaused ? '继续' : '暂停'}
                  </button>
                  <button
                    onClick={stepEvent}
                    className="rounded bg-slate-700 px-2 py-0.5 text-amber-300 hover:bg-slate-600"
                  >
                    单步
                  </button>
                  {(isSpectator || reconnected) && (
                    <button
                      onClick={fastForward}
                      className="rounded bg-slate-700 px-2 py-0.5 text-amber-300 hover:bg-slate-600"
                    >
                      跳转至现在（{eventQueue.length}）
                    </button>
                  )}
                </>
              )}
            </span>
          </div>
          {/* 对局内聊天：默认折叠在棋盘右下角仅显示最近一条，点击小三角展开（观战可发言） */}
          <GameChat chat={chat} onSend={(text) => useGame.getState().sendChat(text)} />
        </section>
      </main>

      {/* 回合/阶段提示：黑底白框白字，屏幕正中，展示 0.7s 后淡出 */}
      {announceText !== null && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center">
          <div
            className={`rounded-lg border-2 border-white bg-black px-10 py-5 text-3xl font-bold text-white shadow-lg transition-opacity duration-300 ${
              announceFading ? 'opacity-0' : 'opacity-100'
            }`}
          >
            {announceText}
          </div>
        </div>
      )}

      {/* 结算/中止弹窗 */}
      {(gameOver !== null || fatal !== null) && (
        <ResultModal
          gameOver={gameOver}
          fatal={fatal}
          board={board}
          isSpectator={isSpectator}
          gameId={gameId}
          result={settleResult}
          playerNames={playerNameById}
          onClose={() => {
            // 结算页关闭上报：全部参战玩家关闭后，房间立即回落等待中（服务器据此结束结算展示）
            const s = useGame.getState();
            if (s.gameOver && s.gameId && !s.isSpectator) s.transport?.sendSettlementDismissed(s.gameId);
            // 返回房间页（结算展示/等待中），而非大厅
            navigate(`/room/${roomId}`, { replace: true });
          }}
        />
      )}
    </div>
  );
}

/** MOVE/ATTACK 提交后的自动续选（交互优化）：用与权威 reducer 同源的 applyIntent 本地模拟演算，
 *  目标地块的新兵仍有移动力 → 自动选中该地块，便于连续操作同一兵（无需每次重新点兵）。 */
function nextSelectedTile(board: GameState, intent: PlayerIntent): number | null {
  if (intent.intentType !== 'MOVE' && intent.intentType !== 'ATTACK') return null;
  const r = applyIntent(board, { actor: { kind: 'PLAYER', seat: board.currentSeat }, intent });
  if (!r.ok) return null;
  const s = r.state.tiles[intent.to].soldier;
  if (!s || s.owner !== board.currentSeat) return null;
  if (!s.hasMovement) return null;
  if (s.isLinked && s.strength === 1) return null; // 兵力 1 连兵不可行动（与 reducer 判定一致）
  return intent.to;
}

function seatColor(seat: number | undefined): string {
  const COLORS = ['#e63946', '#457b9d', '#2a9d8f', '#e9c46a', '#8e44ad', '#d35400', '#16a085', '#c0392b'];
  return seat === undefined ? '#94a3b8' : COLORS[(seat - 1) % COLORS.length];
}

// 供 Game 页面使用的类型引用（避免未使用告警）
export type { GameEvent, RoomServerMsg };
