import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { RoomListItem } from '@dl/shared';
import { useAuth } from '../stores/auth';
import { useLobby } from '../stores/lobby';
import { ApiError } from '../api/client';
import { avatarUrl } from '../lib/flags';

/** 问候语分档：4-10 早上好，10-14 中午好，14-18 下午好，18-4 晚上好 */
function greetingFor(hour: number): string {
  if (hour >= 4 && hour < 10) return '早上好';
  if (hour >= 10 && hour < 14) return '中午好';
  if (hour >= 14 && hour < 18) return '下午好';
  return '晚上好';
}

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

  const [pendingRoom, setPendingRoom] = useState<{ room: RoomListItem; asSpectator: boolean } | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** 窄屏专用：右侧个人信息侧边栏是否展开（宽屏恒显，此状态无效） */
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /** 左下角「…」更多功能浮层 */
  const [moreOpen, setMoreOpen] = useState(false);

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

  /** 加入/观战入口：带密码房间先弹输入框 */
  const askJoin = (room: RoomListItem, asSpectator: boolean) => {
    setError(null);
    if (room.hasPassword) {
      setPassword('');
      setPendingRoom({ room, asSpectator });
    } else {
      void handleJoin(room, asSpectator);
    }
  };

  const handleLogout = () => {
    // 保留 dl_room_id：重新登录后由 refreshJoined 按服务器成员身份恢复
    logout();
    navigate('/login', { replace: true });
  };

  const joinedPlayers = joinedRoom
    ? joinedRoom.players.filter((p) => p.state !== 'spectating').length
    : 0;

  const greeting = greetingFor(new Date().getHours());
  const skinSrc = user ? avatarUrl(user.id, user.flag, user.hasSkin) : '';

  return (
    <div className="flex min-h-screen bg-slate-900 text-white">
      {/* 主内容区（顶部问候 + 房间列表 + 左下角操作；宽屏时右侧让位于侧边栏） */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 px-6 pb-1 pt-5">
          {user && (
            <>
              <h1 className="text-xl font-semibold">
                {greeting}，{user.username}
              </h1>
              <img
                src={skinSrc}
                alt="我的皮肤"
                className="h-9 w-8 object-contain"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.visibility = 'hidden';
                }}
              />
            </>
          )}
        </header>

        <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-6 pb-28">
          {joinedRoom && (
            <div className="mb-6 flex items-center justify-between rounded-lg border border-emerald-700 bg-emerald-900/30 px-5 py-4">
              <div>
                <p className="font-medium">
                  已加入房间：{joinedRoom.name}
                  <span className="ml-2 rounded bg-emerald-700 px-2 py-0.5 text-xs">
                    {joinedRoom.status === 'waiting' ? '等待中' : joinedRoom.status === 'game_over' ? '已结束' : '对局中'}
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
                      {room.status === 'game_over' && (
                        <span className="ml-2 rounded bg-slate-600 px-2 py-0.5 text-xs">已结束</span>
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
                  ) : (
                    <div className="flex items-center gap-2">
                      {room.allowSpectate && (
                        <button
                          onClick={() => askJoin(room, true)}
                          className="rounded bg-slate-600 px-4 py-1.5 text-sm text-slate-100 hover:bg-slate-500"
                        >
                          观战
                        </button>
                      )}
                      {room.status === 'in_game' && !room.allowSpectate ? (
                        <span className="text-sm text-slate-500">不可观战</span>
                      ) : room.status === 'in_game' ? (
                        <button
                          disabled
                          title="对局进行中，仅可观战加入"
                          className="cursor-not-allowed rounded bg-slate-700 px-4 py-1.5 text-sm text-slate-400"
                        >
                          进入
                        </button>
                      ) : (
                        <button
                          onClick={() => askJoin(room, false)}
                          className="rounded bg-emerald-600 px-4 py-1.5 text-sm text-white hover:bg-emerald-500"
                        >
                          {room.allowSpectate ? '进入' : '加入'}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </main>

        {/* 左下角：创建房间 + 「…」更多功能 */}
        <div
          className="fixed bottom-5 left-5 z-30"
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMoreOpen(false);
          }}
        >
          {moreOpen && (
            <div
              role="dialog"
              aria-label="更多功能"
              className="absolute bottom-full left-0 mb-3 w-44 overflow-hidden rounded-xl border border-slate-700 bg-slate-800 py-1 shadow-xl"
            >
              <a
                href="/mapeditor/?embed=1"
                title="打开独立地图编辑器（服务器与当前大厅一致）"
                className="block px-4 py-2.5 text-sm text-slate-200 hover:bg-slate-700"
              >
                🗺 地图编辑器
              </a>
              <Link to="/maps" className="block px-4 py-2.5 text-sm text-slate-200 hover:bg-slate-700">
                🧭 浏览地图
              </Link>
              <Link to="/leaderboard" className="block px-4 py-2.5 text-sm text-slate-200 hover:bg-slate-700">
                🏆 排行榜
              </Link>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Link
              to="/create-room"
              className="rounded-lg bg-emerald-600 px-5 py-2.5 font-medium text-white shadow-lg hover:bg-emerald-500"
            >
              创建房间
            </Link>
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              aria-label="更多功能"
              onClick={() => setMoreOpen((v) => !v)}
              className="flex h-11 w-11 items-center justify-center rounded-lg bg-slate-700 pb-2 text-xl font-bold leading-none text-slate-200 shadow-lg hover:bg-slate-600"
            >
              …
            </button>
          </div>
        </div>
      </div>

      {/* 窄屏：展开侧边栏的按钮（宽屏隐藏） */}
      {!sidebarOpen && (
        <button
          type="button"
          aria-label="展开侧边栏"
          onClick={() => setSidebarOpen(true)}
          className="fixed right-0 top-1/2 z-30 -translate-y-1/2 rounded-l-lg border border-r-0 border-slate-700 bg-slate-800 px-1.5 py-4 text-slate-300 shadow-lg hover:bg-slate-700 lg:hidden"
        >
          《
        </button>
      )}

      {/* 窄屏：侧边栏展开时的遮罩，点击收起 */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* 右侧边栏：窄屏为抽屉（占 2/3 宽），宽屏常驻（默认 320px） */}
      <aside
        className={`fixed right-0 top-0 z-40 flex h-full w-2/3 flex-col border-l border-slate-700 bg-slate-800 transition-transform duration-300 lg:static lg:z-auto lg:h-auto lg:w-80 lg:translate-x-0 ${
          sidebarOpen ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* 上端：个人信息（照搬个人中心，仅缩放） */}
        <div className="flex items-center gap-3 border-b border-slate-700 px-4 py-4">
          {user && (
            <>
              <img
                src={skinSrc}
                alt=""
                className="h-12 w-10 shrink-0 object-contain"
                onError={(e) => {
                  (e.target as HTMLImageElement).style.visibility = 'hidden';
                }}
              />
              <div className="min-w-0">
                <p className="truncate text-base font-semibold">{user.username}</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  对局 {user.matches} · 胜场 {user.wins} · 积分 {user.score.toFixed(1)}
                </p>
              </div>
            </>
          )}
          {/* 窄屏收起按钮 */}
          <button
            type="button"
            aria-label="收起侧边栏"
            onClick={() => setSidebarOpen(false)}
            className="ml-auto shrink-0 rounded-lg px-2 py-1 text-slate-400 hover:bg-slate-700 hover:text-slate-200 lg:hidden"
          >
            》
          </button>
        </div>

        {/* 中部：个人中心 / 历史对局 */}
        <nav className="flex flex-1 flex-col gap-2 overflow-y-auto p-3">
          <Link
            to="/profile"
            className="flex items-center justify-between rounded-lg bg-slate-700/60 px-4 py-3 hover:bg-slate-700"
          >
            <span className="text-sm font-medium">👤 个人中心</span>
            <span className="text-slate-500">›</span>
          </Link>
          <Link
            to="/history"
            className="flex items-center justify-between rounded-lg bg-slate-700/60 px-4 py-3 hover:bg-slate-700"
          >
            <span className="text-sm font-medium">📊 历史对局</span>
            <span className="text-slate-500">›</span>
          </Link>
        </nav>

        {/* 下端：退出登录（红色） */}
        <div className="border-t border-slate-700 p-3">
          <button
            type="button"
            onClick={handleLogout}
            className="w-full rounded-lg bg-red-600 px-4 py-3 text-sm font-medium text-white hover:bg-red-500"
          >
            退出登录
          </button>
        </div>
      </aside>

      {pendingRoom && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/60" role="dialog">
          <form
            className="w-full max-w-sm rounded-lg bg-slate-800 p-6"
            onSubmit={(e) => {
              e.preventDefault();
              handleJoin(pendingRoom.room, pendingRoom.asSpectator, password);
            }}
          >
            <h3 className="mb-4 text-lg font-bold">
              {pendingRoom.asSpectator ? '观战加入' : '加入'}「{pendingRoom.room.name}」
            </h3>
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
