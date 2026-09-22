// src/Workbench.tsx — 判题工作台（决策定稿 §9 修订版 §四）
// 上传抽样器产物 pairs JSON → 逐题展示：局面题 = A/B 双棋盘并排；走法题 = 动作摘要 + 双后继棋盘并排。
// 四选项：a 好 / b 好 / 都不好 / 不能判断（unknown 不入训练）+ 跳过；判定后 POST /api/pref 落盘 v2/prefs/。
import { useEffect, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { GameState } from '@dl/shared';
import { applyIntent } from '@dl/shared';
import { intentToText, type PairsFile, type PrefFile, type Question } from '../../lib/annotation-types';
import { parseLogText, replayLog, type ParsedLogData } from '../../lib/logparse';
import BoardCanvas from './components/BoardCanvas';

interface WorkbenchProps {
  onExit: () => void;
}

interface Loaded {
  q: Question;
  boardA: GameState;
  boardB: GameState;
  seatA: number;
  seatB: number;
}

const logCache = new Map<string, ParsedLogData>();

async function fetchLog(gameId: string): Promise<ParsedLogData> {
  const cached = logCache.get(gameId);
  if (cached) return cached;
  const res = await fetch(`/api/log/${encodeURIComponent(gameId)}`);
  if (!res.ok) throw new Error(`日志缺失：${gameId}`);
  const parsed = parseLogText(await res.text());
  if (!parsed) throw new Error(`日志格式错误：${gameId}`);
  logCache.set(gameId, parsed);
  return parsed;
}

async function loadQuestion(q: Question): Promise<Loaded> {
  if (q.kind === 'position') {
    const [la, lb] = [await fetchLog(q.a.sourceGameId), await fetchLog(q.b.sourceGameId)];
    return {
      q,
      boardA: replayLog(la.start, la.intents, q.a.eventId),
      boardB: replayLog(lb.start, lb.intents, q.b.eventId),
      seatA: q.a.seat,
      seatB: q.b.seat,
    };
  }
  const log = await fetchLog(q.sourceGameId);
  const base = replayLog(log.start, log.intents, q.eventId);
  const ra = applyIntent(base, { actor: { kind: 'PLAYER', seat: q.seat }, intent: q.actionA });
  const rb = applyIntent(base, { actor: { kind: 'PLAYER', seat: q.seat }, intent: q.actionB });
  if (!ra.ok || !rb.ok) throw new Error('候选动作应用失败');
  return { q, boardA: ra.state, boardB: rb.state, seatA: q.seat, seatB: q.seat };
}

export default function Workbench({ onExit }: WorkbenchProps) {
  const [pairs, setPairs] = useState<PairsFile | null>(null);
  const [idx, setIdx] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');

  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    void (async () => {
      try {
        const parsed = JSON.parse(await f.text()) as PairsFile;
        if (!Array.isArray(parsed.questions)) throw new Error('缺少 questions 数组');
        setPairs(parsed);
        setIdx(0);
        setErr('');
      } catch (e2) {
        setErr(`题目文件解析失败：${e2 instanceof Error ? e2.message : String(e2)}`);
      }
    })();
    e.target.value = '';
  };

  useEffect(() => {
    if (!pairs || idx >= pairs.questions.length) {
      setLoaded(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    void (async () => {
      try {
        const l = await loadQuestion(pairs.questions[idx]);
        if (!cancelled) setLoaded(l);
      } catch (e) {
        if (!cancelled) {
          setErr(`题目加载失败（第 ${idx + 1} 题）：${e instanceof Error ? e.message : String(e)}`);
          setLoaded(null);
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pairs, idx]);

  const submit = async (label: PrefFile['label']) => {
    if (!pairs || !loaded || saving) return;
    const q = loaded.q;
    const pref: PrefFile =
      q.kind === 'position'
        ? { id: `pref-${Date.now()}`, kind: 'position', a: q.a, b: q.b, label, note: note || undefined }
        : {
            id: `pref-${Date.now()}`,
            kind: 'action',
            sourceGameId: q.sourceGameId,
            eventId: q.eventId,
            seat: q.seat,
            actionA: q.actionA,
            actionB: q.actionB,
            label,
            note: note || undefined,
          };
    setSaving(true);
    try {
      const res = await fetch('/api/pref', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pref),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) throw new Error(data.error ?? '保存失败');
      setNote('');
      setErr('');
      setIdx((i) => i + 1);
    } catch (e) {
      setErr(`保存失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const skip = () => setIdx((i) => i + 1);

  // 未加载题目文件：上传入口
  if (!pairs) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-slate-900 p-8 text-white">
        <h1 className="text-2xl font-bold text-amber-300">判题工作台</h1>
        <p className="max-w-md text-center text-sm text-slate-400">
          上传抽样器生成的题目文件（<span className="text-slate-300">v2/prefs/pairs-*.json</span>）即可逐题判定。
          判定结果保存到 <span className="text-slate-300">v2/prefs/</span>，拟合时并入训练。
        </p>
        <label className="cursor-pointer rounded-lg border-2 border-dashed border-slate-600 bg-slate-800/60 px-10 py-8 text-center transition-colors hover:border-slate-400">
          <input type="file" accept=".json" onChange={handleFile} className="hidden" />
          <span className="block text-lg">点击选择 pairs JSON 文件</span>
        </label>
        {err && <p className="max-w-md text-center text-sm text-red-400">{err}</p>}
        <button onClick={onExit} className="rounded bg-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-600">
          返回回放器
        </button>
      </div>
    );
  }

  // 全部判完
  if (idx >= pairs.questions.length) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-slate-900 p-8 text-white">
        <h1 className="text-2xl font-bold text-emerald-400">全部判完 🎉</h1>
        <p className="text-sm text-slate-400">共 {pairs.questions.length} 题。判定已落盘 v2/prefs/，下次拟合自动纳入训练。</p>
        <button onClick={onExit} className="rounded bg-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-600">
          返回回放器
        </button>
      </div>
    );
  }

  const q = pairs.questions[idx];
  const noop = () => undefined;
  return (
    <div className="flex min-h-screen flex-col bg-slate-900 text-white">
      <header className="flex items-center justify-between border-b border-slate-700 px-6 py-2.5">
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-amber-300">判题工作台</span>
          <span className="text-sm text-slate-400">
            第 {idx + 1} / {pairs.questions.length} 题 · {q.kind === 'position' ? '局面题：哪边对你（视角座次）更有利？' : '走法题：哪个走法更好？'}
          </span>
        </div>
        <button onClick={onExit} className="rounded bg-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-600">
          退出工作台
        </button>
      </header>

      <main className="flex flex-1 flex-col gap-3 px-6 py-4">
        {busy && <p className="text-sm text-slate-400">加载题目…</p>}
        {err && <p className="text-sm text-red-400">{err}</p>}
        {loaded && !busy && (
          <>
            <div className="flex gap-3">
              {(
                [
                  ['A', loaded.boardA, loaded.seatA, q.kind === 'action' ? intentToText(q.actionA, loaded.boardA) : null],
                  ['B', loaded.boardB, loaded.seatB, q.kind === 'action' ? intentToText(q.actionB, loaded.boardB) : null],
                ] as const
              ).map(([tag, board, seat, actionText]) => (
                <div key={tag} className="flex w-1/2 flex-col rounded border border-slate-700 bg-slate-800/50 p-2">
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="rounded bg-slate-700 px-2 py-0.5 font-medium text-amber-300">{tag}</span>
                    {actionText && <span className="text-slate-300">{actionText}</span>}
                  </div>
                  <div className="h-[58vh]">
                    <BoardCanvas
                      board={board}
                      mySeat={seat}
                      isSpectator={false}
                      fogEnabled={false}
                      fogLevels={null}
                      phase={board.phase}
                      selected={null}
                      onTileClick={noop}
                      onTileHover={noop}
                      animatorRef={null}
                      className="h-full w-full"
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between border-t border-slate-700 pt-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void submit('a')}
                  disabled={saving}
                  className="rounded bg-emerald-700 px-4 py-1.5 text-sm text-white hover:bg-emerald-600 disabled:opacity-60"
                >
                  A 好
                </button>
                <button
                  onClick={() => void submit('b')}
                  disabled={saving}
                  className="rounded bg-emerald-700 px-4 py-1.5 text-sm text-white hover:bg-emerald-600 disabled:opacity-60"
                >
                  B 好
                </button>
                <button
                  onClick={() => void submit('both_bad')}
                  disabled={saving}
                  className="rounded bg-rose-800 px-4 py-1.5 text-sm text-white hover:bg-rose-700 disabled:opacity-60"
                >
                  都不好
                </button>
                <button
                  onClick={() => void submit('unknown')}
                  disabled={saving}
                  title="该题作废，不入训练"
                  className="rounded bg-slate-700 px-4 py-1.5 text-sm text-slate-300 hover:bg-slate-600 disabled:opacity-60"
                >
                  不能判断
                </button>
                <button onClick={skip} disabled={saving} className="rounded bg-slate-800 px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-700">
                  跳过本题
                </button>
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="备注（可选）"
                  className="w-40 rounded bg-slate-800 px-2 py-1 text-xs text-slate-200 placeholder:text-slate-500"
                />
              </div>
              <span className="text-xs text-slate-500">视角座次：A = seat {loaded.seatA} · B = seat {loaded.seatB}</span>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
