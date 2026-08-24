// 排行榜：积分榜 / 对局数榜（Top100 + 当前账号排名）
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { LeaderboardResult } from '@dl/shared';
import { fetchLeaderboard } from '../api/leaderboard';
import { useAuth } from '../stores/auth';

type BoardType = 'score' | 'matches';

export default function Leaderboard() {
  const me = useAuth((s) => s.user);
  const [type, setType] = useState<BoardType>('score');
  const [data, setData] = useState<LeaderboardResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetchLeaderboard(type)
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [type]);

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="flex items-center justify-between border-b border-slate-700 px-6 py-3">
        <h1 className="text-lg font-bold">排行榜</h1>
        <Link to="/lobby" className="rounded bg-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-600">
          ← 返回大厅
        </Link>
      </header>
      <main className="mx-auto max-w-4xl px-6 py-6">
        <div className="mb-4 flex gap-2">
          {(['score', 'matches'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setType(t)}
              className={`rounded px-4 py-1.5 text-sm font-medium ${
                type === t ? 'bg-emerald-600 text-white' : 'bg-slate-700 text-slate-200 hover:bg-slate-600'
              }`}
            >
              {t === 'score' ? '积分榜' : '对局数榜'}
            </button>
          ))}
        </div>
        {error && <p className="mb-4 text-sm text-red-400">{error}</p>}
        {data?.me && <p className="mb-4 text-sm text-slate-400">我的排名：第 {data.me.rank} 名</p>}
        {data === null && !error ? (
          <p className="text-sm text-slate-400">加载中…</p>
        ) : data && data.list.length === 0 ? (
          <p className="text-sm text-slate-400">暂无排名数据</p>
        ) : data ? (
          <div className="overflow-hidden rounded-lg border border-slate-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-800 text-left text-xs text-slate-400">
                  <th className="px-4 py-2 font-medium">名次</th>
                  <th className="px-4 py-2 font-medium">玩家</th>
                  <th className="px-4 py-2 text-right font-medium">积分</th>
                  <th className="px-4 py-2 text-right font-medium">对局数</th>
                </tr>
              </thead>
              <tbody>
                {data.list.map((entry) => {
                  const isMe = entry.id === me?.id;
                  return (
                    <tr key={entry.id} className={isMe ? 'bg-slate-700' : 'bg-slate-800'}>
                      <td className="px-4 py-2 text-slate-300">{entry.rank}</td>
                      <td className="px-4 py-2">
                        <span className="flex items-center gap-2">
                          <img
                            src={`/static/flags/flag_${entry.flag}.png`}
                            alt="旗帜"
                            className="h-5 w-5 object-contain"
                            onError={(e) => {
                              (e.target as HTMLImageElement).style.visibility = 'hidden';
                            }}
                          />
                          <span className={isMe ? 'text-white' : 'text-slate-200'}>
                            {entry.username}
                            {isMe && <span className="ml-2 text-xs text-emerald-400">（我）</span>}
                          </span>
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right text-slate-200">{entry.score.toFixed(1)}</td>
                      <td className="px-4 py-2 text-right text-slate-200">{entry.matches}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </main>
    </div>
  );
}
