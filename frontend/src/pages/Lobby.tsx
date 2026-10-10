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

/** 房间状态文案：等待中=可加入，对局中，结算中 */
function statusLabel(status: RoomListItem['status']): string {
  return status === 'waiting' ? '可加入' : status === 'in_game' ? '对局中' : '结算中';
}

/** 房间名前状态点：绿=可进入，黄=对局中，灰=结算中 */
function statusDotClass(status: RoomListItem['status']): string {
  return status === 'waiting' ? 'bg-emerald-500' : status === 'in_game' ? 'bg-amber-400' : 'bg-slate-500';
}

/** 观战标记：眼睛 icon；禁止观战时在眼睛上叠加一条斜线 */
function SpectateIcon({ allowed }: { allowed: boolean }) {
  const label = allowed ? '允许观战' : '禁止观战';
  return (
    <span className="relative inline-flex h-5 w-5 items-center justify-center" role="img" aria-label={label} title={label}>
      <svg
        viewBox="0 0 24 24"
        className={`h-5 w-5 ${allowed ? 'text-slate-300' : 'text-slate-500'}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M2 12s3.7-6.5 10-6.5S22 12 22 12s-3.7 6.5-10 6.5S2 12 2 12Z" />
        <circle cx="12" cy="12" r="2.6" />
      </svg>
      {!allowed && (
        <svg
          viewBox="0 0 24 24"
          className="absolute inset-0 h-5 w-5 text-red-400"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          aria-hidden="true"
        >
          <line x1="4" y1="20" x2="20" y2="4" />
        </svg>
      )}
    </span>
  );
}

/** 密码标记：锁 icon（无密码时不渲染） */
function LockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-4 w-4 text-slate-300"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="需要密码"
    >
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/** 房间列表列宽（表头与数据行共用，保证对齐） */
const ROOM_GRID = 'lg:grid lg:grid-cols-[minmax(0,1fr)_56px_48px_48px_72px_152px] lg:items-center lg:gap-3';

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
            <div className="mb-6 rounded-lg border border-emerald-700 bg-emerald-900/30 px-5 py-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {joinedRoom.name}
                    <span className="ml-2 rounded bg-emerald-700 px-2 py-0.5 text-xs">
                      {joinedRoom.status === 'waiting' ? '等待中' : joinedRoom.status === 'game_over' ? '已结束' : '对局中'}
                    </span>
                  </p>
                  <p className="mt-1 truncate text-sm text-slate-400">{joinedRoom.mapTitle}</p>
                </div>
                <div className="flex flex-col gap-2 lg:flex-row">
                  <button
                    onClick={() => navigate(`/room/${joinedRoom.id}`)}
                    className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
                  >
                    返回
                  </button>
                  <button
                    onClick={handleLeave}
                    className="rounded bg-red-800 px-4 py-2 text-sm text-red-100 hover:bg-red-700"
                  >
                    离开
                  </button>
                </div>
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
            <div className="overflow-hidden rounded-lg bg-slate-800">
              {/* 表头（窄屏隐藏） */}
              <div className={`hidden border-b border-white px-5 py-2 text-xs text-slate-400 ${ROOM_GRID}`}>
                <span>房间</span>
                <span className="text-center">玩家</span>
                <span className="text-center">观战</span>
                <span className="text-center">密码</span>
                <span className="text-center">房间状态</span>
                <span className="text-center">操作</span>
              </div>

              <ul className="divide-y divide-white">
                {rooms.map((room) => {
                  const canJoin = room.status === 'waiting';
                  return (
                    <li
                      key={room.id}
                      className={`flex items-center justify-between gap-3 px-5 py-3 ${ROOM_GRID}`}
                    >
                      {/* 房间名 + 状态点；窄屏在下方补一行小字四项信息 */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={`h-2.5 w-2.5 shrink-0 rounded-full ${statusDotClass(room.status)}`}
                            aria-hidden="true"
                          />
                          <span className="truncate font-medium">{room.name}</span>
                        </div>
                        <div className="mt-1 flex items-center gap-3 text-xs text-slate-400 lg:hidden">
                          <span>
                            玩家 {room.currentPlayers}/{room.maxPlayers}
                          </span>
                          <SpectateIcon allowed={room.allowSpectate} />
                          {room.hasPassword && <LockIcon />}
                          <span>{statusLabel(room.status)}</span>
                        </div>
                      </div>

                      {/* 宽屏列：玩家 / 观战 / 密码 / 房间状态 */}
                      <span className="hidden text-center text-sm text-slate-300 lg:block">
                        {room.currentPlayers}/{room.maxPlayers}
                      </span>
                      <span className="hidden lg:flex lg:justify-center">
                        <SpectateIcon allowed={room.allowSpectate} />
                      </span>
                      <span className="hidden lg:flex lg:justify-center">
                        {room.hasPassword ? <LockIcon /> : null}
                      </span>
                      <span className="hidden text-center text-sm text-slate-300 lg:block">
                        {statusLabel(room.status)}
                      </span>

                      {/* 操作：加入 / 观战（窄屏上下排列，宽屏并排） */}
                      {joinedRoom ? (
                        <span className="shrink-0 text-center text-xs text-slate-500 lg:text-sm">
                          已在其他房间
                        </span>
                      ) : (
                        <div className="flex shrink-0 flex-col gap-2 lg:flex-row lg:justify-center">
                          <button
                            type="button"
                            disabled={!canJoin}
                            onClick={() => askJoin(room, false)}
                            className={`rounded px-3 py-1 text-xs font-medium ${
                              canJoin
                                ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                                : 'cursor-not-allowed bg-slate-700 text-slate-400'
                            }`}
                          >
                            加入
                          </button>
                          <button
                            type="button"
                            disabled={!room.allowSpectate}
                            onClick={() => askJoin(room, true)}
                            className={`rounded px-3 py-1 text-xs font-medium ${
                              room.allowSpectate
                                ? 'bg-slate-600 text-slate-100 hover:bg-slate-500'
                                : 'cursor-not-allowed bg-slate-700 text-slate-400'
                            }`}
                          >
                            观战
                          </button>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
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
            {joinedRoom ? (
              <span
                aria-disabled="true"
                title="已在房间中，无法再创建"
                className="cursor-not-allowed rounded-lg bg-slate-700 px-5 py-2.5 font-medium text-slate-400 shadow-lg"
              >
                创建房间
              </span>
            ) : (
              <Link
                to="/create-room"
                className="rounded-lg bg-emerald-600 px-5 py-2.5 font-medium text-white shadow-lg hover:bg-emerald-500"
              >
                创建房间
              </Link>
            )}
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
