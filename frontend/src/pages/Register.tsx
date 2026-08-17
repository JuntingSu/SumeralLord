import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { register } from '../api/auth';
import { ApiError } from '../api/client';

function randomUsername(): string {
  return `玩家${Math.floor(100000 + Math.random() * 900000)}`;
}

export default function Register() {
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }
    setBusy(true);
    try {
      const name = username.trim();
      await register(name, password);
      // 注册成功不自动登录，跳转登录页并预填用户名
      navigate('/login', { state: { username: name } });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误，请稍后再试');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-900 px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-lg bg-slate-800 p-8 shadow-lg">
        <h1 className="mb-6 text-center text-2xl font-bold text-white">数字领主 · 注册</h1>
        {error && (
          <div className="mb-4 rounded bg-red-900/50 px-3 py-2 text-sm text-red-200" role="alert">
            {error}
          </div>
        )}
        <label className="mb-1 block text-sm text-slate-300" htmlFor="username">
          用户名（3-20 字符）
        </label>
        <div className="mb-1 flex gap-2">
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            minLength={3}
            maxLength={20}
            className="w-full rounded bg-slate-700 px-3 py-2 text-white outline-none focus:ring-2 focus:ring-emerald-500"
          />
          <button
            type="button"
            onClick={() => setUsername(randomUsername())}
            className="whitespace-nowrap rounded bg-slate-600 px-3 py-2 text-sm text-slate-200 hover:bg-slate-500"
          >
            随机用户名
          </button>
        </div>
        <label className="mb-1 mt-2 block text-sm text-slate-300" htmlFor="password">
          密码（6-32 字符）
        </label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={6}
          maxLength={32}
          autoComplete="new-password"
          className="mb-2 w-full rounded bg-slate-700 px-3 py-2 text-white outline-none focus:ring-2 focus:ring-emerald-500"
        />
        <label className="mb-1 block text-sm text-slate-300" htmlFor="confirm">
          确认密码
        </label>
        <input
          id="confirm"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          minLength={6}
          maxLength={32}
          autoComplete="new-password"
          className="w-full rounded bg-slate-700 px-3 py-2 text-white outline-none focus:ring-2 focus:ring-emerald-500"
        />
        <button
          type="submit"
          disabled={busy}
          className="mt-6 w-full rounded bg-emerald-600 py-2 font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {busy ? '注册中…' : '注册'}
        </button>
        <p className="mt-4 text-center text-sm text-slate-400">
          已有账号？
          <Link to="/login" className="text-emerald-400 hover:underline">
            登录
          </Link>
        </p>
      </form>
    </div>
  );
}
