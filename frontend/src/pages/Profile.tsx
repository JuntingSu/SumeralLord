// 个人中心：我的战绩 / 个人信息 / 更换皮肤（随机皮肤 / 手动上传）三个入口 + 个人摘要
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../stores/auth';
import { avatarUrl } from '../lib/flags';
import { randomizeSkin } from '../api/users';
import { ApiError } from '../api/client';

export default function Profile() {
  const user = useAuth((s) => s.user);
  const updateUser = useAuth((s) => s.updateUser);
  const navigate = useNavigate();

  const [skinOpen, setSkinOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ text: string; color: string } | null>(null);
  /** 生成后头像 src 字符串若不变，React 不更新 DOM、浏览器也不会重取缓存 → 拼时间戳强制刷新 */
  const [skinBust, setSkinBust] = useState(0);

  const onRandomSkin = async () => {
    if (!user || busy) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const { color } = await randomizeSkin();
      updateUser({ ...user, hasSkin: true });
      setSkinBust(Date.now());
      setSuccess({ text: `已生成随机皮肤（${color}）`, color });
      setSkinOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误，请稍后再试');
    } finally {
      setBusy(false);
    }
  };

  const skinSrc = user ? `${avatarUrl(user.id, user.flag, user.hasSkin)}${skinBust ? `?t=${skinBust}` : ''}` : '';

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
              src={skinSrc}
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
          <div
            className="relative"
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setSkinOpen(false);
            }}
          >
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={skinOpen}
              disabled={busy}
              onClick={() => setSkinOpen((v) => !v)}
              className="flex w-full items-center justify-between rounded-lg bg-slate-800 px-5 py-4 text-left hover:bg-slate-700 disabled:opacity-60"
            >
              <span className="text-sm font-medium">🎨 更换皮肤</span>
              <span className={`text-slate-500 transition-transform ${skinOpen ? 'rotate-90' : ''}`}>›</span>
            </button>
            {skinOpen && (
              <ul role="menu" className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg bg-slate-700 py-1 shadow-lg">
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void onRandomSkin()}
                    disabled={busy}
                    className="block w-full px-5 py-3 text-left text-sm text-white hover:bg-slate-600 disabled:opacity-60"
                  >
                    🎲 随机皮肤
                  </button>
                </li>
                <li role="none">
                  <button
                    type="button"
                    role="menuitem"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setSkinOpen(false);
                      navigate('/profile/skin');
                    }}
                    className="block w-full px-5 py-3 text-left text-sm text-white hover:bg-slate-600"
                  >
                    📁 手动上传
                  </button>
                </li>
              </ul>
            )}
          </div>
        </div>

        {(busy || error || success) && (
          <div className="mt-4 text-sm">
            {busy && <p className="text-slate-400">正在生成随机皮肤…</p>}
            {error && <p className="text-red-300">⚠ {error}</p>}
            {success && (
              <p className="flex items-center gap-2 text-emerald-300">
                ✓ {success.text}
                <span
                  className="inline-block h-4 w-4 rounded border border-slate-600"
                  style={{ backgroundColor: success.color }}
                  aria-hidden="true"
                />
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
