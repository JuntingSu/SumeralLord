// 个人信息：修改用户名 / 密码（改密码需先输入正确的原密码）
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { updateProfile } from '../api/users';
import { ApiError } from '../api/client';
import { useAuth } from '../stores/auth';

const inputCls = 'w-full rounded bg-slate-700 px-3 py-2 text-white outline-none focus:ring-2 focus:ring-emerald-500';
const labelCls = 'mb-1 block text-sm text-slate-300';

export default function ProfileSettings() {
  const user = useAuth((s) => s.user);
  const updateUser = useAuth((s) => s.updateUser);

  const [username, setUsername] = useState(user?.username ?? '');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleUsername = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    const next = username.trim();
    if (!user || next === user.username) return;
    setBusy(true);
    try {
      const r = await updateProfile({ username: next });
      updateUser(r.user, r.token);
      setSuccess('用户名已更新');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误，请稍后再试');
    } finally {
      setBusy(false);
    }
  };

  const handlePassword = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致');
      return;
    }
    setBusy(true);
    try {
      const r = await updateProfile({ oldPassword, newPassword });
      updateUser(r.user);
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setSuccess('密码已更新');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误，请稍后再试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="flex items-center justify-between border-b border-slate-700 px-6 py-3">
        <h1 className="text-lg font-bold">个人信息</h1>
        <Link to="/profile" className="rounded bg-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-600">
          ← 返回个人中心
        </Link>
      </header>
      <main className="mx-auto max-w-lg px-6 py-8">
        {error && (
          <div className="mb-4 rounded bg-red-900/50 px-3 py-2 text-sm text-red-200" role="alert">
            {error}
          </div>
        )}
        {success && (
          <div className="mb-4 rounded bg-emerald-900/50 px-3 py-2 text-sm text-emerald-200" role="status">
            {success}
          </div>
        )}

        <form onSubmit={handleUsername} className="mb-6 rounded-lg bg-slate-800 p-6">
          <h2 className="mb-4 text-sm font-bold text-slate-300">修改用户名</h2>
          <label className={labelCls} htmlFor="profile-username">
            用户名（3-20 字符，不能含空白）
          </label>
          <input
            id="profile-username"
            className={inputCls}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            minLength={3}
            maxLength={20}
            required
          />
          <button
            type="submit"
            disabled={busy || !user || username.trim() === user.username}
            className="mt-4 w-full rounded bg-emerald-600 py-2 font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            保存用户名
          </button>
        </form>

        <form onSubmit={handlePassword} className="rounded-lg bg-slate-800 p-6">
          <h2 className="mb-4 text-sm font-bold text-slate-300">修改密码</h2>
          <label className={labelCls} htmlFor="profile-old-password">
            原密码
          </label>
          <input
            id="profile-old-password"
            className={inputCls}
            type="password"
            value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)}
            required
            autoComplete="current-password"
          />
          <label className={`${labelCls} mt-3`} htmlFor="profile-new-password">
            新密码（6-32 字符）
          </label>
          <input
            id="profile-new-password"
            className={inputCls}
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            minLength={6}
            maxLength={32}
            required
            autoComplete="new-password"
          />
          <label className={`${labelCls} mt-3`} htmlFor="profile-confirm-password">
            确认新密码
          </label>
          <input
            id="profile-confirm-password"
            className={inputCls}
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            minLength={6}
            maxLength={32}
            required
            autoComplete="new-password"
          />
          <button
            type="submit"
            disabled={busy}
            className="mt-4 w-full rounded bg-emerald-600 py-2 font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            保存密码
          </button>
        </form>
      </main>
    </div>
  );
}
