// 演示回放页：POST filename 读取 backend/static/demo/<filename>.json，
// 本地 reducer 逐步重放；支持自动循环、暂停、逐步/首尾跳转、速度与缩放。
// 独立入口，不进入登录/模式选择，也不使用对局 store。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { GameState } from '@dl/shared';
import { reducerVersion } from '@dl/shared';
import { ApiError } from '../api/client';
import { fetchDemoReplay } from '../api/demo';
import { EventAnimator, type EventQueueItem } from '../canvas/animator';
import BoardCanvas, { type BoardCanvasHandle } from '../components/BoardCanvas';
import { applyDemoStep, DemoReplayTimeline } from '../game/demoReplay';

const PHASE_LABEL: Record<string, string> = {
  PREPARE: '准备阶段',
  ACTION: '行动阶段',
  ADD_POINT: '加点阶段',
  END: '结束阶段',
};

const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4, 8] as const;
/** 1x = 每 0.5s 执行一条意图 */
const BASE_INTERVAL_MS = 500;

export default function DemoReplay() {
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [errMsg, setErrMsg] = useState('');
  const [filename, setFilename] = useState('');
  const [title, setTitle] = useState('');
  const [input, setInput] = useState('');
  const [board, setBoard] = useState<GameState | null>(null);
  const [cursor, setCursor] = useState(0);
  const [total, setTotal] = useState(0);
  const [auto, setAuto] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [warnings, setWarnings] = useState<string[]>([]);

  const timelineRef = useRef<DemoReplayTimeline | null>(null);
  const boardRef = useRef<GameState | null>(null);
  const cursorRef = useRef(0);
  const totalRef = useRef(0);
  const autoRef = useRef(false);
  const speedRef = useRef(1);
  const nextAtRef = useRef(0);
  const failedRef = useRef<Set<number>>(new Set());
  const boardCanvasRef = useRef<BoardCanvasHandle>(null);

  const queueRef = useRef<EventQueueItem[]>([]);
  const animatorRef = useRef<EventAnimator | null>(null);
  if (animatorRef.current === null) {
    animatorRef.current = new EventAnimator(
      () => queueRef.current,
      () => {
        queueRef.current = queueRef.current.slice(1);
      },
    );
  }

  const warn = useCallback((message: string) => {
    setWarnings((prev) => (prev.includes(message) ? prev : [...prev, message]));
  }, []);

  const markFailed = useCallback(
    (index: number) => {
      if (failedRef.current.has(index)) return;
      failedRef.current.add(index);
      warn(`第 ${index + 1} 步意图被当前规则拒绝，已跳过（可能与生成时的规则版本不同）`);
    },
    [warn],
  );

  /** 前进一步并播放动画 */
  const advanceOne = useCallback(() => {
    const tl = timelineRef.current;
    const cur = boardRef.current;
    if (!tl || !cur) return;
    const n = cursorRef.current;
    if (n >= tl.total) return;
    const r = applyDemoStep(cur, tl.file.steps[n]);
    if (!r.ok) {
      markFailed(n);
      cursorRef.current = n + 1;
      setCursor(n + 1);
      return;
    }
    boardRef.current = r.state;
    setBoard(r.state);
    queueRef.current = [...queueRef.current, { chain: r.chain, beforeTiles: r.beforeTiles }];
    cursorRef.current = n + 1;
    setCursor(n + 1);
  }, [markFailed]);

  /** 定位到第 n 步：无倒放动画，直接重算局面 */
  const seekTo = useCallback(
    (n: number, keepAuto = false) => {
      const tl = timelineRef.current;
      if (!tl) return;
      if (!keepAuto) {
        autoRef.current = false;
        setAuto(false);
      }
      animatorRef.current?.reset();
      animatorRef.current?.setPaused(false);
      queueRef.current = [];
      const { state, failedSteps } = tl.stateAt(n);
      for (const index of failedSteps) markFailed(index);
      boardRef.current = state;
      setBoard(state);
      cursorRef.current = n;
      setCursor(n);
    },
    [markFailed],
  );

  const load = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      setStatus('loading');
      setErrMsg('');
      setWarnings([]);
      failedRef.current = new Set();
      try {
        const file = await fetchDemoReplay(trimmed);
        const tl = new DemoReplayTimeline(file);
        timelineRef.current = tl;
        totalRef.current = tl.total;
        setTotal(tl.total);
        setFilename(trimmed);
        setTitle(file.mapTitle);
        setInput(trimmed.replace(/\.json$/i, ''));
        boardRef.current = tl.initial;
        setBoard(tl.initial);
        cursorRef.current = 0;
        setCursor(0);
        animatorRef.current?.reset();
        animatorRef.current?.setPaused(false);
        animatorRef.current?.setSpeed(1);
        queueRef.current = [];
        speedRef.current = 1;
        setSpeed(1);
        autoRef.current = tl.total > 0;
        setAuto(tl.total > 0);
        nextAtRef.current = performance.now() + BASE_INTERVAL_MS;
        setStatus('ready');

        if (file.reducerVersion !== reducerVersion()) {
          warn(
            `回放由 ${file.reducerVersion || '未知'} 版本生成，当前 ${reducerVersion()}，部分步骤可能被跳过`,
          );
        }
        const url = new URL(window.location.href);
        url.searchParams.set('filename', trimmed.replace(/\.json$/i, ''));
        window.history.replaceState(null, '', url.toString());
      } catch (err) {
        setStatus('error');
        setErrMsg(err instanceof ApiError ? err.message : err instanceof Error ? err.message : '回放加载失败');
      }
    },
    [warn],
  );

  // 首次进入：从 ?filename= 自动加载
  const initialLoadRef = useRef(false);
  useEffect(() => {
    if (initialLoadRef.current) return;
    const query = new URLSearchParams(window.location.search).get('filename');
    if (query) {
      initialLoadRef.current = true;
      void load(query);
    }
  }, [load]);

  // 自动演示循环：按 BASE_INTERVAL_MS / speed 执行；动画未播完时等待
  useEffect(() => {
    if (!auto || status !== 'ready') return;
    nextAtRef.current = performance.now() + BASE_INTERVAL_MS / speedRef.current;
    const iv = window.setInterval(() => {
      if (!autoRef.current) return;
      if (animatorRef.current?.isPlaying) return;
      const now = performance.now();
      if (now < nextAtRef.current) return;
      if (cursorRef.current >= totalRef.current) {
        // 终态停留一个间隔后回到初态，继续循环
        seekTo(0, true);
      } else {
        advanceOne();
      }
      nextAtRef.current = performance.now() + BASE_INTERVAL_MS / speedRef.current;
    }, 25);
    return () => window.clearInterval(iv);
  }, [auto, speed, status, advanceOne, seekTo]);

  useEffect(
    () => () => {
      animatorRef.current?.reset();
      queueRef.current = [];
    },
    [],
  );

  const handleToggleAuto = () => {
    if (autoRef.current) {
      autoRef.current = false;
      setAuto(false);
      animatorRef.current?.setPaused(true);
      return;
    }
    animatorRef.current?.setPaused(false);
    if (cursorRef.current >= totalRef.current) seekTo(0, true);
    autoRef.current = true;
    setAuto(true);
  };

  const handlePrev = () => {
    const n = cursorRef.current <= 0 ? totalRef.current : cursorRef.current - 1;
    seekTo(n);
  };
  const handleNext = () => {
    if (cursorRef.current >= totalRef.current) {
      seekTo(0);
      return;
    }
    autoRef.current = false;
    setAuto(false);
    animatorRef.current?.setPaused(false);
    advanceOne();
  };
  const handleSpeed = (value: number) => {
    speedRef.current = value;
    setSpeed(value);
    animatorRef.current?.setSpeed(value);
    nextAtRef.current = performance.now() + BASE_INTERVAL_MS / value;
  };

  const currentForce = board?.forces.find((f) => f.seat === board.currentSeat);

  if (status === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900 text-slate-400">
        回放加载中…
      </div>
    );
  }

  if (status !== 'ready' || !board) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-900 px-4 text-slate-300">
        <h1 className="text-xl font-bold text-white">演示回放</h1>
        <p className="max-w-md text-center text-sm text-slate-400">
          输入 backend/static/demo 下的文件名（不含 .json），或使用
          <code className="mx-1 rounded bg-slate-800 px-1">/demo-replay?filename=xxx</code>
          直接打开。
        </p>
        {status === 'error' && <p className="text-sm text-red-400">{errMsg}</p>}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void load(input);
          }}
          className="flex w-full max-w-md items-center gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="演示文件名"
            className="min-w-0 flex-1 rounded border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:border-sky-500"
          />
          <button
            type="submit"
            className="shrink-0 rounded bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500"
          >
            载入回放
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-900 text-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700 px-3 py-2.5 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-sm font-medium text-white">演示回放</span>
          <span className="text-sm text-slate-400">{title || filename}</span>
          <span className="text-sm text-slate-400">第 {board.turn} 回合</span>
          <span className="text-sm">
            <span className="text-slate-400">当前行动：</span>
            <span className="font-medium">{currentForce?.name ?? '—'}</span>
            <span className="ml-2 text-xs text-slate-500">{PHASE_LABEL[board.phase]}</span>
          </span>
        </div>
        <span className="text-xs text-slate-500">演示模式</span>
      </header>

      {warnings.length > 0 && (
        <div className="mx-3 mt-2 space-y-1 sm:mx-6">
          {warnings.map((w) => (
            <div key={w} className="rounded bg-amber-900/40 px-3 py-1.5 text-xs text-amber-200">
              {w}
            </div>
          ))}
        </div>
      )}

      <main className="relative flex-1 overflow-hidden px-3 py-3 sm:px-6 sm:py-4">
        <div className="absolute inset-0">
          <BoardCanvas
            ref={boardCanvasRef}
            board={board}
            mySeat={null}
            isSpectator
            fogEnabled={false}
            fogLevels={null}
            phase={board.phase}
            selected={null}
            onTileClick={() => undefined}
            onTileHover={() => undefined}
            animatorRef={animatorRef}
            className="h-full w-full"
          />
        </div>

        <div className="absolute right-2 top-2 z-20 flex flex-col gap-1">
          <button
            onClick={() => boardCanvasRef.current?.zoomBy(1.25)}
            className="flex h-9 w-9 select-none items-center justify-center rounded bg-slate-800/80 text-xl leading-none text-white shadow hover:bg-slate-700 active:bg-slate-600"
            title="放大地图"
            aria-label="放大地图"
          >
            +
          </button>
          <button
            onClick={() => boardCanvasRef.current?.zoomBy(0.8)}
            className="flex h-9 w-9 select-none items-center justify-center rounded bg-slate-800/80 text-xl leading-none text-white shadow hover:bg-slate-700 active:bg-slate-600"
            title="缩小地图"
            aria-label="缩小地图"
          >
            −
          </button>
        </div>

        <div className="absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-x-3 gap-y-2 bg-slate-900/85 px-3 py-2 text-xs text-slate-300 sm:px-4">
          <div className="flex items-center gap-1">
            <button
              onClick={() => seekTo(0)}
              className="rounded bg-slate-700 px-2 py-1 font-mono text-sm text-amber-300 hover:bg-slate-600"
              title="回到初态"
              aria-label="回到初态"
            >
              &lt;&lt;
            </button>
            <button
              onClick={handlePrev}
              className="rounded bg-slate-700 px-2 py-1 font-mono text-sm text-amber-300 hover:bg-slate-600"
              title="上一步"
              aria-label="上一步"
            >
              &lt;
            </button>
            <button
              onClick={handleToggleAuto}
              className="rounded bg-slate-700 px-2 py-1 text-sm text-amber-300 hover:bg-slate-600"
              title={auto ? '暂停自动演示' : '继续自动演示'}
              aria-label={auto ? '暂停自动演示' : '继续自动演示'}
            >
              {auto ? '⏸' : '▶'}
            </button>
            <button
              onClick={handleNext}
              className="rounded bg-slate-700 px-2 py-1 font-mono text-sm text-amber-300 hover:bg-slate-600"
              title="下一步"
              aria-label="下一步"
            >
              &gt;
            </button>
            <button
              onClick={() => seekTo(totalRef.current)}
              className="rounded bg-slate-700 px-2 py-1 font-mono text-sm text-amber-300 hover:bg-slate-600"
              title="跳到终态"
              aria-label="跳到终态"
            >
              &gt;&gt;
            </button>
          </div>

          <div className="flex min-w-48 flex-1 items-center gap-2">
            <input
              type="range"
              min={0}
              max={Math.max(1, total)}
              value={cursor}
              onChange={(e) => seekTo(Number(e.target.value))}
              className="min-w-24 flex-1"
              aria-label="回放进度"
            />
            <span className="w-24 shrink-0 text-right text-slate-400">
              {cursor} / {total} 步
            </span>
          </div>

          <label className="flex items-center gap-1 text-slate-400">
            <span className="sr-only">播放速度</span>
            <select
              value={speed}
              onChange={(e) => handleSpeed(Number(e.target.value))}
              className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-xs text-white outline-none"
              aria-label="自动演示速度"
            >
              {SPEED_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v}x
                </option>
              ))}
            </select>
          </label>
        </div>
      </main>
    </div>
  );
}
