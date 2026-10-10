import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { MapFullData, MapMeta, RoomPlayer, RoomSettingsPatch } from '@dl/shared';
import { TIME_OPTIONS, AI_LEVEL, AI_LEVEL_LABEL } from '@dl/shared';
import { getMap, listMaps } from '../api/map';
import {
  changeRoomMap,
  disbandRoom,
  getRoom,
  kickFromForce,
  kickPlayer,
  leaveRoom,
  selectForce,
  setForceAiLevel,
  setReady,
  startRoomGame,
  updateRoomSettings,
} from '../api/room';
import { ApiError } from '../api/client';
import { useAuth } from '../stores/auth';
import { useLobby } from '../stores/lobby';
import { useRoom } from '../stores/room';
import { useGame } from '../stores/game';
import { WsClient } from '../ws/client';
import { avatarUrl, flagImgUrl } from '../lib/flags';
import HexMapPreview from '../components/HexMapPreview';
import MapPicker from '../components/MapPicker';
import Chat from '../components/Chat';
import GameChat from '../components/GameChat';

/** 玩家状态 icon：灰空心圆=未准备，绿√=已准备，红×=断线；紧贴玩家名展示 */
function PlayerStateIcon({ player }: { player: RoomPlayer }) {
  if (!player.online) {
    return (
      <span
        title="已断线"
        className="ml-1 inline-flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-full bg-red-500 align-middle text-[9px] font-bold leading-none text-white"
      >
        ✕
      </span>
    );
  }
  if (player.state === 'prepared') {
    return (
      <span
        title="已准备"
        className="ml-1 inline-flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-full bg-emerald-500 align-middle text-[9px] font-bold leading-none text-white"
      >
        ✓
      </span>
    );
  }
  return <span title="未准备" className="ml-1 inline-block h-[13px] w-[13px] shrink-0 rounded-full border-2 border-slate-400 align-middle" />;
}

/** 势力行：座次 | 旗帜 | 势力名 | 扮演玩家 | 队伍 | (桌面)准备状态 | 选择/取消；窄屏去掉状态列并收窄列宽 */
const FORCE_ROW_COLS =
  'grid grid-cols-[36px_30px_minmax(48px,1fr)_minmax(48px,1fr)_36px_48px] items-center gap-1.5 sm:grid-cols-[44px_36px_minmax(72px,1fr)_minmax(72px,1fr)_48px_56px_64px] sm:gap-2';

/** 地图六边形网格高宽比（与 HexMapPreview 尺寸计算一致），用于移动端浮动小预览等比例缩放 */
function mapAspectRatio(map: MapFullData): number {
  return (2 + 1.5 * (map.row - 1)) / (Math.sqrt(3) * (map.column + 0.5));
}

export default function Room() {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();
  const me = useAuth((s) => s.user);
  const setJoined = useLobby((s) => s.setJoined);

  const room = useRoom((s) => s.room);
  const chat = useRoom((s) => s.chat);
  const connection = useRoom((s) => s.connection);
  const notice = useRoom((s) => s.notice);

  const [mapFull, setMapFull] = useState<MapFullData | null>(null);
  const [maps, setMaps] = useState<MapMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WsClient | null>(null);
  const mapPreviewRef = useRef<HTMLDivElement>(null);
  const [mapPreviewFullyVisible, setMapPreviewFullyVisible] = useState(true);
  const [mapPreviewDismissed, setMapPreviewDismissed] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);

  // 加载房间 + 成员身份校验
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await getRoom(roomId!);
        if (cancelled) return;
        if (!me || !data.players.some((p) => p.id === me.id)) {
          navigate('/lobby', { replace: true });
          return;
        }
        useRoom.getState().setRoom(data);
        setJoined(data);
      } catch {
        navigate('/lobby', { replace: true });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roomId, me, navigate, setJoined]);

  // WS 生命周期：连接、消息分发、被踢/解散处理
  useEffect(() => {
    const client = new WsClient(roomId!);
    wsRef.current = client;
    const offStatus = client.onStatus((s) => useRoom.getState().setConnection(s));
    const offMessage = client.onMessage((msg) => {
      if (msg.type === 'CONNECT_ACK' && msg.gameId) {
        // 对局进行中：跳转对局页重连（Game 页经 meta 恢复 board + 事件重放追平），
        // 覆盖"对局中离开回大厅再进房间"与"观战加入进行中对局"两条路径
        navigate(`/game/${roomId}`, { replace: true });
        return;
      }
      if (msg.type === 'PLAYER_LEAVE' && msg.playerId === me?.id) {
        useRoom.getState().setNotice('你已被移出房间');
      }
      if (msg.type === 'GAME_START') {
        // 对局开始：初始化对局状态机并跳转对局页（startMsg 已入 store，Game 页直接读取）
        useGame.getState().startGame({
          roomId: roomId!,
          startMsg: msg,
          myUserId: me?.id ?? null,
          fogMode: useRoom.getState().room?.fogMode ?? false,
        });
        navigate(`/game/${roomId}`, { replace: true });
        return;
      }
      if (msg.type === 'ROOM_UPDATE' && msg.room.status !== 'in_game' && useGame.getState().board !== null) {
        // 对局中止/结束/回落：回房间页继续（重置对局状态机）
        useGame.getState().reset();
      }
      useRoom.getState().applyServer(msg);
    });
    client.connect().catch(() => undefined);
    return () => {
      offStatus();
      offMessage();
      client.close();
      wsRef.current = null;
      useRoom.getState().reset();
    };
  }, [roomId, me, navigate]);

  // 房间地图变化 → 拉全量地图数据（预览 + 信息）；随机 1v1 模式不使用所选地图，无需拉取
  useEffect(() => {
    if (!room) return;
    if (room.random1v1Map) {
      setMapFull(null);
      return;
    }
    if (mapFull?.id === room.mapId) return;
    setMapFull(null);
    getMap(room.mapId)
      .then(setMapFull)
      .catch(() => setMapFull(null));
  }, [room?.mapId, room?.random1v1Map, room, mapFull?.id]);

  // 地图预览完整可见性（移动端单列布局：整幅预览未完整进入视口时，左下角浮动小预览）
  useEffect(() => {
    const el = mapPreviewRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(([entry]) => setMapPreviewFullyVisible(entry.isIntersecting), {
      threshold: 1,
    });
    obs.observe(el);
    return () => obs.disconnect();
  }, [mapFull?.id]);

  // 视口宽度变化 → 浮动小预览高度按「页宽 45%」等比例更新
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 换图候选
  useEffect(() => {
    listMaps()
      .then(setMaps)
      .catch(() => undefined);
  }, []);

  // 解散/被踢通知 → 回大厅
  useEffect(() => {
    if (!notice) return;
    setJoined(null);
    window.alert(notice);
    useRoom.getState().clearNotice();
    navigate('/lobby', { replace: true });
  }, [notice, navigate, setJoined]);

  if (!room || !me) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900 text-slate-400">加载中…</div>
    );
  }

  const myPlayer = room.players.find((p) => p.id === me.id);
  const isHost = room.hostId === me.id;
  const isSpectator = myPlayer?.state === 'spectating';
  const players = room.players.filter((p) => p.state !== 'spectating');
  const spectators = room.players.filter((p) => p.state === 'spectating');
  const allReady = players.length > 0 && players.every((p) => p.state === 'prepared');
  const canStart = isHost && allReady;
  const myForceSelected = room.forces.some((f) => f.playerId === me.id);

  const guard = async (fn: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误，请稍后再试');
    }
  };

  const handleLeave = async () => {
    await guard(() => leaveRoom(room.id));
    setJoined(null);
    navigate('/lobby');
  };

  const handleDisband = async () => {
    if (!window.confirm('确定解散房间？所有玩家将被移出。')) return;
    await guard(() => disbandRoom(room.id));
    setJoined(null);
    navigate('/lobby');
  };

  const handleSettingsPatch = (patch: RoomSettingsPatch) => {
    void guard(() => updateRoomSettings(room.id, patch));
  };

  const seatStateText = (playerId: number | null): string => {
    if (playerId === null) return '—';
    const p = room.players.find((x) => x.id === playerId);
    if (!p) return '—';
    if (p.state === 'prepared') return '已准备';
    if (p.state === 'spectating') return '观战';
    return '未准备';
  };

  return (
    <div className="flex min-h-screen flex-col bg-slate-900 text-white">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700 px-3 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Link to="/lobby" className="text-sm text-emerald-400 hover:underline">
            ← 大厅
          </Link>
          <h1 className="text-lg font-bold">{room.name}</h1>
          <span className="rounded bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
            {room.status === 'waiting' ? '等待中' : room.status === 'game_over' ? '已结束' : '对局中'}
          </span>
          <span
            className={`flex items-center gap-1 text-xs ${connection === 'open' ? 'text-emerald-400' : 'text-amber-400'}`}
            title={connection === 'open' ? '实时连接正常' : '连接中断，正在重连…'}
          >
            ● {connection === 'open' ? '已连接' : connection === 'connecting' ? '连接中…' : '已断开'}
          </span>
        </div>
        <div className="flex gap-2">
          {isHost ? (
            <button onClick={handleDisband} className="rounded bg-red-800 px-3 py-1.5 text-sm text-red-100 hover:bg-red-700">
              解散房间
            </button>
          ) : (
            <button onClick={handleLeave} className="rounded bg-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-600">
              离开房间
            </button>
          )}
        </div>
      </header>

      {error && (
        <div className="mx-3 mt-3 rounded bg-red-900/50 px-3 py-2 text-sm text-red-200 sm:mx-6" role="alert">
          {error}
        </div>
      )}

      <main className="mx-auto grid w-full max-w-6xl flex-1 gap-3 px-3 py-4 sm:gap-4 sm:px-6 lg:grid-cols-[240px_1fr_320px]">
        {/* 左侧列：玩家列表 + 观战列表（观战单列展示在左下角） */}
        <div className="flex min-h-0 flex-col gap-4">
          <section className="rounded-lg bg-slate-800 p-4">
            <h2 className="mb-3 text-sm font-bold text-slate-400">
              玩家（{players.length}/{room.playerNum}）
            </h2>
            <ul className="space-y-2">
              {players.map((p) => (
                <li key={p.id} className="flex items-center gap-2 rounded bg-slate-700/50 px-2 py-1.5">
                  <img
                    src={avatarUrl(p.id, p.flag, p.hasSkin)}
                    alt=""
                    className="h-7 w-6 object-contain"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.visibility = 'hidden';
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center text-sm">
                      <span className="truncate">
                        {p.username}
                        {p.id === room.hostId && <span title="房主">👑</span>}
                      </span>
                      <PlayerStateIcon player={p} />
                    </span>
                    <span className="block truncate text-xs text-slate-400">
                      {p.score.toFixed(1)} 分 · 胜率 {p.matches > 0 ? `${((p.wins / p.matches) * 100).toFixed(1)}%` : '—'}
                    </span>
                  </span>
                  {isHost && p.id !== me.id && (
                    <button
                      onClick={() => guard(() => kickPlayer(room.id, p.id))}
                      className="text-xs text-red-400 hover:text-red-300"
                      title="踢出房间"
                    >
                      踢出
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {spectators.length > 0 && (
            <section className="rounded-lg bg-slate-800 p-4">
              <h2 className="mb-3 text-sm font-bold text-slate-400">观战（{spectators.length}）</h2>
              <ul className="space-y-2">
                {spectators.map((p) => (
                  <li key={p.id} className="flex items-center gap-2 rounded bg-slate-700/50 px-2 py-1.5">
                    <img
                      src={avatarUrl(p.id, p.flag, p.hasSkin)}
                      alt=""
                      className="h-7 w-6 object-contain"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.visibility = 'hidden';
                      }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center text-sm">
                        <span className="truncate">
                          {p.username}
                          {p.id === room.hostId && <span title="房主">👑</span>}
                        </span>
                        {!p.online && <PlayerStateIcon player={p} />}
                      </span>
                      <span className="block truncate text-xs text-slate-400">
                        {p.score.toFixed(1)} 分 · 胜率 {p.matches > 0 ? `${((p.wins / p.matches) * 100).toFixed(1)}%` : '—'}
                      </span>
                    </span>
                    {isHost && p.id !== me.id && (
                      <button
                        onClick={() => guard(() => kickPlayer(room.id, p.id))}
                        className="text-xs text-red-400 hover:text-red-300"
                        title="踢出房间"
                      >
                        踢出
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {/* 势力列表：单列行式布局 */}
        <section className="flex min-h-0 flex-col rounded-lg bg-slate-800 p-4">
          <h2 className="mb-3 text-sm font-bold text-slate-400">势力选择（先到先得）</h2>
          <div className={`${FORCE_ROW_COLS} mb-1 px-1.5 text-xs font-bold text-slate-500 sm:px-2`}>
            <span>座次</span>
            <span>旗帜</span>
            <span>势力名</span>
            <span>扮演玩家</span>
            <span>队伍</span>
            <span className="hidden sm:block">状态</span>
            <span className="text-right">操作</span>
          </div>
          <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
            {room.forces.map((f) => {
              const occupant = f.playerId !== null ? room.players.find((p) => p.id === f.playerId) : null;
              const mine = f.playerId === me.id;
              return (
                <li key={f.seat} className={`${FORCE_ROW_COLS} rounded bg-slate-700/30 px-1.5 py-1.5 sm:px-2`}>
                  <span className="text-sm text-slate-400">{f.seat}</span>
                  <img
                    src={flagImgUrl(f.flag)}
                    alt=""
                    className="h-7 w-6 object-contain"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.visibility = 'hidden';
                    }}
                  />
                  <span className="truncate text-sm font-medium">{f.name}</span>
                  {f.aiLevel !== null ? (
                    <span className="truncate text-sm text-sky-400" title={`AI 难度：${AI_LEVEL_LABEL[f.aiLevel] ?? f.aiLevel}（该势力不可选取）`}>
                      AI·{AI_LEVEL_LABEL[f.aiLevel] ?? f.aiLevel}
                    </span>
                  ) : (
                    <span className={`truncate text-sm ${occupant ? (occupant.online ? 'text-slate-200' : 'text-slate-500') : 'text-slate-600'}`}>
                      {occupant?.username ?? '—'}
                    </span>
                  )}
                  <span className="text-sm text-slate-400">{f.team}</span>
                  <span className="hidden text-xs text-slate-400 sm:block">{seatStateText(f.playerId)}</span>
                  <span className="text-right">
                    {occupant ? (
                      mine && !isSpectator ? (
                        <button
                          onClick={() => guard(() => selectForce(room.id, -1))}
                          className="text-xs text-red-400 hover:text-red-300"
                          title="取消自己的选择"
                        >
                          取消
                        </button>
                      ) : isHost && !mine ? (
                        <button
                          onClick={() => guard(() => kickFromForce(room.id, f.seat))}
                          className="text-xs text-red-400 hover:text-red-300"
                          title={`将 ${occupant.username} 移出该势力`}
                        >
                          踢出
                        </button>
                      ) : null
                    ) : isSpectator ? (
                      <span className="text-xs text-slate-600">不可选</span>
                    ) : (
                      <span className="flex flex-wrap items-center justify-end gap-1.5">
                        {isHost && room.aiTakeover && (
                          <select
                            value={f.aiLevel ?? ''}
                            onChange={(e) =>
                              guard(() => setForceAiLevel(room.id, f.seat, e.target.value === '' ? null : Number(e.target.value)))
                            }
                            className="rounded bg-slate-700 px-1.5 py-1 text-xs text-white"
                            title="为势力指定 AI 难度：指定后该势力由 AI 扮演、玩家不可选取；选择「未指定」可恢复可选"
                          >
                            <option value="">未指定</option>
                            <option value={AI_LEVEL.EASY}>简单</option>
                            <option value={AI_LEVEL.MEDIUM}>普通</option>
                            <option value={AI_LEVEL.HARD}>困难</option>
                            <option value={AI_LEVEL.LEISURE}>休闲</option>
                          </select>
                        )}
                        {f.aiLevel === null ? (
                          <button
                            onClick={() => guard(() => selectForce(room.id, f.seat))}
                            className="rounded bg-emerald-600 px-3 py-1 text-xs text-white hover:bg-emerald-500"
                          >
                            选择
                          </button>
                        ) : (
                          <span className="text-xs text-slate-500">AI 专属</span>
                        )}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>

          {/* 底部操作区 */}
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-700 pt-3">
            {!isSpectator && (
              <button
                onClick={() => guard(() => setReady(room.id, myPlayer?.state !== 'prepared'))}
                disabled={room.status === 'game_over' || !myForceSelected}
                title={
                  room.status === 'game_over'
                    ? '对局已结束，结算展示中，稍后可再来一局'
                    : !myForceSelected
                      ? '请先选择势力再准备'
                      : undefined
                }
                className={`rounded px-5 py-2 font-medium disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400 ${
                  myPlayer?.state === 'prepared'
                    ? 'bg-slate-600 text-slate-100 hover:bg-slate-500'
                    : 'bg-emerald-600 text-white hover:bg-emerald-500'
                }`}
              >
                {myPlayer?.state === 'prepared' ? '取消准备' : '准备'}
              </button>
            )}
            {isHost && (
              <button
                onClick={() => guard(() => startRoomGame(room.id))}
                disabled={!canStart}
                title={
                  room.status === 'game_over'
                    ? '对局已结束，结算展示中，稍后可再来一局'
                    : canStart
                      ? '开始游戏（未分配势力将按设置删除或由 AI 接管）'
                      : '等待所有玩家准备'
                }
                className={`rounded px-5 py-2 font-medium ${
                  canStart ? 'bg-indigo-600 text-white hover:bg-indigo-500' : 'cursor-not-allowed bg-slate-700 text-slate-400'
                }`}
              >
                开始游戏
              </button>
            )}
            {isSpectator && <span className="text-sm text-slate-400">观战中，无法影响对局</span>}
          </div>
        </section>

        {/* 地图信息 + 房间设置 */}
        <section className="space-y-4">
          {/* 随机 1v1 模式：不使用所选地图（每局现场生成对称地图），隐藏地图预览与地图信息 */}
          {!room.random1v1Map && (
            <div className="rounded-lg bg-slate-800 p-4">
              <h2 className="mb-2 text-sm font-bold text-slate-400">地图</h2>
              {mapFull ? (
                <>
                  <div ref={mapPreviewRef}>
                    <HexMapPreview battlefield={mapFull.battlefield} column={mapFull.column} row={mapFull.row} height={200} />
                  </div>
                  <p className="mt-2 text-sm font-medium">{mapFull.title}</p>
                  <p className="text-xs text-slate-400">
                    {mapFull.column}×{mapFull.row} · {mapFull.player_num} 势力 · {mapFull.tags.join(' / ')}
                  </p>
                </>
              ) : (
                <div className="flex h-40 items-center justify-center text-slate-500">加载中…</div>
              )}
            </div>
          )}

          <div className="rounded-lg bg-slate-800 p-4">
            <h2 className="mb-3 text-sm font-bold text-slate-400">房间设置{isHost ? '' : '（仅房主可修改）'}</h2>
            <div className="space-y-2 text-sm">
              <label className="flex items-center justify-between">
                <span className="text-slate-300">战争迷雾</span>
                <input
                  type="checkbox"
                  checked={room.fogMode}
                  disabled={!isHost}
                  onChange={(e) => handleSettingsPatch({ fogMode: e.target.checked })}
                />
              </label>
              <label className="flex items-center justify-between">
                <span className="text-slate-300">随机出生点</span>
                <input
                  type="checkbox"
                  checked={room.randomSpawn}
                  disabled={!isHost}
                  onChange={(e) => handleSettingsPatch({ randomSpawn: e.target.checked })}
                />
              </label>
              <label className="flex items-center justify-between">
                <span className="text-slate-300">允许观战</span>
                <input
                  type="checkbox"
                  checked={room.allowSpectate}
                  disabled={!isHost}
                  onChange={(e) => handleSettingsPatch({ allowSpectate: e.target.checked })}
                />
              </label>
              <label className="flex items-center justify-between" title="开启后，开局时无玩家扮演的势力由 AI 接管（房主可为势力指定 AI 难度；指定后该势力玩家不可选取）">
                <span className="text-slate-300">开启 AI 接管</span>
                <input
                  type="checkbox"
                  checked={room.aiTakeover}
                  disabled={!isHost}
                  onChange={(e) => handleSettingsPatch({ aiTakeover: e.target.checked })}
                />
              </label>
              <label
                className="flex items-center justify-between"
                title="勾选后，对局初始化时各势力旗帜替换为扮演玩家的个人皮肤（未上传皮肤的玩家保持原旗帜）"
              >
                <span className="text-slate-300">使用个人皮肤</span>
                <input
                  type="checkbox"
                  checked={room.usePersonalSkin}
                  disabled={!isHost}
                  onChange={(e) => handleSettingsPatch({ usePersonalSkin: e.target.checked })}
                />
              </label>
              <label
                className="flex items-center justify-between"
                title="勾选后：本房间不再使用所选地图，势力重置为「先手 / 后手」两人，开局时现场生成一张随机对称 1v1 地图作为本局地图"
              >
                <span className="text-slate-300">使用随机的 1v1 地图</span>
                <input
                  type="checkbox"
                  checked={room.random1v1Map}
                  disabled={!isHost}
                  onChange={(e) => handleSettingsPatch({ random1v1Map: e.target.checked })}
                />
              </label>
              {isHost && !room.random1v1Map && (
                <div>
                  <span className="mb-1 block text-slate-300">更换地图（将清空势力分配）</span>
                  <MapPicker
                    maps={maps}
                    value={room.mapId}
                    onChange={(id) => {
                      if (id && id !== room.mapId) guard(() => changeRoomMap(room.id, id));
                    }}
                  />
                </div>
              )}
              <div>
                <span className="mb-1 block text-slate-300">计时（步时 / 局时 / 加时，秒）</span>
                {isHost ? (
                  <div className="grid grid-cols-3 gap-2">
                    {(
                      [
                        ['stepTime', TIME_OPTIONS.stepTime],
                        ['gameTime', TIME_OPTIONS.gameTime],
                        ['additionalTime', TIME_OPTIONS.additionalTime],
                      ] as const
                    ).map(([key, options]) => (
                      <select
                        key={key}
                        className="w-full rounded bg-slate-700 px-2 py-1.5 text-sm text-white"
                        value={room.timeSettings[key]}
                        onChange={(e) =>
                          handleSettingsPatch({ timeSettings: { ...room.timeSettings, [key]: Number(e.target.value) } })
                        }
                      >
                        {options.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    ))}
                  </div>
                ) : (
                  <p className="text-slate-400">
                    {room.timeSettings.stepTime} / {room.timeSettings.gameTime} / {room.timeSettings.additionalTime}
                  </p>
                )}
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* 底部聊天（仅桌面端；移动端改用右下角浮层对话） */}
      <footer className="hidden border-t border-slate-700 px-3 py-3 sm:px-6 lg:block">
        <Chat
          chat={chat}
          placeholder={isSpectator ? '观战中…（房间内可发言）' : '输入消息…'}
          onSend={(text) => !!wsRef.current?.sendChat(text)}
        />
      </footer>

      {/* 移动端：整幅地图预览未完整展示时，左下角浮动 45% 页宽、70% 透明度的等比例小预览；可关闭/恢复 */}
      {!room.random1v1Map && !mapPreviewFullyVisible && mapFull && (
        <div className="pointer-events-none fixed bottom-3 left-3 z-10 flex items-end gap-1.5 lg:hidden">
          {mapPreviewDismissed ? (
            <button
              onClick={() => setMapPreviewDismissed(false)}
              className="pointer-events-auto flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-700/90 text-sm font-bold text-white shadow-lg"
              title="恢复地图预览"
              aria-label="恢复地图预览"
            >
              {'>'}
            </button>
          ) : (
            <>
              <div className="overflow-hidden rounded-lg opacity-70" style={{ width: '45vw' }}>
                <HexMapPreview
                  battlefield={mapFull.battlefield}
                  column={mapFull.column}
                  row={mapFull.row}
                  height={Math.round(viewportWidth * 0.45 * mapAspectRatio(mapFull))}
                />
              </div>
              <button
                onClick={() => setMapPreviewDismissed(true)}
                className="pointer-events-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-700/90 text-xs text-white shadow-lg"
                title="关闭地图预览"
                aria-label="关闭地图预览"
              >
                ✕
              </button>
            </>
          )}
        </div>
      )}

      {/* 移动端：对话使用对局内实现（折叠气泡 + 展开面板） */}
      <GameChat
        chat={chat}
        onSend={(text) => !!wsRef.current?.sendChat(text)}
        className="fixed bottom-3 right-3 z-20 lg:hidden"
      />
    </div>
  );
}
