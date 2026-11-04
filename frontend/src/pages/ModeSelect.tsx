import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../stores/auth';
import { avatarUrl } from '../lib/flags';

const CARD = 'group flex h-40 flex-col justify-between rounded-2xl border border-slate-700 bg-slate-800 p-5 text-left transition-colors';

export default function ModeSelect() {
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-6 pb-2 pt-8">
        <div className="flex items-center gap-3">
          {user && (
            <img
              src={avatarUrl(user.id, user.flag, user.hasSkin)}
              alt=""
              className="h-10 w-9 object-contain"
              onError={(e) => {
                (e.target as HTMLImageElement).style.visibility = 'hidden';
              }}
            />
          )}
          <div>
            <h1 className="text-xl font-semibold">数字领主</h1>
            {user && <p className="text-sm text-slate-400">{user.username}</p>}
          </div>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="rounded-lg bg-slate-800 px-4 py-2 text-sm text-slate-300 hover:bg-slate-700"
        >
          退出登录
        </button>
      </header>

      <main className="mx-auto w-full max-w-5xl px-6 py-10">
        <h2 className="mb-5 text-sm font-medium text-slate-400">选择模式</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Link to="/lobby" className={`${CARD} hover:border-emerald-500 hover:bg-slate-700`}>
            <span className="text-3xl" aria-hidden="true">⚔️</span>
            <span>
              <span className="block text-lg font-semibold">多人对局</span>
              <span className="mt-1 block text-sm text-slate-400">创建/加入房间，与其他玩家实时对战</span>
            </span>
          </Link>

          <Link to="/pve" className={`${CARD} hover:border-emerald-500 hover:bg-slate-700`}>
            <span className="text-3xl" aria-hidden="true">🤖</span>
            <span>
              <span className="block text-lg font-semibold">单人 PVE</span>
              <span className="mt-1 block text-sm text-slate-400">挑选地图与 AI 难度，本地进行对局</span>
            </span>
          </Link>

          <div
            className={`${CARD} cursor-not-allowed border-slate-700/60 bg-slate-800/40 opacity-60`}
            aria-disabled="true"
            title="战役模式制作中"
          >
            <span className="text-3xl grayscale" aria-hidden="true">🗺️</span>
            <span>
              <span className="block text-lg font-semibold text-slate-400">战役模式</span>
              <span className="mt-1 block text-sm text-slate-500">全新模式制作中，敬请期待</span>
            </span>
          </div>

          <a href="/mapeditor/?embed=1" className={`${CARD} hover:border-emerald-500 hover:bg-slate-700`}>
            <span className="text-3xl" aria-hidden="true">🧱</span>
            <span>
              <span className="block text-lg font-semibold">地图编辑器</span>
              <span className="mt-1 block text-sm text-slate-400">编辑地图，可直接带入 PVE 游玩</span>
            </span>
          </a>
        </div>
      </main>
    </div>
  );
}
