import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { RoomListItem } from '@dl/shared';
import { useAuth } from '../stores/auth';
import { useLobby } from '../stores/lobby';
import { ApiError } from '../api/client';

export default function Lobby() {
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const logout = useAuth((s) => s.logout);

  const rooms = useLobby((s) => s.rooms);
  const joinedRoom = useLobby((s) => s.joinedRoom);
  const refreshRooms = useLobby((s) => s.refreshRooms);
  const refreshJoined = useLobby((s) => s.refreshJoined);
  const join = useLobby((s) => s.join);
  const leave = useLobby((s) => s.leave);

  const [pendingRoom, setPendingRoom] = useState<RoomListItem | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    refreshRooms().catch(() => undefined);
    refreshJoined().catch(() => undefined);
    const timer = setInterval(() => {
      refreshRooms().catch(() => undefined);
      refreshJoined().catch(() => undefined);
    }, 5000);
    return () => clearInterval(timer);
  }, [refreshRooms, refreshJoined]);

  async function handleJoin(room: RoomListItem, asSpectator: boolean, pw?: string) {
    setError(null);
    setPendingRoom(null);
    try {
      await join(room, { asSpectator, password: pw });
      navigate(`/room/${room.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误，请稍后再试');
    }
  }

  async function handleLeave() {
    setError(null);
    try {
      await leave();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误，请稍后再试');
    }
  }

  const joinedPlayers = joinedRoom
    ? joinedRoom.players.filter((p) => p.state !== 'spectating').length
    : 0;

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="flex items-center justify-between border-b border-slate-700 px-6 py-4">
        <h1 className="text-xl font-bold">数字领主 · 大厅</h1>
        {user && (
          <div className="flex items-center gap-3">
            <img
              src={`/static/flags/flag_${user.flag}.png`}
              alt="旗帜"
              className="h-8 w-7 object-contain"
              onError={(e) => {
                (e.target as HTMLImageElement).style.visibility = 'hidden';
              }}
            />
            <span className="text-slate-300">{user.username}</span>
            <button
              onClick={() => {
                // 保留 dl_room_id：重新登录后由 refreshJoined 按服务器成员身份恢复
                logout();
                navigate('/login', { replace: true });
              }}
              className="rounded bg-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-600"
            >
              退出登录
            </button>
          </div>
        )}
      </header>

      <main className="mx-auto max-w-4xl px-6 py-8">
        {joinedRoom ? (
          <div className="mb-6 flex items-center justify-between rounded-lg border border-emerald-700 bg-emerald-900/30 px-5 py-4">
            <div>
              <p className="font-medium">
                已加入房间：{joinedRoom.name}
                <span className="ml-2 rounded bg-emerald-700 px-2 py-0.5 text-xs">
                  {joinedRoom.status === 'waiting' ? '等待中' : '对局中'}
                </span>
              </p>
              <p className="mt-1 text-sm text-slate-400">
                地图 {joinedRoom.mapTitle} · 玩家 {joinedPlayers}/{joinedRoom.playerNum}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => navigate(`/room/${joinedRoom.id}`)}
                className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
              >
                进入房间
              </button>
              <button
                onClick={handleLeave}
                className="rounded bg-red-800 px-4 py-2 text-sm text-red-100 hover:bg-red-700"
              >
                离开房间
              </button>
            </div>
          </div>
        ) : (
          <div className="mb-6 flex gap-3">
            <Link
              to="/create-room"
              className="rounded bg-emerald-600 px-4 py-2 font-medium text-white hover:bg-emerald-500"
            >
              创建房间
            </Link>
            <Link
              to="/maps"
              className="rounded bg-slate-700 px-4 py-2 font-medium text-slate-200 hover:bg-slate-600"
            >
              浏览地图
            </Link>
          </div>
        )}

        {error && (
          <div className="mb-4 rounded bg-red-900/50 px-3 py-2 text-sm text-red-200" role="alert">
            {error}
          </div>
        )}

        <h2 className="mb-3 text-sm font-medium text-slate-400">房间列表（每 5 秒自动刷新）</h2>
        {rooms.length === 0 ? (
          <div className="rounded-lg bg-slate-800 p-10 text-center text-slate-500">
            暂无房间，创建一个吧
          </div>
        ) : (
          <ul className="space-y-3">
            {rooms.map((room) => (
              <li key={room.id} className="flex items-center justify-between rounded-lg bg-slate-800 px-5 py-4">
                <div>
                  <p className="font-medium">
                    {room.hasPassword && <span title="需要密码">🔒</span>} {room.name}
                    {room.status === 'in_game' && (
                      <span className="ml-2 rounded bg-indigo-700 px-2 py-0.5 text-xs">对局中</span>
                    )}
                  </p>
                  <p className="mt-1 text-sm text-slate-400">
                    玩家 {room.currentPlayers}/{room.maxPlayers}
                    {room.spectatorCount > 0 && ` · 观战 ${room.spectatorCount}`}
                    {room.allowSpectate && ' · 可观战'}
                  </p>
                </div>
                {joinedRoom ? (
                  <span className="text-sm text-slate-500">已在其他房间</span>
                ) : room.status === 'in_game' ? (
                  room.allowSpectate ? (
                    <button
                      onClick={() => handleJoin(room, true, room.hasPassword ? password : undefined)}
                      className="rounded bg-slate-600 px-4 py-1.5 text-sm text-slate-100 hover:bg-slate-500"
                    >
                      观战
                    </button>
                  ) : (
                    <span className="text-sm text-slate-500">不可观战</span>
                  )
                ) : (
                  <button
                    onClick={() => {
                      if (room.hasPassword) {
                        setPassword('');
                        setPendingRoom(room);
                      } else {
                        handleJoin(room, false);
                      }
                    }}
                    className="rounded bg-emerald-600 px-4 py-1.5 text-sm text-white hover:bg-emerald-500"
                  >
                    加入
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>

      {pendingRoom && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/60" role="dialog">
          <form
            className="w-full max-w-sm rounded-lg bg-slate-800 p-6"
            onSubmit={(e) => {
              e.preventDefault();
              handleJoin(pendingRoom, false, password);
            }}
          >
            <h3 className="mb-4 text-lg font-bold">加入「{pendingRoom.name}」</h3>
            <label className="mb-1 block text-sm text-slate-300" htmlFor="room-password">
              房间密码
            </label>
            <input
              id="room-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
              className="mb-4 w-full rounded bg-slate-700 px-3 py-2 text-white outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingRoom(null)}
                className="rounded bg-slate-600 px-4 py-2 text-sm text-slate-200 hover:bg-slate-500"
              >
                取消
              </button>
              <button type="submit" className="rounded bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-500">
                加入
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
