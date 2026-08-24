// 我的战绩（BM7b）：顶部个人统计（对局数/积分）+ 对局记录列表（胜负/每局积分变动/回放入口）
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MatchRecord, UserPublic } from '@dl/shared';
import { fetchHistory, fetchMe } from '../api/users';
import { useAuth } from '../stores/auth';

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function History() {
  const me = useAuth((s) => s.user);
  const [meStats, setMeStats] = useState<UserPublic | null>(null);
  const [history, setHistory] = useState<MatchRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!me) return;
    let cancelled = false;
    fetchMe()
      .then((r) => {
        if (!cancelled) setMeStats(r.user);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    fetchHistory(me.id)
      .then((r) => {
        if (!cancelled) setHistory(r.history);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [me]);

  const winCount = history?.filter((h) => !h.aborted && h.winners.includes(String(me?.id))).length ?? 0;

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="flex items-center justify-between border-b border-slate-700 px-6 py-3">
        <h1 className="text-lg font-bold">我的战绩</h1>
        <Link to="/lobby" className="rounded bg-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-600">
          ← 返回大厅
        </Link>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-6">
        {error && <p className="mb-4 text-sm text-red-400">{error}</p>}
        {meStats && history !== null && (
          <p className="mb-4 text-sm text-slate-400">
            对局数 {meStats.matches} · 当前积分 {meStats.score.toFixed(1)} · 胜利 {winCount} 局
          </p>
        )}
        {history === null ? (
          <p className="text-sm text-slate-400">加载中…</p>
        ) : history.length === 0 ? (
          <p className="text-sm text-slate-400">还没有对局记录，去大厅打一局吧</p>
        ) : (
          <ul className="space-y-2">
            {history.map((h) => {
              const iWin = !h.aborted && h.winners.includes(String(me?.id));
              const myChange = !h.aborted ? h.scoreChanges.find((c) => c.playerId === me?.id) : undefined;
              const opponents = h.participants.filter((p) => p.playerId !== null && p.playerId !== me?.id);
              return (
                <li key={h.gameId} className="flex items-center justify-between rounded-lg border border-slate-700 bg-slate-800 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm">
                      <span
                        className={`mr-2 rounded px-2 py-0.5 text-xs font-medium ${
                          h.aborted ? 'bg-slate-600 text-slate-300' : iWin ? 'bg-emerald-700 text-emerald-100' : 'bg-red-800 text-red-100'
                        }`}
                      >
                        {h.aborted ? '中止' : iWin ? '胜利' : '失败'}
                      </span>
                      <span className={`mr-2 text-sm font-semibold ${myChange ? (myChange.delta >= 0 ? 'text-emerald-400' : 'text-red-400') : 'text-slate-500'}`}>
                        {myChange ? `${myChange.delta > 0 ? '+' : ''}${myChange.delta.toFixed(1)}` : '—'}
                      </span>
                      <span className="text-slate-300">
                        对手：{opponents.length > 0 ? opponents.map((o) => `#${o.playerId}`).join('、') : '—'}
                      </span>
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {formatTime(h.finishedAt)} · 房间 {h.roomId}
                      {h.winningTeam > 0 && !h.aborted && <span> · 队伍 {h.winningTeam}</span>}
                    </p>
                  </div>
                  <Link
                    to={`/replay/${h.gameId}`}
                    className="shrink-0 rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500"
                  >
                    查看回放
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
