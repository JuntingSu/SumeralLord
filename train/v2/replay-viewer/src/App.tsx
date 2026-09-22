// 独立回放查看器（train/replay-viewer）：上传 jsonl 对局日志 → 本地 reducer 重放 →
// 复用 EventAnimator + BoardCanvas 播放演出。纯本地解析，无后端、无鉴权，任何人的日志均可播放。
// 播放控制：暂停/继续、1x/2x/4x、进度条（按意图数定位，seek 即重放到 N）、快进到结尾。
// 人工示范（demo 模式）：停在行动/加点阶段点击"示范操作"→ 棋盘演示 MOVE/ATTACK/加点（可撤销、可切换阶段）→
// "示范结束"POST /api/demo 落盘 train/demos/（需 npm run dev；构建产物无此端点）。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import type { ApplyResult, GameStartMsg, GameState, PlayerIntent, SoldierState } from '@dl/shared';
import { applyIntent, hashGameState, initState } from '@dl/shared';
import { EventAnimator, type EventQueueItem } from './canvas/animator';
import BoardCanvas from './components/BoardCanvas';
import Workbench from './Workbench';

interface ReplayIntent {
  intent: PlayerIntent;
  fromSeat: number;
}

interface ParsedLog {
  start: GameStartMsg;
  intents: ReplayIntent[];
}

/** 解析对局日志：首行 GAME_START + 其余行意图流（坏行跳过；非 GAME_START 首行 → 不可回放） */
function parseLog(text: string): ParsedLog | null {
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  let start: GameStartMsg | null = null;
  const intents: ReplayIntent[] = [];
  lines.forEach((line, i) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 坏行跳过
    }
    if (i === 0) {
      if (msg.type === 'GAME_START') start = msg as unknown as GameStartMsg;
      return;
    }
    const m = msg as { type?: string; intent?: PlayerIntent; fromSeat?: number };
    if (m.type === 'INTENT_BROADCAST' && m.intent && typeof m.fromSeat === 'number') {
      intents.push({ intent: m.intent, fromSeat: m.fromSeat });
    }
  });
  return start ? { start, intents } : null;
}

type Mode = 'upload' | 'error' | 'playing' | 'demo' | 'workbench';

export default function App() {
  const [mode, setMode] = useState<Mode>('upload');
  const [errMsg, setErrMsg] = useState('');
  const [fileName, setFileName] = useState('');
  const [mapTitle, setMapTitle] = useState('');
  const [board, setBoard] = useState<GameState | null>(null);
  const [startInfo, setStartInfo] = useState<GameStartMsg | null>(null);
  const [cursor, setCursor] = useState(0);
  const [total, setTotal] = useState(0);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [replaying, setReplaying] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // demo 模式状态（示范操作：回放中停在行动阶段 → 棋盘演示 → 保存）
  const [demoState, setDemoState] = useState<GameState | null>(null);
  const [demoSelected, setDemoSelected] = useState<number | null>(null);
  const [demoHistory, setDemoHistory] = useState<GameState[]>([]);
  const [demoIntents, setDemoIntents] = useState<PlayerIntent[]>([]);
  const [demoSeat, setDemoSeat] = useState(1);
  const [demoKind, setDemoKind] = useState<'demo' | 'correction'>('demo');
  const [demoTurnStartEventId, setDemoTurnStartEventId] = useState(0);
  const [demoStartEventId, setDemoStartEventId] = useState(0);
  const [demoPositionHash, setDemoPositionHash] = useState('');
  const [demoNote, setDemoNote] = useState('');
  const [demoError, setDemoError] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const animatorRef = useRef<EventAnimator | null>(null);
  const queueRef = useRef<EventQueueItem[]>([]);
  const intentsRef = useRef<ReplayIntent[]>([]);
  const boardRef = useRef<GameState | null>(null);
  const cursorRef = useRef(0);
  const pausedRef = useRef(false);
  const totalRef = useRef(0);
  /** 各势力各回合 ACTION 相位开始的事件 id（turnStartEventId 采集用） */
  const turnBoundariesRef = useRef<Map<number, number[]>>(new Map());
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const syncCursor = (n: number) => {
    cursorRef.current = n;
    setCursor(n);
  };

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3000);
  };

  /** 应用第 idx 条回放意图并维护回合边界表：
   *  应用后若进入某势力的 ACTION 相位且上一状态不在其回合（currentSeat 变化）→ 记录边界 idx+1。
   *  首回合无边界（initState 即首势力 ACTION），turnStartEventId 回退 0 = 初始局面。 */
  const applyReplayIntent = (cur: GameState, idx: number): ReturnType<typeof applyIntent> => {
    const item = intentsRef.current[idx];
    const r = applyIntent(cur, { actor: { kind: 'PLAYER', seat: item.fromSeat }, intent: item.intent });
    if (r.ok && r.state.phase === 'ACTION' && cur.currentSeat !== r.state.currentSeat) {
      const seat = r.state.currentSeat;
      const arr = turnBoundariesRef.current.get(seat) ?? [];
      if (arr[arr.length - 1] !== idx + 1) {
        arr.push(idx + 1);
        turnBoundariesRef.current.set(seat, arr);
      }
    }
    return r;
  };

  /** 取 seat 的回合初事件 id（≤ cursor 的最后一个边界；首回合 → 0） */
  const turnStartOf = (seat: number, n: number): number => {
    const arr = turnBoundariesRef.current.get(seat);
    if (!arr) return 0;
    let v = 0;
    for (const e of arr) {
      if (e <= n) v = e;
      else break;
    }
    return v;
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
      turnBoundariesRef.current = new Map();
      const k = Math.max(0, Math.min(n, intents.length));
      for (let i = 0; i < k; i++) {
        const r = applyReplayIntent(cur, i);
        if (r.ok) cur = r.state;
      }
      boardRef.current = cur;
      setBoard(cur);
      syncCursor(k);
    },
    [startInfo, syncCursor],
  );

  /** 读取并解析本地日志 → 初始化回放 */
  const loadFile = useCallback(
    async (file: File) => {
      try {
        const text = await file.text();
        const parsed = parseLog(text);
        if (!parsed) {
          setMode('error');
          setErrMsg('不是有效的对局日志：首行必须是 GAME_START 消息（需含 map / seatAssignments / timeSettings / seed）');
          return;
        }
        const { start, intents } = parsed;
        intentsRef.current = intents;
        totalRef.current = intents.length;
        setTotal(intents.length);
        setStartInfo(start);
        setFileName(file.name);
        setMapTitle(start.map.title ?? '');
        setPaused(false);
        pausedRef.current = false;
        setReplaying(false);
        animatorRef.current?.reset();
        queueRef.current = [];
        turnBoundariesRef.current = new Map();
        animatorRef.current = new EventAnimator(
          () => queueRef.current,
          () => {
            queueRef.current = queueRef.current.slice(1);
          },
        );
        animatorRef.current.setSpeed(4); // 默认 4 倍速演出
        setSpeed(4);
        const b = initState({
          map: start.map,
          seatAssignments: start.seatAssignments,
          timeSettings: start.timeSettings,
          seed: start.seed,
        }).state;
        boardRef.current = b;
        setBoard(b);
        syncCursor(0);
        setMode('playing');
      } catch (e) {
        setMode('error');
        setErrMsg(e instanceof Error ? e.message : '文件读取失败');
      }
    },
    [syncCursor],
  );

  const handleFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) void loadFile(f);
    e.target.value = '';
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) void loadFile(f);
  };

  const backToUpload = () => {
    setMode('upload');
    setErrMsg('');
    setFileName('');
    setMapTitle('');
    setBoard(null);
    setStartInfo(null);
    setTotal(0);
    syncCursor(0);
    intentsRef.current = [];
    turnBoundariesRef.current = new Map();
    animatorRef.current?.reset();
    queueRef.current = [];
    setDemoState(null);
    setDemoHistory([]);
    setDemoIntents([]);
  };

  // 播放循环：animator 空闲且有剩余意图 → 应用下一条（产生链入队 → animator 逐链播放）
  useEffect(() => {
    if (mode !== 'playing') return;
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
      const r = applyReplayIntent(cur, cursorRef.current);
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
    // eslint 未启用：applyReplayIntent 仅读 ref，闭包过期无害
  }, [mode, syncCursor]);

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

  // ---------- 人工示范（demo 模式） ----------

  /** 进入演示（kind=demo 自由示范 / kind=correction 纠错）：采集演示起点信息（当前局面引用即基线——reducer 不可变） */
  const startDemo = (kind: 'demo' | 'correction') => {
    if (!board || board.finished || (board.phase !== 'ACTION' && board.phase !== 'ADD_POINT')) return;
    const seat = board.currentSeat;
    setDemoSeat(seat);
    setDemoKind(kind);
    setDemoStartEventId(cursorRef.current);
    setDemoTurnStartEventId(turnStartOf(seat, cursorRef.current));
    setDemoPositionHash(hashGameState(board));
    setDemoState(board);
    setDemoHistory([]);
    setDemoIntents([]);
    setDemoSelected(null);
    setDemoError('');
    setDemoNote('');
    animatorRef.current?.reset(); // 清掉未播完的动画队列，避免返回回放后串场
    queueRef.current = [];
    setMode('demo');
  };

  /** 本地验证并应用一条演示意图（MOVE/ATTACK/ADD_POINT/SWITCH_PHASE）：ok → 应用前状态入栈 + 记录意图；
   *  拒绝 → 提示原因不入栈。返回应用结果（null = 未应用）。 */
  const applyDemoIntent = (intent: PlayerIntent): ApplyResult | null => {
    if (!demoState) return null;
    const b = demoState;
    if (b.currentSeat !== demoSeat) return null;
    const r = applyIntent(b, { actor: { kind: 'PLAYER', seat: demoSeat }, intent });
    if (!r.ok) {
      setDemoError(`操作被拒绝：${r.reason}`);
      return null;
    }
    setDemoError('');
    setDemoHistory((h) => [...h, b]); // 栈存应用前状态（撤销用）
    setDemoIntents((i) => [...i, intent]);
    setDemoState(r.state);
    return r;
  };

  /** 演示棋盘交互（同 Game.tsx）：行动阶段点己方有移动力兵选中/取消 → 点目标格：敌兵 ATTACK / 空格 MOVE / 同队忽略；
   *  加点阶段点己方连兵 +1 点（可连点；点数用尽自动结束回合）。 */
  const handleDemoClick = (tile: number) => {
    if (!demoState) return;
    const b = demoState;
    if (b.currentSeat !== demoSeat) {
      // 回合已推进（点数用尽 autoSkip / 切换阶段提前结束）——明确提示，避免"点了没反应"
      setDemoError('演示势力的回合已结束（点数用尽或切换阶段），可撤销或保存示范');
      return;
    }
    if (b.phase === 'ADD_POINT') {
      const soldier = b.tiles[tile].soldier;
      if (!soldier || soldier.owner !== demoSeat || !soldier.isLinked) {
        setDemoError(soldier && soldier.owner === demoSeat ? '该兵不是连兵，无法加点' : '只能点击己方连兵加点');
        return;
      }
      applyDemoIntent({ intentType: 'ADD_POINT', coordinate: tile, amount: 1 });
      setDemoSelected(null);
      return;
    }
    if (b.phase !== 'ACTION') return;
    const soldier = b.tiles[tile].soldier;
    if (soldier && soldier.owner === demoSeat) {
      if (soldier.hasMovement && !(soldier.isLinked && soldier.strength === 1)) setDemoSelected(tile === demoSelected ? null : tile);
      else setDemoSelected(null);
      return;
    }
    if (demoSelected === null) return;
    const selSoldier = b.tiles[demoSelected].soldier;
    if (!selSoldier || selSoldier.owner !== demoSeat) {
      setDemoSelected(null);
      return;
    }
    const target = b.tiles[tile].soldier;
    let intent: PlayerIntent;
    if (target && target.owner !== demoSeat) {
      intent = { intentType: 'ATTACK', from: demoSelected, to: tile };
    } else if (!target) {
      intent = { intentType: 'MOVE', from: demoSelected, to: tile };
    } else {
      return; // 同队兵目标：无效
    }
    const r = applyDemoIntent(intent);
    if (!r) return;
    // 自动续选（同 Game.tsx nextSelectedTile）：目标格新兵仍有移动力则继续选中，便于连击
    const ns = r.state.tiles[intent.to].soldier;
    if (ns && ns.owner === demoSeat && ns.hasMovement && !(ns.isLinked && ns.strength === 1)) setDemoSelected(intent.to);
    else setDemoSelected(null);
  };

  /** 切换阶段（ACTION → ADD_POINT；ADD_POINT 且有余点 → 提前结束回合） */
  const switchDemoPhase = () => {
    if (!demoState) return;
    if (applyDemoIntent({ intentType: 'SWITCH_PHASE' })) setDemoSelected(null);
  };

  /** 撤销上一步演示（仅限本次演示；栈空禁用） */
  const undoDemo = () => {
    setDemoHistory((h) => {
      if (h.length === 0) return h;
      const prev = h[h.length - 1];
      setDemoState(prev);
      setDemoIntents((i) => i.slice(0, -1));
      setDemoSelected(null);
      setDemoError('');
      return h.slice(0, -1);
    });
  };

  /** 放弃本次演示，返回回放 */
  const exitDemo = () => {
    setDemoState(null);
    setDemoHistory([]);
    setDemoIntents([]);
    setDemoSelected(null);
    setDemoNote('');
    setDemoError('');
    setMode('playing');
  };

  /** 组装示范/纠错 JSON 并 POST /api/demo 落盘（仅 vite dev 中间件提供该端点） */
  const saveDemo = async () => {
    if (demoIntents.length === 0) {
      setDemoError('请先演示至少一个操作');
      return;
    }
    const start = startInfo;
    if (!start) return;
    setSaving(true);
    try {
      const demo = {
        id: `demo-${Date.now()}`,
        kind: demoKind,
        createdAt: new Date().toISOString(),
        sourceGameId: start.gameId,
        seat: demoSeat,
        turnStartEventId: demoTurnStartEventId,
        startEventId: demoStartEventId,
        positionHash: demoPositionHash,
        intents: demoIntents,
        // 纠错：附上 AI 在该位置的实际动作（当前事件号前的最后一条意图）
        aiAction: demoKind === 'correction' ? (intentsRef.current[demoStartEventId - 1]?.intent ?? null) : undefined,
        note: demoNote,
      };
      const res = await fetch('/api/demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(demo),
      });
      const data = (await res.json()) as { ok: boolean; file?: string; error?: string };
      if (!data.ok) throw new Error(data.error ?? '保存失败');
      showToast(`${demoKind === 'correction' ? '纠错' : '示范'}已保存到 ${data.file ?? 'v2/demos/'}`);
      exitDemo();
    } catch (e) {
      setDemoError(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  if (mode === 'workbench') {
    return <Workbench onExit={() => setMode('playing')} />;
  }

  if (!board || (mode !== 'playing' && mode !== 'demo')) {
    return (
      <div
        className={`flex min-h-screen flex-col items-center justify-center gap-6 bg-slate-900 p-8 text-white ${dragOver ? '' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <div className="text-center">
          <h1 className="text-2xl font-bold text-amber-300">数字领主 · 回放查看器</h1>
          <p className="mt-2 text-sm text-slate-400">上传对局日志（.jsonl）即可播放 —— 纯本地解析重放，无后端、无鉴权，任何对局日志都能看</p>
        </div>

        <label
          className={`cursor-pointer rounded-lg border-2 border-dashed px-10 py-8 text-center transition-colors ${
            dragOver ? 'border-amber-400 bg-slate-800' : 'border-slate-600 bg-slate-800/60 hover:border-slate-400'
          }`}
        >
          <input type="file" accept=".jsonl,.json,.log,.txt" onChange={handleFileInput} className="hidden" />
          <span className="block text-lg">{dragOver ? '松开鼠标上传' : '点击选择 jsonl 文件'}</span>
          <span className="mt-2 block text-xs text-slate-500">也可以直接把文件拖进本窗口</span>
        </label>

        {mode === 'error' && <p className="max-w-md text-center text-sm text-red-400">{errMsg}</p>}

        <div className="max-w-md text-center text-xs leading-5 text-slate-500">
          <p>日志格式：每行一条 JSON。首行必须是 <span className="text-slate-400">GAME_START</span>（含 map / seatAssignments / timeSettings / seed），后续为
          <span className="text-slate-400"> INTENT_BROADCAST</span> 意图流（GAME_OVER 等其余消息自动忽略）。</p>
        </div>
      </div>
    );
  }

  const finished = board.finished;
  const winners = board.winners ?? [];
  const currentForce = board.forces.find((f) => f.seat === board.currentSeat);
  const canDemo = !board.finished && (board.phase === 'ACTION' || board.phase === 'ADD_POINT');

  return (
    <div className="flex min-h-screen flex-col bg-slate-900 text-white">
      <header className="flex items-center justify-between border-b border-slate-700 px-6 py-2.5">
        <div className="flex items-center gap-4">
          <span className="text-sm text-slate-400">回放 · 第 {board.turn} 回合</span>
          <span className="max-w-52 truncate text-sm">
            <span className="text-slate-400">当前行动：</span>
            <span className="font-medium">{currentForce?.name ?? '—'}</span>
          </span>
          <span className="max-w-52 truncate text-xs text-slate-500">
            {fileName}{mapTitle ? ` · ${mapTitle}` : ''}
          </span>
          {mode === 'demo' && (
            <span className="rounded bg-amber-700 px-2 py-0.5 text-xs">{demoKind === 'correction' ? '纠错中' : '演示中'}</span>
          )}
          {finished && (
            <span className="rounded bg-amber-700 px-2 py-0.5 text-xs">
              {winners.length > 0 ? `🎉 胜利：${winners.join('、')}` : '对局结束（平局/中止）'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {mode !== 'demo' && (
            <>
              <button
                onClick={() => startDemo('demo')}
                disabled={!canDemo}
                title={canDemo ? '在行动/加点阶段演示你的操作（移动/进攻/切换阶段/加点）' : '请停在行动或加点阶段'}
                className="rounded bg-amber-700 px-3 py-1 text-sm text-white hover:bg-amber-600 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
              >
                示范操作
              </button>
              <button
                onClick={() => startDemo('correction')}
                disabled={!canDemo}
                title={canDemo ? '标记此处 AI 走错了，并演示正确操作' : '请停在行动或加点阶段'}
                className="rounded bg-rose-800 px-3 py-1 text-sm text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500"
              >
                纠错
              </button>
              <button
                onClick={() => setMode('workbench')}
                title="打开判题工作台（上传 pairs 题目文件逐题判定）"
                className="rounded bg-sky-800 px-3 py-1 text-sm text-white hover:bg-sky-700"
              >
                判题工作台
              </button>
            </>
          )}
          <button onClick={backToUpload} className="rounded bg-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-600">
            选择其他文件
          </button>
        </div>
      </header>

      <main className="relative flex-1 overflow-hidden px-6 py-4">
        {/* absolute inset-0：高度确定（相对 padding box），BoardCanvas 的 h-full 百分比才有效
            （block 父级 flex-grow 拉伸的高度对百分比子元素无效，canvas 会塌陷为 0） */}
        <div className="absolute inset-0">
          {mode === 'demo' && demoState ? (
            // 演示：本势力视角 + 选中/行动高亮 + 交互（无动画直渲 demoState）
            <BoardCanvas
              board={demoState}
              mySeat={demoSeat}
              isSpectator={false}
              fogEnabled={false}
              fogLevels={null}
              phase={demoState.phase}
              selected={demoSelected}
              onTileClick={handleDemoClick}
              onTileHover={() => undefined}
              animatorRef={null}
              className="h-full w-full"
            />
          ) : (
            <BoardCanvas board={board} mySeat={null} isSpectator fogEnabled={false} fogLevels={null} phase={board.phase} selected={null} onTileClick={() => undefined} onTileHover={() => undefined} animatorRef={animatorRef} className="h-full w-full" />
          )}
        </div>
        {mode === 'demo' ? (
          <div className="absolute inset-x-0 bottom-0 flex flex-col gap-1 bg-slate-900/80 px-4 py-2 text-xs text-slate-300">
            <div className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-2">
                <button
                  onClick={undoDemo}
                  disabled={demoHistory.length === 0}
                  className="rounded bg-slate-700 px-2 py-0.5 text-amber-300 hover:bg-slate-600 disabled:cursor-not-allowed disabled:text-slate-500"
                >
                  撤销
                </button>
                <button
                  onClick={switchDemoPhase}
                  disabled={!demoState || demoState.currentSeat !== demoSeat || (demoState.phase !== 'ACTION' && demoState.phase !== 'ADD_POINT')}
                  title={demoState?.phase === 'ADD_POINT' ? '加点阶段：结束回合（有余点时）' : '结束行动阶段，进入加点'}
                  className="rounded bg-slate-700 px-2 py-0.5 text-amber-300 hover:bg-slate-600 disabled:cursor-not-allowed disabled:text-slate-500"
                >
                  切换阶段
                </button>
                <button
                  onClick={() => void saveDemo()}
                  disabled={saving}
                  className="rounded bg-amber-700 px-2 py-0.5 text-white hover:bg-amber-600 disabled:opacity-60"
                >
                  {saving ? '保存中…' : '示范结束'}
                </button>
                <button onClick={exitDemo} className="rounded bg-slate-700 px-2 py-0.5 text-slate-200 hover:bg-slate-600">
                  返回
                </button>
                <input
                  value={demoNote}
                  onChange={(e) => setDemoNote(e.target.value)}
                  placeholder="备注（可选）"
                  className="w-48 rounded bg-slate-800 px-2 py-0.5 text-slate-200 placeholder:text-slate-500"
                />
              </span>
              <span className="text-slate-400">已演示 {demoIntents.length} 步 · 点己方兵选中 → 点目标格移动/进攻；加点阶段点连兵 +1 点</span>
            </div>
            {demoError && <div className="text-red-400">{demoError}</div>}
          </div>
        ) : (
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
        )}
      </main>

      {toast && (
        <div className="pointer-events-none fixed bottom-20 left-1/2 z-50 -translate-x-1/2 rounded bg-slate-800 px-4 py-2 text-sm text-amber-300 shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
