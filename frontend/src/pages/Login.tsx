import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { login } from '../api/auth';
import { ApiError } from '../api/client';
import { useAuth } from '../stores/auth';

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const setAuth = useAuth((s) => s.setAuth);
  const [username, setUsername] = useState(
    (location.state as { username?: string } | null)?.username ?? '',
  );
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await login(username.trim(), password);
      setAuth(result.token, result.user);
      navigate('/lobby', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误，请稍后再试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-lg bg-slate-800 p-8 shadow-lg">
        <h1 className="mb-6 text-center text-2xl font-bold text-white">数字领主 · 登录</h1>
        {error && (
          <div className="mb-4 rounded bg-red-900/50 px-3 py-2 text-sm text-red-200" role="alert">
            {error}
          </div>
        )}
        <label className="mb-1 block text-sm text-slate-300" htmlFor="username">
          用户名
        </label>
        <input
          id="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
          minLength={3}
          maxLength={20}
          autoComplete="username"
          className="mb-4 w-full rounded bg-slate-700 px-3 py-2 text-white outline-none focus:ring-2 focus:ring-emerald-500"
        />
        <label className="mb-1 block text-sm text-slate-300" htmlFor="password">
          密码
        </label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={6}
          maxLength={32}
          autoComplete="current-password"
          className="mb-2 w-full rounded bg-slate-700 px-3 py-2 text-white outline-none focus:ring-2 focus:ring-emerald-500"
        />
        <button
          type="submit"
          disabled={busy}
          className="mt-4 w-full rounded bg-emerald-600 py-2 font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? '登录中…' : '登录'}
        </button>
        <p className="mt-4 text-center text-sm text-slate-400">
          还没有账号？
          <Link to="/register" className="text-emerald-400 hover:underline">
            注册
          </Link>
        </p>
      </form>
    </div>
  );
}
