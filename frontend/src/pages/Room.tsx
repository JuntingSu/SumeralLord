import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { MapFullData, MapMeta, RoomSettingsPatch } from '@dl/shared';
import { TIME_OPTIONS } from '@dl/shared';
import { getMap, listMaps } from '../api/map';
import {
  changeRoomMap,
  disbandRoom,
  getRoom,
  kickPlayer,
  leaveRoom,
  selectForce,
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
import HexMapPreview from '../components/HexMapPreview';
import MapPicker from '../components/MapPicker';

const STATE_BADGE: Record<string, { text: string; cls: string }> = {
  unready: { text: '未准备', cls: 'bg-slate-600 text-slate-200' },
  prepared: { text: '已准备', cls: 'bg-emerald-700 text-emerald-100' },
  spectating: { text: '观战', cls: 'bg-indigo-700 text-indigo-100' },
  in_game: { text: '对局中', cls: 'bg-indigo-700 text-indigo-100' },
};

/** 势力行：座次 | 旗帜 | 势力名 | 扮演用户名 | 队伍 | 准备状态 | 选择/取消 */
const FORCE_ROW_COLS = 'grid grid-cols-[44px_36px_minmax(72px,1fr)_minmax(72px,1fr)_48px_56px_64px] items-center gap-2';

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
  const [chatInput, setChatInput] = useState('');
  const wsRef = useRef<WsClient | null>(null);
  const chatListRef = useRef<HTMLDivElement>(null);

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

  // 房间地图变化 → 拉全量地图数据（预览 + 信息）
  useEffect(() => {
    if (!room) return;
    if (mapFull?.id === room.mapId) return;
    setMapFull(null);
    getMap(room.mapId)
      .then(setMapFull)
      .catch(() => setMapFull(null));
  }, [room?.mapId, room, mapFull?.id]);

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

  // 聊天滚动到底
  useEffect(() => {
    const el = chatListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat]);

  if (!room || !me) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900 text-slate-400">加载中…</div>
    );
  }

  const myPlayer = room.players.find((p) => p.id === me.id);
  const isHost = room.hostId === me.id;
  const isSpectator = myPlayer?.state === 'spectating';
  const players = room.players.filter((p) => p.state !== 'spectating');
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

  const handleChatSubmit = (e: FormEvent) => {
    e.preventDefault();
    const text = chatInput.trim();
    if (!text) return;
    if (!wsRef.current?.sendChat(text)) {
      setError('连接已断开，消息未发送');
      return;
    }
    setChatInput('');
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
      <header className="flex items-center justify-between border-b border-slate-700 px-6 py-3">
        <div className="flex items-center gap-3">
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
        <div className="mx-6 mt-3 rounded bg-red-900/50 px-3 py-2 text-sm text-red-200" role="alert">
          {error}
        </div>
      )}

      <main className="mx-auto grid w-full max-w-6xl flex-1 gap-4 px-6 py-4 lg:grid-cols-[240px_1fr_320px]">
        {/* 玩家列表 */}
        <section className="rounded-lg bg-slate-800 p-4">
          <h2 className="mb-3 text-sm font-bold text-slate-400">
            玩家（{players.length}/{room.playerNum}）
            {room.players.length > players.length && ` · 观战 ${room.players.length - players.length}`}
          </h2>
          <ul className="space-y-2">
            {room.players.map((p) => {
              const badge = STATE_BADGE[p.state] ?? STATE_BADGE.unready;
              return (
                <li key={p.id} className="flex items-center gap-2 rounded bg-slate-700/50 px-2 py-1.5">
                  <img
                    src={`/static/flags/flag_${p.flag}.png`}
                    alt=""
                    className="h-7 w-6 object-contain"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.visibility = 'hidden';
                    }}
                  />
                  <span className="flex-1 truncate text-sm">
                    {p.username}
                    {p.id === room.hostId && <span title="房主">👑</span>}
                    {!p.online && <span className="ml-1 text-xs text-slate-500">离线</span>}
                  </span>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${badge.cls}`}>{badge.text}</span>
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
              );
            })}
          </ul>
        </section>

        {/* 势力列表：单列行式布局 */}
        <section className="flex min-h-0 flex-col rounded-lg bg-slate-800 p-4">
          <h2 className="mb-3 text-sm font-bold text-slate-400">势力选择（先到先得）</h2>
          <div className={`${FORCE_ROW_COLS} mb-1 px-2 text-xs font-bold text-slate-500`}>
            <span>座次</span>
            <span>旗帜</span>
            <span>势力名</span>
            <span>扮演玩家</span>
            <span>队伍</span>
            <span>状态</span>
            <span className="text-right">操作</span>
          </div>
          <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
            {room.forces.map((f) => {
              const occupant = f.playerId !== null ? room.players.find((p) => p.id === f.playerId) : null;
              const mine = f.playerId === me.id;
              return (
                <li key={f.seat} className={`${FORCE_ROW_COLS} rounded bg-slate-700/30 px-2 py-1.5`}>
                  <span className="text-sm text-slate-400">{f.seat}</span>
                  <img
                    src={`/static/flags/flag_${f.flag}.png`}
                    alt=""
                    className="h-7 w-6 object-contain"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.visibility = 'hidden';
                    }}
                  />
                  <span className="truncate text-sm font-medium">{f.name}</span>
                  <span className={`truncate text-sm ${occupant ? (occupant.online ? 'text-slate-200' : 'text-slate-500') : 'text-slate-600'}`}>
                    {occupant?.username ?? '—'}
                  </span>
                  <span className="text-sm text-slate-400">{f.team}</span>
                  <span className="text-xs text-slate-400">{seatStateText(f.playerId)}</span>
                  <span className="text-right">
                    {occupant ? (
                      mine && !isSpectator ? (
                        <button
                          onClick={() => guard(() => selectForce(room.id, -1))}
                          className="text-xs text-red-400 hover:text-red-300"
                        >
                          取消
                        </button>
                      ) : null
                    ) : isSpectator ? (
                      <span className="text-xs text-slate-600">不可选</span>
                    ) : (
                      <button
                        onClick={() => guard(() => selectForce(room.id, f.seat))}
                        className="rounded bg-emerald-600 px-3 py-1 text-xs text-white hover:bg-emerald-500"
                      >
                        选择
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>

          {/* 底部操作区 */}
          <div className="mt-4 flex items-center gap-3 border-t border-slate-700 pt-3">
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
          <div className="rounded-lg bg-slate-800 p-4">
            <h2 className="mb-2 text-sm font-bold text-slate-400">地图</h2>
            {mapFull ? (
              <>
                <HexMapPreview battlefield={mapFull.battlefield} column={mapFull.column} row={mapFull.row} height={200} />
                <p className="mt-2 text-sm font-medium">{mapFull.title}</p>
                <p className="text-xs text-slate-400">
                  {mapFull.column}×{mapFull.row} · {mapFull.player_num} 势力 · {mapFull.tags.join(' / ')}
                </p>
              </>
            ) : (
              <div className="flex h-40 items-center justify-center text-slate-500">加载中…</div>
            )}
          </div>

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
              <label className="flex items-center justify-between" title="开启后，开局时无玩家扮演的势力由 AI 接管（难度随地图）">
                <span className="text-slate-300">开启 AI 接管</span>
                <input
                  type="checkbox"
                  checked={room.aiTakeover}
                  disabled={!isHost}
                  onChange={(e) => handleSettingsPatch({ aiTakeover: e.target.checked })}
                />
              </label>
              {isHost && (
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

      {/* 底部聊天 */}
      <footer className="border-t border-slate-700 px-6 py-3">
        <div className="mx-auto flex max-w-6xl gap-3">
          <div ref={chatListRef} className="h-24 flex-1 space-y-1 overflow-y-auto rounded bg-slate-800 px-3 py-2 text-sm">
            {chat.length === 0 && <p className="text-slate-500">暂无消息</p>}
            {chat.map((m) => (
              <p key={`${m.ts}-${m.from}`}>
                <span className="text-emerald-400">{m.username}：</span>
                <span className="text-slate-200">{m.text}</span>
              </p>
            ))}
          </div>
          <form onSubmit={handleChatSubmit} className="flex gap-2">
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              maxLength={200}
              placeholder={isSpectator ? '观战中…（房间内可发言）' : '输入消息…'}
              className="w-64 rounded bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <button
              type="submit"
              className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
            >
              发送
            </button>
          </form>
        </div>
      </footer>
    </div>
  );
}
