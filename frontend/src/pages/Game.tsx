// 对局主界面（前端规划 §3 / §4.4/4.5/4.6）：左状态栏 / 上个人状态栏 / 中间战场 / 底部阶段按钮 + 聊天。
// - 行动阶段：点兵 → 周围反击着色 → 选目标 → MOVE/ATTACK；多点兵取消前选中
// - 加点阶段：pointerdown 150ms 连续累计，500ms 聚合为一条 ADD_POINT，pointerup 发尾量，点数耗尽即停
// - SWITCH_PHASE 意图化（不乐观切换）；投降按钮；本地计时归零自动 SURRENDER(timeout)
// - 观战：全图无迷雾、无操作按钮、灰禁提示
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { GameEvent, PlayerIntent, RoomServerMsg } from '@dl/shared';
import { useAuth } from '../stores/auth';
import { useGame, attachTransport } from '../stores/game';
import { useRoom } from '../stores/room';
import { WsClient } from '../ws/client';
import { MockWsServer } from '../mock/wsServer';
import { fetchGameMeta } from '../api/game';
import { computeFog, type FogLevel } from '../game/fog';
import { formatClock } from '../game/timer';
import { EventAnimator } from '../canvas/animator';
import BoardCanvas from '../components/BoardCanvas';
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
  const gameOver = useGame((s) => s.gameOver);
  const fatal = useGame((s) => s.fatal);
  const disconnectedSeats = useGame((s) => s.disconnectedSeats);
  const eventQueue = useGame((s) => s.eventQueue);
  const fogMode = useGame((s) => s.fogMode);

  const [selected, setSelected] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [exploredMemo, setExploredMemo] = useState<Set<number>>(new Set());
  const addPointRef = useRef<{ timer: number | null; accumulated: number; lastSend: number }>({
    timer: null,
    accumulated: 0,
    lastSend: 0,
  });

  // ---------- 动画播放器（M5.1）：驱动 eventQueue 逐链演出；board 权威不变 ----------
  const animatorRef = useRef<EventAnimator | null>(null);
  if (animatorRef.current === null) {
    animatorRef.current = new EventAnimator(
      () => useGame.getState().eventQueue,
      () => useGame.getState().popChain(),
    );
  }
  const [animPaused, setAnimPaused] = useState(false);
  const [animSpeed, setAnimSpeed] = useState(1);
  /** 演出中（粗粒度同步，仅变化时 setState；操作守卫用 ref 实时判断） */
  const [animating, setAnimating] = useState(false);
  useEffect(() => {
    const iv = window.setInterval(() => {
      const playing = animatorRef.current?.isPlaying ?? false;
      setAnimating((prev) => (prev === playing ? prev : playing));
    }, 200);
    return () => window.clearInterval(iv);
  }, []);
  const setPlaySpeed = (v: number) => {
    animatorRef.current?.setSpeed(v);
    setAnimSpeed(v);
  };
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
            if ((msg.lastEventId ?? 0) > g.appliedEventId) g.reconnectCatchUp();
          } catch {
            navigate('/lobby', { replace: true });
          }
        })();
        return;
      }
      // board 已就绪（Room 跳转路径）：若服务器已有本端未应用的事件 → 重放追平
      if ((msg.lastEventId ?? 0) > s.appliedEventId) s.reconnectCatchUp();
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
      setSelected(null);
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
  const myForce = mySeat !== null ? board.forces.find((f) => f.seat === mySeat) : null;
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
        {/* 左状态栏：势力列表 */}
        <aside className="w-56 shrink-0 space-y-2 overflow-y-auto rounded-lg bg-slate-800 p-3">
          {aliveForces.map((f) => {
            const player = room?.players.find((p) => p.id === f.playerId);
            const isCurrent = f.seat === board.currentSeat;
            const isMine = f.seat === mySeat;
            return (
              <div
                key={f.seat}
                className={`rounded border px-3 py-2 ${isCurrent ? 'border-amber-400 bg-slate-700' : 'border-slate-700 bg-slate-800'} ${
                  !f.alive ? 'opacity-40' : ''
                }`}
              >
                <div className="flex items-center gap-2">
                  <img
                    src={`/static/flags/flag_${f.flag}.png`}
                    alt=""
                    className="h-6 w-5 object-contain"
                    onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
                  />
                  <span className="flex-1 truncate text-sm font-medium" style={{ color: seatColor(f.seat) }}>
                    {f.name}
                    {isMine && <span className="ml-1 text-xs text-emerald-400">（我）</span>}
                  </span>
                </div>
                <div className="mt-1 flex justify-between text-xs text-slate-400">
                  <span>{player ? player.username : f.isAI ? 'AI（休闲）' : '—'}</span>
                  <span>{f.alive ? `点数 ${f.points}` : '已清除'}</span>
                </div>
                {isMine && (
                  <div className="mt-1 flex justify-between text-xs">
                    <span className="text-slate-400">
                      步时 <b className={timer.stepTimeRemain < 10 ? 'animate-pulse text-red-400' : 'text-slate-200'}>{formatClock(timer.stepTimeRemain)}</b>
                    </span>
                    <span className="text-slate-400">
                      局时 <b className={timer.gameTimeRemain < 10 ? 'animate-pulse text-red-400' : 'text-slate-200'}>{formatClock(timer.gameTimeRemain)}</b>
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </aside>

        {/* 中间战场 */}
        <section className="relative min-w-0 flex-1 rounded-lg bg-slate-800/50">
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
          {/* 底部提示条 + 演出控制 */}
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
                  {[1, 2, 4].map((v) => (
                    <button
                      key={v}
                      onClick={() => setPlaySpeed(v)}
                      className={`rounded px-2 py-0.5 hover:bg-slate-600 ${animSpeed === v ? 'bg-slate-600 text-amber-300' : 'bg-slate-700 text-slate-400'}`}
                    >
                      {v}x
                    </button>
                  ))}
                  <button
                    onClick={fastForward}
                    className="rounded bg-slate-700 px-2 py-0.5 text-amber-300 hover:bg-slate-600"
                  >
                    快进（{eventQueue.length} 事件）
                  </button>
                </>
              )}
            </span>
          </div>
        </section>

        {/* 右栏：己方信息 + 行动 */}
        <aside className="w-64 shrink-0 space-y-3 overflow-y-auto">
          <div className="rounded-lg bg-slate-800 p-3">
            <h3 className="mb-2 text-xs font-bold text-slate-400">我的势力</h3>
            {myForce ? (
              <>
                <p className="text-sm font-medium" style={{ color: seatColor(myForce.seat) }}>
                  {myForce.name}
                </p>
                <p className="mt-1 text-xs text-slate-400">点数：{myForce.points}</p>
                <p className="text-xs text-slate-400">状态：{myForce.alive ? '存活' : '已清除'}</p>
              </>
            ) : (
              <p className="text-xs text-slate-500">{isSpectator ? '观战视角（全图可见）' : '未分配势力'}</p>
            )}
          </div>

          {/* 对手计时（TIME_SYNC 校正显示） */}
          <div className="rounded-lg bg-slate-800 p-3">
            <h3 className="mb-2 text-xs font-bold text-slate-400">对手计时</h3>
            {board.forces
              .filter((f) => f.exists && f.alive && f.seat !== mySeat)
              .map((f) => {
                const c = opponentClocks[f.seat];
                return (
                  <p key={f.seat} className="text-xs text-slate-300">
                    {f.name}：{c ? `${formatClock(c.stepTimeRemain)} / ${formatClock(c.gameTimeRemain)}` : '—'}
                  </p>
                );
              })}
          </div>

          {/* 阶段按钮 */}
          <div className="rounded-lg bg-slate-800 p-3">
            <button
              onClick={handleSwitchPhase}
              disabled={!isMyActionTurn || gameOver !== null || fatal !== null}
              className="w-full rounded bg-indigo-600 px-4 py-2.5 font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              {phase === 'ACTION' ? '结束行动阶段' : phase === 'ADD_POINT' ? '结束加点阶段' : '—'}
            </button>
            {!isMyActionTurn && <p className="mt-2 text-center text-xs text-slate-500">仅自己回合的行动/加点阶段可切换</p>}
          </div>
        </aside>
      </main>

      {/* 结算/中止弹窗 */}
      {(gameOver !== null || fatal !== null) && (
        <ResultModal
          gameOver={gameOver}
          fatal={fatal}
          board={board}
          isSpectator={isSpectator}
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

function seatColor(seat: number | undefined): string {
  const COLORS = ['#e63946', '#457b9d', '#2a9d8f', '#e9c46a', '#8e44ad', '#d35400', '#16a085', '#c0392b'];
  return seat === undefined ? '#94a3b8' : COLORS[(seat - 1) % COLORS.length];
}

// 供 Game 页面使用的类型引用（避免未使用告警）
export type { GameEvent, RoomServerMsg };
