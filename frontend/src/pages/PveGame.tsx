// PVE 对局：复用棋盘/交互/动画，但使用本地 PveTransport；无计时、无聊天、无系统通知。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { applyIntent, initState, reducerVersion } from '@dl/shared';
import type {
  GameOverMsg,
  GameState,
  PveGameConfig,
  PveSaveBody,
  PveSavePayload,
  PlayerIntent,
} from '@dl/shared';
import { AI_LEVEL_LABEL } from '@dl/shared';
import { useAuth } from '../stores/auth';
import { attachTransport, useGame } from '../stores/game';
import { usePve } from '../stores/pve';
import { PveTransport } from '../game/pveTransport';
import { createMctsPlanner, type PveAiPlanner } from '../game/pveAi';
import { deletePveSave, getPveWeights, savePveGame } from '../api/pve';
import { ApiError } from '../api/client';
import { computeFog, type FogLevel } from '../game/fog';
import { EventAnimator } from '../canvas/animator';
import { flagImgUrl } from '../lib/flags';
import { useNarrowScreen } from '../lib/useNarrowScreen';
import { shouldAutoSkipPhase } from '../game/dim';
import BoardCanvas, { INITIAL_TILE_WIDTH_PX, type BoardCanvasHandle } from '../components/BoardCanvas';
import { TriggerScreenTexts, TriggerTileBubbles } from '../components/TriggerTextOverlay';
import PveResultModal from '../components/PveResultModal';

const PHASE_LABEL: Record<string, string> = {
  PREPARE: '准备阶段',
  ACTION: '行动阶段',
  ADD_POINT: '加点阶段',
  END: '结束阶段',
};

function randomToken(len: number): string {
  const bytes = new Uint8Array(Math.ceil(len / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, len);
}

function seatColor(seat: number | undefined): string {
  const COLORS = ['#e63946', '#457b9d', '#2a9d8f', '#e9c46a', '#8e44ad', '#d35400', '#16a085', '#c0392b'];
  return seat === undefined ? '#94a3b8' : COLORS[(seat - 1) % COLORS.length];
}

/** MOVE/ATTACK 提交后的自动续选（与 reducer 同源本地模拟） */
function nextSelectedTile(board: GameState, intent: PlayerIntent): number | null {
  if (intent.intentType !== 'MOVE' && intent.intentType !== 'ATTACK') return null;
  const r = applyIntent(board, { actor: { kind: 'PLAYER', seat: board.currentSeat }, intent });
  if (!r.ok) return null;
  const s = r.state.tiles[intent.to].soldier;
  if (!s || s.owner !== board.currentSeat) return null;
  if (!s.hasMovement) return null;
  if (s.isLinked && s.strength === 1) return null;
  return intent.to;
}

export default function PveGame() {
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const isNarrow = useNarrowScreen();

  const board = useGame((s) => s.board);
  const mySeat = useGame((s) => s.mySeat);
  const isSpectator = useGame((s) => s.isSpectator);
  const gameOver = useGame((s) => s.gameOver);
  const fatal = useGame((s) => s.fatal);
  const appliedEventId = useGame((s) => s.appliedEventId);
  const eventQueue = useGame((s) => s.eventQueue);
  const fogMode = useGame((s) => s.fogMode);
  const undoAvailable = useGame((s) => s.undoAvailable);
  const submitting = useGame((s) => s.submitting);
  const systemNotices = useGame((s) => s.systemNotices);
  const phaseAnnouncements = useGame((s) => s.phaseAnnouncements);
  const triggerTexts = useGame((s) => s.triggerTexts);
  const dismissTriggerText = useGame((s) => s.dismissTriggerText);
  const screenTexts = useMemo(
    () => triggerTexts.filter((t) => t.placement?.kind !== 'tile'),
    [triggerTexts],
  );
  const tileTexts = useMemo(
    () => triggerTexts.filter((t) => t.placement?.kind === 'tile'),
    [triggerTexts],
  );

  const [runId, setRunId] = useState(0);
  const [starting, setStarting] = useState(true);
  const [startError, setStartError] = useState<string | null>(null);
  const [aiWarning, setAiWarning] = useState<string | null>(null);
  const [aiThinking, setAiThinking] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const configRef = useRef<PveGameConfig | null>(null);
  const transportRef = useRef<PveTransport | null>(null);
  const plannerRef = useRef<PveAiPlanner | null>(null);
  const plannerPromiseRef = useRef<Promise<PveAiPlanner | null> | null>(null);

  const [selected, setSelected] = useState<number | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [exploredMemo, setExploredMemo] = useState<Set<number>>(new Set());
  const addPointRef = useRef<{ timer: number | null; accumulated: number; lastSend: number }>({
    timer: null,
    accumulated: 0,
    lastSend: 0,
  });
  const [compactSidebar, setCompactSidebar] = useState(true);
  /** 简略势力信息面板是否展开（收起后棋盘左上角只留「》」展开按钮） */
  const [factionPanelOpen, setFactionPanelOpen] = useState(true);
  const [killFloats, setKillFloats] = useState<{ id: number; text: string }[]>([]);
  const killFloatIdRef = useRef(0);

  // ---------- 启动 / 读档 / 再来一局 ----------
  useEffect(() => {
    let disposed = false;
    setStarting(true);
    setStartError(null);
    setAiWarning(null);
    setSaveMsg(null);

    const start = async () => {
      const loadRequested = new URLSearchParams(window.location.search).get('load') === '1';
      const save = usePve.getState().loadSave;
      const lastGame = usePve.getState().lastGame;
      let config: PveGameConfig;
      let state: GameState;
      let chain: ReturnType<typeof initState>['chain'] | null = null;

      if (loadRequested) {
        if (!save) {
          navigate('/pve', { replace: true });
          return;
        }
        config = {
          gameId: save.gameId,
          map: save.config.map,
          mapTitle: save.mapTitle,
          seatAssignments: save.config.seatAssignments,
          seed: save.state.seed,
          timeSettings: save.state.timeSettings,
          fogMode: save.config.fogMode,
          usePersonalSkin: save.config.usePersonalSkin,
          playerSeat: save.state.controlledSeat ?? save.config.playerSeat,
          humanUserId: save.config.humanUserId,
          reducerVersion: save.reducerVersion,
        };
        state = structuredClone(save.state);
        if (state.finished) {
          await deletePveSave().catch(() => undefined);
          usePve.getState().clearLoadSave();
          navigate('/pve', { replace: true });
          return;
        }
        if (save.reducerVersion !== reducerVersion()) {
          setStartError('存档来自旧版本，无法继续；请返回房间放弃存档。');
          setStarting(false);
          return;
        }
      } else {
        if (!lastGame) {
          navigate('/pve', { replace: true });
          return;
        }
        config = lastGame;
        const init = initState({
          map: config.map,
          seatAssignments: config.seatAssignments,
          seed: config.seed,
          timeSettings: config.timeSettings,
          triggerMode: (config.map.triggers?.length ?? 0) > 0,
          controlledSeat: config.playerSeat,
          humanPlayerId: config.humanUserId,
        });
        state = structuredClone(init.state);
        chain = init.chain;
      }

      let activeConfig = config;
      let planner: PveAiPlanner | null = null;
      const mediumSeats = config.seatAssignments.filter((a) => a.isAI && (a.computer ?? 1) === 2).map((a) => a.seat);
      if (mediumSeats.length > 0) {
        try {
          const weights = await getPveWeights();
          if (disposed) return;
          planner = await createMctsPlanner(weights.weights);
          if (disposed) {
            planner.dispose();
            return;
          }
        } catch {
          if (disposed) return;
          setAiWarning('普通 AI 权重加载失败，已将普通难度势力改为简单 AI。');
          const seatSet = new Set(mediumSeats);
          activeConfig = {
            ...config,
            seatAssignments: config.seatAssignments.map((a) =>
              seatSet.has(a.seat) ? { ...a, computer: 1 } : a,
            ),
          };
          for (const f of state.forces) {
            if (seatSet.has(f.seat)) f.computer = 1;
          }
        }
      }

      if (disposed) {
        planner?.dispose();
        return;
      }

      configRef.current = activeConfig;
      plannerRef.current = planner;
      usePve.getState().setLastGame(activeConfig);

      const ensurePlanner = async (): Promise<
        ((s: GameState, seat: number) => Promise<PlayerIntent[]>) | null
      > => {
        if (plannerRef.current) return plannerRef.current.plan;
        if (!plannerPromiseRef.current) {
          plannerPromiseRef.current = (async () => {
            const weights = await getPveWeights();
            const created = await createMctsPlanner(weights.weights);
            if (disposed) {
              created.dispose();
              return null;
            }
            plannerRef.current = created;
            return created;
          })().catch((err: unknown) => {
            plannerPromiseRef.current = null;
            throw err;
          });
        }
        const created = await plannerPromiseRef.current;
        return created?.plan ?? null;
      };

      const transport = new PveTransport({
        config: activeConfig,
        initialState: state,
        onPlanMcts: planner?.plan,
        ensurePlanner,
        onAiFallback: (_seat, reason) =>
          setAiWarning(`普通 AI 不可用，已降级为简单 AI（${reason}）`),
        onThinking: setAiThinking,
      });
      transportRef.current = transport;
      const detach = attachTransport(transport);

      if (loadRequested) {
        useGame.getState().restorePveGame({
          roomId: 'pve',
          gameId: activeConfig.gameId,
          state,
          seatAssignments: activeConfig.seatAssignments,
          myUserId: activeConfig.humanUserId,
          fogMode: activeConfig.fogMode,
          map: activeConfig.map,
        });
      } else {
        useGame.getState().startPveGame({
          roomId: 'pve',
          gameId: activeConfig.gameId,
          state,
          chain: chain ?? [],
          seatAssignments: activeConfig.seatAssignments,
          myUserId: activeConfig.humanUserId,
          fogMode: activeConfig.fogMode,
          map: activeConfig.map,
        });
      }
      setStarting(false);
      await transport.connect();

      // 卸载时清理（effect 的 cleanup 也可能先执行）
      if (disposed) {
        transport.close();
        planner?.dispose();
        detach();
      }
    };

    void start().catch((err) => {
      if (!disposed) {
        setStartError(err instanceof ApiError ? err.message : '对局启动失败');
        setStarting(false);
      }
    });

    return () => {
      disposed = true;
      transportRef.current?.close();
      transportRef.current = null;
      plannerRef.current?.dispose();
      plannerRef.current = null;
      plannerPromiseRef.current = null;
      useGame.getState().reset();
      setAiThinking(false);
    };
  }, [runId, navigate]);

  // ---------- 动画播放器 ----------
  const animatorRef = useRef<EventAnimator | null>(null);
  /** 棋盘命令式缩放（窄屏 +/− 按钮） */
  const boardRef = useRef<BoardCanvasHandle>(null);
  if (animatorRef.current === null) {
    animatorRef.current = new EventAnimator(
      () => useGame.getState().eventQueue,
      () => useGame.getState().popChain(),
    );
    animatorRef.current.setSpeed(4);
  }
  const [animPaused, setAnimPaused] = useState(false);
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

  // ---------- 阶段提示 ----------
  const [announceText, setAnnounceText] = useState<string | null>(null);
  const [announceFading, setAnnounceFading] = useState(false);
  const announceQueueRef = useRef<string[]>([]);
  const announceTextRef = useRef<string | null>(null);
  announceTextRef.current = announceText;

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

  // ---------- 系统通知：只取“被击败”做飘字，不写聊天 ----------
  useEffect(() => {
    if (systemNotices.length === 0) return;
    const drained = useGame.getState().drainSystemNotices();
    if (drained.length === 0) return;
    const b = useGame.getState().board;
    for (const n of drained) {
      if (n.kind !== 'forceCleared') continue;
      const f = b?.forces.find((x) => x.seat === n.seat);
      if (!f) continue;
      const id = ++killFloatIdRef.current;
      setKillFloats((prev) => [...prev, { id, text: `${f.name}已被击败` }]);
      window.setTimeout(() => setKillFloats((prev) => prev.filter((k) => k.id !== id)), 2000);
    }
  }, [systemNotices]);

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
    return computeFog(
      board.rows,
      board.columns,
      board.cylindrical,
      mySoldierTiles,
      fogEnabled,
      exploredMemo,
      board.fogOverrides,
    ).levels;
  }, [board, mySoldierTiles, fogEnabled, exploredMemo]);
  useEffect(() => {
    if (!board) return;
    const { explored } = computeFog(
      board.rows,
      board.columns,
      board.cylindrical,
      mySoldierTiles,
      fogEnabled,
      exploredMemo,
      board.fogOverrides,
    );
    setExploredMemo(explored);
  }, [board, mySoldierTiles, fogEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // 控制转移后重置迷雾记忆与选中态（旧势力的探索记忆不属于新势力）
  const prevMySeatRef = useRef<number | null>(mySeat);
  useEffect(() => {
    if (prevMySeatRef.current === mySeat) return;
    prevMySeatRef.current = mySeat;
    setExploredMemo(new Set());
    setSelected(null);
    setHovered(null);
  }, [mySeat]);

  // ---------- 意图交互 ----------
  const handleTileClick = useCallback(
    (tile: number) => {
      const s = useGame.getState();
      const b = s.board;
      if (!b || s.isSpectator || s.gameOver || s.fatal) return;
      if (animatorRef.current?.isPlaying) return;
      if (b.currentSeat !== s.mySeat) return;
      if (b.phase !== 'ACTION') return;
      const soldier = b.tiles[tile].soldier;
      if (soldier && soldier.owner === s.mySeat) {
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
      if (target && target.owner !== s.mySeat) intent = { intentType: 'ATTACK', from: selected, to: tile };
      else if (!target) intent = { intentType: 'MOVE', from: selected, to: tile };
      else return;
      s.submitIntent(intent);
      setSelected(nextSelectedTile(b, intent));
    },
    [selected],
  );

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

  const cancelAddPoint = useCallback(() => {
    const r = addPointRef.current;
    if (r.timer !== null) {
      window.clearInterval(r.timer);
      r.timer = null;
    }
    r.accumulated = 0;
  }, []);

  const startAddPoint = useCallback(
    (tile: number) => {
      const s = useGame.getState();
      const b = s.board;
      if (!b || s.isSpectator || s.gameOver || s.fatal) return;
      if (animatorRef.current?.isPlaying) return;
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
        if (Date.now() - r.lastSend >= 500) {
          g.submitIntent({ intentType: 'ADD_POINT', coordinate: tile, amount: r.accumulated });
          r.accumulated = 0;
          r.lastSend = Date.now();
        }
      }, 150);
    },
    [stopAddPoint],
  );

  useEffect(() => () => cancelAddPoint(), [cancelAddPoint]);

  // ---------- 自动跳过阶段：前端判定后以 SWITCH_PHASE 发起（reducer 不再自动跳转） ----------
  // 行动阶段：自己席位的兵全部按渲染规则变灰；加点阶段：点数耗尽。同一局面状态只发一次。
  const autoSkipKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!board || mySeat === null || isSpectator || gameOver || fatal) return;
    if (!shouldAutoSkipPhase(board, mySeat)) return;
    const key = `${appliedEventId}:${board.currentSeat}:${board.phase}`;
    if (autoSkipKeyRef.current === key) return;
    autoSkipKeyRef.current = key;
    useGame.getState().submitIntent({ intentType: 'SWITCH_PHASE' });
  }, [board, mySeat, isSpectator, gameOver, fatal, appliedEventId]);

  // ---------- 操作 ----------
  const phase = board?.phase ?? 'PREPARE';
  const myTurn = board !== null && mySeat !== null && board.currentSeat === mySeat && !isSpectator;
  const isMyActionTurn = myTurn && (phase === 'ACTION' || phase === 'ADD_POINT');

  const handleSwitchPhase = () => {
    const s = useGame.getState();
    if (!s.board || s.gameOver || s.fatal) return;
    if (animatorRef.current?.isPlaying) return;
    if (s.board.currentSeat !== s.mySeat) return;
    s.submitIntent({ intentType: 'SWITCH_PHASE' });
    setSelected(null);
  };

  const handleSurrender = () => {
    if (!window.confirm('确定投降？')) return;
    const s = useGame.getState();
    if (s.mySeat === null || s.gameOver) return;
    s.submitIntent({ intentType: 'SURRENDER', seat: s.mySeat, reason: 'voluntary' });
  };

  const handleUndo = () => {
    if (!useGame.getState().undoAvailable) return;
    cancelAddPoint();
    useGame.getState().undoLastIntent();
    animatorRef.current?.reset();
    setSelected(null);
    setExploredMemo(new Set());
    setKillFloats([]);
    announceQueueRef.current = [];
    setAnnounceText(null);
    setAnnounceFading(false);
  };

  const handleSave = async () => {
    const transport = transportRef.current;
    const config = configRef.current;
    if (!transport || !config || saving || gameOver) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const snap = transport.snapshot();
      const payload: PveSavePayload = {
        version: 3,
        gameId: config.gameId,
        reducerVersion: config.reducerVersion,
        savedAt: Date.now(),
        mapTitle: config.mapTitle,
        state: snap.state,
        config: {
          map: config.map,
          seatAssignments: config.seatAssignments,
          fogMode: config.fogMode,
          usePersonalSkin: config.usePersonalSkin,
          playerSeat: snap.state.controlledSeat ?? config.playerSeat,
          humanUserId: config.humanUserId,
        },
        meta: snap.meta,
      };
      const body: PveSaveBody = {
        gameId: config.gameId,
        mapTitle: config.mapTitle,
        turn: snap.meta.turn,
        phase: snap.meta.phase,
        currentSeat: snap.meta.currentSeat,
        currentForce: snap.meta.currentForceName,
        payload,
      };
      await savePveGame(body);
      setSaveMsg(`已保存 ${new Date().toLocaleTimeString()}`);
    } catch (err) {
      setSaveMsg(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const clearLoadAndNavigate = (path: string) => {
    usePve.getState().clearLoadSave();
    navigate(path);
  };

  const handleExit = () => {
    if (!window.confirm('退出对局？未存档的进度将丢失。')) return;
    clearLoadAndNavigate('/pve');
  };

  const handleNewGame = () => {
    const base = configRef.current;
    if (!base) return;
    animatorRef.current?.reset();
    setSelected(null);
    setExploredMemo(new Set());
    setKillFloats([]);
    announceQueueRef.current = [];
    setAnnounceText(null);
    setAnnounceFading(false);
    setSaveMsg(null);
    setAiWarning(null);
    setStartError(null);
    const next: PveGameConfig = { ...base, gameId: `pve-${randomToken(8)}`, seed: randomToken(16) };
    usePve.getState().setLoadSave(null);
    usePve.getState().setLastGame(next);
    navigate('/pve/game', { replace: true });
    setRunId((n) => n + 1);
  };

  // 对局结束：无条件清空当前账号存档
  useEffect(() => {
    if (!gameOver) return;
    void deletePveSave().catch(() => undefined);
  }, [gameOver]);

  // ---------- 渲染 ----------
  if (!board) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-slate-900 text-slate-400">
        <p>{startError ?? (starting ? '对局加载中…' : '对局加载中…')}</p>
        {startError && (
          <button onClick={() => navigate('/pve')} className="rounded bg-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-600">
            返回房间
          </button>
        )}
      </div>
    );
  }

  const currentForce = board.forces.find((f) => f.seat === board.currentSeat);
  const aliveForces = board.forces.filter((f) => f.exists);

  return (
    <div className="flex min-h-screen flex-col bg-slate-900 text-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700 px-3 py-2.5 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-sm text-slate-400">第 {board.turn} 回合</span>
          <span className="text-sm">
            <span className="text-slate-400">当前行动：</span>
            <span className="font-medium" style={{ color: seatColor(currentForce?.seat) }}>
              {currentForce?.name ?? '—'}
            </span>
            <span className="ml-2 text-xs text-slate-500">{PHASE_LABEL[phase]}</span>
          </span>
          {aiThinking && <span className="text-xs text-sky-400">AI 思考中…</span>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-slate-500">本地对局</span>
          {saveMsg && <span className="text-xs text-emerald-400">{saveMsg}</span>}
          <button
            onClick={handleSave}
            disabled={saving || gameOver !== null}
            className="rounded bg-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-600 disabled:opacity-40"
          >
            {saving ? '保存中…' : '💾 存档'}
          </button>
          <button
            onClick={handleSurrender}
            disabled={board.finished}
            className="rounded bg-red-800 px-3 py-1 text-sm text-red-100 hover:bg-red-700 disabled:opacity-40"
          >
            投降
          </button>
          <button onClick={handleExit} className="rounded bg-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-600">
            退出
          </button>
        </div>
      </header>

      <TriggerScreenTexts texts={screenTexts} onDismiss={dismissTriggerText} />

      {aiWarning && (
        <div className="mx-3 mt-2 rounded bg-amber-900/40 px-3 py-2 text-sm text-amber-200 sm:mx-6">{aiWarning}</div>
      )}

      <main className="flex flex-1 gap-4 overflow-hidden px-3 py-3 sm:px-6 sm:py-4">
        {!compactSidebar && (
          <aside className="w-40 shrink-0 space-y-1.5 overflow-y-auto rounded-lg bg-slate-800 p-2">
            {aliveForces.map((f) => {
              const isCurrent = f.seat === board.currentSeat;
              const isMine = f.seat === mySeat;
              const linked = board.tiles.filter((t) => t.soldier !== null && t.soldier.owner === f.seat && t.soldier.isLinked).length;
              return (
                <div
                  key={f.seat}
                  className={`rounded border px-2 py-1.5 ${isCurrent ? 'border-amber-400 bg-slate-700' : 'border-slate-700 bg-slate-800'} ${
                    !f.alive ? 'opacity-40' : ''
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    <img
                      src={flagImgUrl(f.flag)}
                      alt=""
                      className="h-5 w-4 object-contain"
                      onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
                    />
                    <span className="flex-1 truncate text-xs font-medium text-white">
                      {f.name}
                      {isMine && <span className="ml-0.5 text-[10px] text-emerald-400">（我）</span>}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-baseline justify-between gap-1 text-[11px]">
                    <span className="truncate text-slate-300">
                      {isMine ? '你' : f.isAI ? `AI·${AI_LEVEL_LABEL[f.computer] ?? '休闲'}` : '—'}
                    </span>
                    <span className="shrink-0 text-[10px] text-slate-500">队伍 {f.team}</span>
                    {f.alive ? (
                      <span className="shrink-0 text-slate-400">
                        点数 <span className="text-slate-300">{f.points}</span>
                        <span className="text-pink-400"> (+{linked})</span>
                      </span>
                    ) : (
                      <span className="shrink-0 text-red-400">已清除</span>
                    )}
                  </div>
                </div>
              );
            })}
          </aside>
        )}

        <section className="relative min-w-0 flex-1 rounded-lg bg-slate-800/50">
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

          {/* 窄屏右上角：地图缩放按钮 */}
          <div className="absolute right-2 top-2 z-20 flex flex-col gap-1 lg:hidden">
            <button
              onClick={() => boardRef.current?.zoomBy(1.25)}
              className="flex h-9 w-9 select-none items-center justify-center rounded bg-slate-800/80 text-xl leading-none text-white shadow hover:bg-slate-700 active:bg-slate-600"
              title="放大地图"
              aria-label="放大地图"
            >
              +
            </button>
            <button
              onClick={() => boardRef.current?.zoomBy(0.8)}
              className="flex h-9 w-9 select-none items-center justify-center rounded bg-slate-800/80 text-xl leading-none text-white shadow hover:bg-slate-700 active:bg-slate-600"
              title="缩小地图"
              aria-label="缩小地图"
            >
              −
            </button>
          </div>

          {/* 窄屏：左侧 1/4 宽（上限原固定宽）的完整卡片；非窄屏保留原来的悬浮简略列表 */}
          {compactSidebar &&
            (isNarrow ? (
              factionPanelOpen ? (
                <div className="absolute left-2 top-10 z-10 w-[min(25vw,10rem)] overflow-hidden bg-slate-800 shadow-lg">
                  <div>
                    {aliveForces.map((f) => {
                      const isCurrent = f.seat === board.currentSeat;
                      const isMine = f.seat === mySeat;
                      const linked = board.tiles.filter(
                        (t) => t.soldier !== null && t.soldier.owner === f.seat && t.soldier.isLinked,
                      ).length;
                      return (
                        <div
                          key={f.seat}
                          className={`flex h-5 items-center gap-1.5 px-2 ${isCurrent ? 'bg-slate-700' : ''} ${!f.alive ? 'opacity-40' : ''}`}
                        >
                          <img
                            src={flagImgUrl(f.flag)}
                            alt=""
                            className="h-5 w-4 shrink-0 object-contain"
                            onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
                          />
                          {/* 右上：势力名优先完整显示 +（我）；右下：加点 + 下回合加点 + 队伍数字；两行上下等距居中、左右靠左 */}
                          <div className="flex h-5 min-w-0 flex-1 flex-col items-start justify-evenly">
                            <div className="flex max-w-full min-w-0 items-baseline gap-0.5">
                              <span
                                className={`shrink-0 whitespace-nowrap text-[7px] leading-none text-white ${isCurrent ? 'font-bold' : 'font-medium'}`}
                              >
                                {f.name}
                              </span>
                              {isMine && <span className="shrink-0 text-[6px] leading-none text-emerald-400">（我）</span>}
                            </div>
                            <div className="flex max-w-full items-baseline gap-1 text-[7px] leading-none">
                              {f.alive ? (
                                <>
                                  <span className="text-white">加点 {f.points}</span>
                                  <span className="shrink-0 text-pink-400">+{linked}</span>
                                  <span className="min-w-0 truncate text-[6px] text-slate-400">{f.team}</span>
                                </>
                              ) : (
                                <span className="text-slate-400">已清除</span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <button
                    onClick={() => setFactionPanelOpen(false)}
                    className="flex w-full items-center justify-center gap-1 py-1 text-[7px] leading-none text-slate-300 hover:bg-slate-700"
                    title="收起势力信息"
                    aria-label="收起势力信息"
                  >
                    收起《
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setFactionPanelOpen(true)}
                  className="absolute left-2 top-10 z-10 rounded bg-slate-800/80 px-1.5 py-1 text-sm leading-none text-white shadow hover:bg-slate-700"
                  title="展开势力信息"
                  aria-label="展开势力信息"
                >
                  》
                </button>
              )
            ) : (
              <div className="pointer-events-none absolute left-2 top-10 z-10 space-y-1.5">
                {aliveForces.map((f) => {
                  const isCurrent = f.seat === board.currentSeat;
                  const isMine = f.seat === mySeat;
                  const linked = board.tiles.filter((t) => t.soldier !== null && t.soldier.owner === f.seat && t.soldier.isLinked).length;
                  return (
                    <div key={f.seat} className={`flex items-center gap-1.5 rounded bg-slate-900/70 px-1.5 py-1 ${!f.alive ? 'opacity-40' : ''}`}>
                      <img
                        src={flagImgUrl(f.flag)}
                        alt=""
                        className="h-5 w-4 object-contain"
                        onError={(e) => ((e.target as HTMLImageElement).style.visibility = 'hidden')}
                      />
                      <div className="flex w-44 flex-col justify-center">
                        <div className="flex items-baseline gap-1">
                          <span
                            className={`min-w-0 truncate text-xs leading-none text-white ${isCurrent ? 'font-bold' : 'font-medium'}`}
                          >
                            {f.name}
                          </span>
                          {isMine && <span className="shrink-0 text-[10px] leading-none text-emerald-400">（我）</span>}
                          <span className="shrink-0 text-[10px] leading-none text-slate-400">队伍 {f.team}</span>
                          {f.alive ? (
                            <>
                              <span className="shrink-0 text-xs leading-none text-white">{f.points}</span>
                              <span className="shrink-0 text-[10px] leading-none text-pink-400">(+{linked})</span>
                            </>
                          ) : (
                            <span className="shrink-0 text-[10px] leading-none text-slate-400">已清除</span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}

          <BoardCanvas
            ref={boardRef}
            minInitialTileWidth={INITIAL_TILE_WIDTH_PX}
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
              if (useGame.getState().board?.phase === 'ADD_POINT') startAddPoint(tile);
              else handleTileClick(tile);
            }}
            onTilePointerUp={stopAddPoint}
            animatorRef={animatorRef}
            className="h-full w-full"
            overlay={({ tileScreenPosition, viewport }) => (
              <TriggerTileBubbles
                texts={tileTexts}
                positionOf={tileScreenPosition}
                viewport={viewport}
                onDismiss={dismissTriggerText}
              />
            )}
          />

          {/* 桌面：悔棋（灰）+ 结束行动/加点（靛蓝）同一行 */}
          {isMyActionTurn && (
            <div className="absolute bottom-14 left-1/2 z-10 hidden -translate-x-1/2 items-center gap-2 lg:flex">
              <button
                onClick={handleUndo}
                disabled={!undoAvailable || submitting || gameOver !== null}
                title="回退上一步（仅本回合你的操作）"
                className="rounded bg-slate-600 px-4 py-2 font-medium text-white shadow-lg hover:bg-slate-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
              >
                悔棋
              </button>
              <button
                onClick={handleSwitchPhase}
                className="rounded bg-indigo-600 px-4 py-2 font-medium text-white shadow-lg hover:bg-indigo-500"
              >
                {phase === 'ACTION' ? '结束行动' : '结束加点'}
              </button>
            </div>
          )}

          {/* 移动端：同一行，右下角 */}
          {isMyActionTurn && (
            <div className="absolute bottom-12 right-3 z-10 flex items-center gap-2 lg:hidden">
              <button
                onClick={handleUndo}
                disabled={!undoAvailable || submitting || gameOver !== null}
                title="回退上一步（仅本回合你的操作）"
                className="rounded bg-slate-600 px-4 py-2 font-medium text-white shadow-lg hover:bg-slate-500 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
              >
                悔棋
              </button>
              <button
                onClick={handleSwitchPhase}
                className="rounded bg-indigo-600 px-4 py-2 font-medium text-white shadow-lg hover:bg-indigo-500"
              >
                {phase === 'ACTION' ? '结束行动' : '结束加点'}
              </button>
            </div>
          )}

          {/* 底部提示条 + 演出控制 */}
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-slate-900/80 px-4 py-2 text-xs text-slate-300">
            <span>
              {animating
                ? '演出中…'
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
                  <button onClick={togglePause} className="rounded bg-slate-700 px-2 py-0.5 text-amber-300 hover:bg-slate-600">
                    {animPaused ? '继续' : '暂停'}
                  </button>
                  <button onClick={stepEvent} className="rounded bg-slate-700 px-2 py-0.5 text-amber-300 hover:bg-slate-600">
                    单步
                  </button>
                </>
              )}
            </span>
          </div>
        </section>
      </main>

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

      {killFloats.length > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[30%] z-40 flex flex-col items-center gap-2">
          {killFloats.map((k) => (
            <div
              key={k.id}
              className="float-up-kill rounded px-3 py-1 text-2xl font-bold text-white"
              style={{ textShadow: '0 0 3px #000, 1px 1px 2px #000, -1px 1px 2px #000, 0 2px 3px #000' }}
            >
              {k.text}
            </div>
          ))}
        </div>
      )}

      {gameOver && (
        <PveResultModal
          gameOver={gameOver as GameOverMsg}
          board={board}
          humanUserId={configRef.current?.humanUserId ?? user?.id ?? 0}
          onNewGame={handleNewGame}
          onBackRoom={() => clearLoadAndNavigate('/pve')}
          onBackModes={() => clearLoadAndNavigate('/modes')}
        />
      )}

      {fatal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-xl bg-slate-800 p-6 text-center shadow-2xl">
            <h2 className="text-xl font-bold text-red-400">对局异常</h2>
            <p className="mt-3 text-sm text-slate-300">{fatal.message}</p>
            <button
              onClick={() => clearLoadAndNavigate('/pve')}
              className="mt-5 rounded bg-slate-600 px-5 py-2 text-sm font-medium text-white hover:bg-slate-500"
            >
              返回房间
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
