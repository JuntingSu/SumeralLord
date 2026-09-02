// 个人中心：我的战绩 / 个人信息 / 个性皮肤 三个入口 + 个人摘要
import { Link } from 'react-router-dom';
import { useAuth } from '../stores/auth';
import { avatarUrl } from '../lib/flags';

export default function Profile() {
  const user = useAuth((s) => s.user);

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="flex items-center justify-between border-b border-slate-700 px-6 py-3">
        <h1 className="text-lg font-bold">个人中心</h1>
        <Link to="/lobby" className="rounded bg-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-600">
          ← 返回大厅
        </Link>
      </header>
      <main className="mx-auto max-w-2xl px-6 py-8">
        {user && (
          <div className="mb-8 flex items-center gap-4 rounded-lg bg-slate-800 p-6">
            <img
              src={avatarUrl(user.id, user.flag, user.hasSkin)}
              alt=""
              className="h-16 w-14 object-contain"
              onError={(e) => {
                (e.target as HTMLImageElement).style.visibility = 'hidden';
              }}
            />
            <div>
              <p className="text-lg font-semibold">{user.username}</p>
              <p className="mt-1 text-sm text-slate-400">
                对局 {user.matches} · 胜场 {user.wins} · 积分 {user.score.toFixed(1)}
              </p>
            </div>
          </div>
        )}

        <div className="grid gap-3">
          <Link
            to="/history"
            className="flex items-center justify-between rounded-lg bg-slate-800 px-5 py-4 hover:bg-slate-700"
          >
            <span className="text-sm font-medium">📊 我的战绩</span>
            <span className="text-slate-500">›</span>
          </Link>
          <Link
            to="/profile/settings"
            className="flex items-center justify-between rounded-lg bg-slate-800 px-5 py-4 hover:bg-slate-700"
          >
            <span className="text-sm font-medium">⚙ 个人信息</span>
            <span className="text-slate-500">›</span>
          </Link>
          <Link
            to="/profile/skin"
            className="flex items-center justify-between rounded-lg bg-slate-800 px-5 py-4 hover:bg-slate-700"
          >
            <span className="text-sm font-medium">🎨 个性皮肤</span>
            <span className="text-slate-500">›</span>
          </Link>
        </div>
      </main>
    </div>
  );
}
