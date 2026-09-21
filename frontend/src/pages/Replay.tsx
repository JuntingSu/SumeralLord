// 历史回放播放器（M5.4）：读取对局日志（GAME_START + 意图流）→ 本地 reducer 重放 →
// 复用 EventAnimator + BoardCanvas 播放演出。纯读无 WS、无共识上报。
// 播放控制：暂停/继续、1x/2x/4x、进度条（按意图数定位，seek 即重放到 N）、快进到结尾。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { GameStartMsg, GameState, PlayerIntent, SoldierState } from '@dl/shared';
import { applyIntent, initState } from '@dl/shared';
import { fetchGameLog } from '../api/game';
import { EventAnimator, type EventQueueItem } from '../canvas/animator';
import BoardCanvas from '../components/BoardCanvas';

interface ReplayIntent {
  intent: PlayerIntent;
  fromSeat: number;
}

function extractIntents(events: Array<Record<string, unknown>>): ReplayIntent[] {
  const list: ReplayIntent[] = [];
  for (const e of events) {
    const m = e as { type?: string; intent?: PlayerIntent; fromSeat?: number; eventId?: number };
    if (m.type === 'INTENT_BROADCAST' && m.intent && typeof m.fromSeat === 'number') {
      list.push({ intent: m.intent, fromSeat: m.fromSeat });
    }
  }
  return list;
}

export default function Replay() {
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();

  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [board, setBoard] = useState<GameState | null>(null);
  const [startInfo, setStartInfo] = useState<GameStartMsg | null>(null);
  const [cursor, setCursor] = useState(0);
  const [total, setTotal] = useState(0);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [replaying, setReplaying] = useState(false);

  const animatorRef = useRef<EventAnimator | null>(null);
  const queueRef = useRef<EventQueueItem[]>([]);
  const intentsRef = useRef<ReplayIntent[]>([]);
  const boardRef = useRef<GameState | null>(null);
  const cursorRef = useRef(0);
  const pausedRef = useRef(false);
  const totalRef = useRef(0);

  const syncCursor = (n: number) => {
    cursorRef.current = n;
    setCursor(n);
  };

  /** 从第 n 条意图重放（seek 与初始化共用）：无动画直接应用到 n */
  const replayTo = useCallback(
    (n: number) => {
      const start = startInfo;
      if (!start) return;
      animatorRef.current?.reset();
      queueRef.current = [];
      const b = initState({
        map: start.map,
        seatAssignments: start.seatAssignments,
        timeSettings: start.timeSettings,
        seed: start.seed,
      }).state;
      let cur = b;
      const intents = intentsRef.current;
      const k = Math.max(0, Math.min(n, intents.length));
      for (let i = 0; i < k; i++) {
        const r = applyIntent(cur, { actor: { kind: 'PLAYER', seat: intents[i].fromSeat }, intent: intents[i].intent });
        if (r.ok) cur = r.state;
      }
      boardRef.current = cur;
      setBoard(cur);
      syncCursor(k);
    },
    [startInfo],
  );

  // 加载对局日志并初始化
  useEffect(() => {
    if (!gameId) return;
    let cancelled = false;
    (async () => {
      try {
        // 按 nextCursor 翻页拉全量（单页 limit=500，长对局需多页拼接）
        let start: GameStartMsg | null = null;
        const events: Array<Record<string, unknown>> = [];
        let after = 0;
        for (let guard = 0; guard < 200; guard++) {
          const page = await fetchGameLog(gameId, after);
          if (page.start && !start) start = page.start;
          events.push(...page.events);
          if (page.nextCursor <= 0) break;
          after = page.nextCursor;
        }
        if (cancelled) return;
        if (!start) {
          setStatus('error');
          setErrMsg('该对局为旧版日志，缺少开局数据，无法回放');
          return;
        }
        intentsRef.current = extractIntents(events);
        totalRef.current = intentsRef.current.length;
        setTotal(intentsRef.current.length);
        setStartInfo(start);
        animatorRef.current = new EventAnimator(
          () => queueRef.current,
          () => {
            queueRef.current = queueRef.current.slice(1);
          },
        );
        animatorRef.current.setSpeed(4); // 默认 4 倍速演出
        const b = initState({
          map: start.map,
          seatAssignments: start.seatAssignments,
          timeSettings: start.timeSettings,
          seed: start.seed,
        }).state;
        boardRef.current = b;
        setBoard(b);
        setStatus('ready');
      } catch (e) {
        if (cancelled) return;
        setStatus('error');
        setErrMsg(e instanceof Error ? e.message : '回放加载失败');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gameId]);

  // 播放循环：animator 空闲且有剩余意图 → 应用下一条（产生链入队 → animator 逐链播放）
  useEffect(() => {
    if (status !== 'ready') return;
    const iv = window.setInterval(() => {
      if (pausedRef.current) return;
      const anim = animatorRef.current;
      if (!anim) return;
      if (anim.isPlaying) return;
      if (cursorRef.current >= totalRef.current) {
        setReplaying(false);
        return;
      }
      const cur = boardRef.current;
      if (!cur) return;
      const item = intentsRef.current[cursorRef.current];
      const r = applyIntent(cur, { actor: { kind: 'PLAYER', seat: item.fromSeat }, intent: item.intent });
      if (r.ok) {
        const beforeTiles: Array<SoldierState | null> = cur.tiles.map((t) => (t.soldier ? { ...t.soldier } : null));
        boardRef.current = r.state;
        setBoard(r.state);
        queueRef.current = [...queueRef.current, { chain: r.chain, beforeTiles }];
      }
      syncCursor(cursorRef.current + 1);
      setReplaying(true);
    }, 100);
    return () => window.clearInterval(iv);
  }, [status]);

  const handlePause = () => {
    const next = !paused;
    animatorRef.current?.setPaused(next);
    pausedRef.current = next;
    setPaused(next);
  };
  const handleSpeed = (v: number) => {
    animatorRef.current?.setSpeed(v);
    setSpeed(v);
  };
  const fastForward = () => {
    animatorRef.current?.reset();
    pausedRef.current = false;
    setPaused(false);
    replayTo(totalRef.current);
  };

  if (status === 'loading') {
    return <div className="flex min-h-screen items-center justify-center bg-slate-900 text-slate-400">回放加载中…</div>;
  }
  if (status === 'error' || !board) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-900 text-slate-400">
        <p>{errMsg || '回放加载失败'}</p>
        <button onClick={() => navigate(-1)} className="rounded bg-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-600">
          返回
        </button>
      </div>
    );
  }

  const finished = board.finished;
  const winners = board.winners ?? [];
  const currentForce = board.forces.find((f) => f.seat === board.currentSeat);

  return (
    <div className="flex min-h-screen flex-col bg-slate-900 text-white">
      <header className="flex items-center justify-between border-b border-slate-700 px-6 py-2.5">
        <div className="flex items-center gap-4">
          <span className="text-sm text-slate-400">回放 · 第 {board.turn} 回合</span>
          <span className="text-sm">
            <span className="text-slate-400">当前行动：</span>
            <span className="font-medium">{currentForce?.name ?? '—'}</span>
          </span>
          {finished && (
            <span className="rounded bg-amber-700 px-2 py-0.5 text-xs">
              {winners.length > 0 ? `🎉 胜利：${winners.join('、')}` : '对局结束（平局/中止）'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Link to="/lobby" className="rounded bg-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-600">
            返回大厅
          </Link>
        </div>
      </header>

      <main className="relative flex-1 overflow-hidden px-6 py-4">
        {/* absolute inset-0：高度确定（相对 padding box），BoardCanvas 的 h-full 百分比才有效
            （block 父级 flex-grow 拉伸的高度对百分比子元素无效，canvas 会塌陷为 0） */}
        <div className="absolute inset-0">
          <BoardCanvas board={board} mySeat={null} isSpectator fogEnabled={false} fogLevels={null} phase={board.phase} selected={null} onTileClick={() => undefined} onTileHover={() => undefined} animatorRef={animatorRef} className="h-full w-full" />
        </div>
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-4 bg-slate-900/80 px-4 py-2 text-xs text-slate-300">
          <span className="flex items-center gap-2">
            <button onClick={handlePause} className="rounded bg-slate-700 px-2 py-0.5 text-amber-300 hover:bg-slate-600">
              {paused ? '继续' : '暂停'}
            </button>
            {[1, 2, 4].map((v) => (
              <button
                key={v}
                onClick={() => handleSpeed(v)}
                className={`rounded px-2 py-0.5 hover:bg-slate-600 ${speed === v ? 'bg-slate-600 text-amber-300' : 'bg-slate-700 text-slate-400'}`}
              >
                {v}x
              </button>
            ))}
            <button
              onClick={fastForward}
              className="rounded bg-slate-700 px-2 py-0.5 text-amber-300 hover:bg-slate-600"
            >
              快进到结尾
            </button>
          </span>
          <span className="flex flex-1 items-center gap-2">
            <input
              type="range"
              min={0}
              max={Math.max(1, total)}
              value={cursor}
              onChange={(e) => replayTo(Number(e.target.value))}
              className="flex-1"
              aria-label="回放进度"
            />
            <span className="w-24 text-right text-slate-400">
              {cursor} / {total} 意图{replaying && cursor < total && !paused ? '（播放中…）' : ''}
            </span>
          </span>
        </div>
      </main>
    </div>
  );
}
