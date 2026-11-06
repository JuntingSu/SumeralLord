import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { MapFullData, MapMeta, PveGameConfig, PveSaveMetaResponse, SeatAssignment } from '@dl/shared';
import { AI_LEVEL, TIME_DEFAULTS, normalizeAiLevel, reducerVersion } from '@dl/shared';
import {
  deletePveSave,
  getPveMap,
  getPveSave,
  getPveSaveMeta,
  listPveMaps,
  randomPveMap,
} from '../api/pve';
import { ApiError } from '../api/client';
import { useAuth } from '../stores/auth';
import { usePve } from '../stores/pve';
import HexMapPreview from '../components/HexMapPreview';
import MapPicker from '../components/MapPicker';
import { flagImgUrl } from '../lib/flags';
import { decodeMapCode } from '../lib/mapcode';
import { normalizeImportedMap, readMapFile } from '../lib/mapJson';

const PHASE_LABEL: Record<string, string> = {
  PREPARE: '准备阶段',
  ACTION: '行动阶段',
  ADD_POINT: '加点阶段',
  END: '结束阶段',
};

function randomToken(len: number): string {
  const bytes = new Uint8Array(Math.ceil(len / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, len);
}

function withPersonalSkin(map: MapFullData, playerSeat: number, userId: number): MapFullData {
  return {
    ...map,
    player_list: map.player_list.map((p) => (p.seat === playerSeat ? { ...p, flag: -userId } : p)),
  };
}

export default function PveRoom() {
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const room = usePve((s) => s.room);
  const setMap = usePve((s) => s.setMap);
  const setPlayerSeat = usePve((s) => s.setPlayerSeat);
  const setAiLevel = usePve((s) => s.setAiLevel);
  const setFogMode = usePve((s) => s.setFogMode);
  const setUsePersonalSkin = usePve((s) => s.setUsePersonalSkin);

  const [maps, setMaps] = useState<MapMeta[]>([]);
  const [mapsLoading, setMapsLoading] = useState(true);
  const [mapsError, setMapsError] = useState<string | null>(null);
  const [saveMeta, setSaveMeta] = useState<PveSaveMetaResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const [codeInput, setCodeInput] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeBusy, setCodeBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // 从地图编辑器「测试」进入：返回时带当前地图回到编辑器
  const isEditorTest = (() => {
    const fromQuery = new URLSearchParams(window.location.search).get('test') === '1';
    try {
      return fromQuery || sessionStorage.getItem('dl_pve_test_mode') === '1';
    } catch {
      return fromQuery;
    }
  })();

  const backToMapEditor = () => {
    try {
      if (room.map) {
        const originId = sessionStorage.getItem('dl_pve_test_origin');
        sessionStorage.setItem(
          'dl_editor_map_v1',
          JSON.stringify({ id: room.mapId || originId || room.map.id, map: room.map }),
        );
      } else {
        sessionStorage.removeItem('dl_editor_map_v1');
      }
      sessionStorage.removeItem('dl_pve_test_mode');
      sessionStorage.removeItem('dl_pve_test_origin');
    } catch {
      // 本地存储不可用时仍返回编辑器（编辑器会加载服务器默认地图）
    }
    window.location.href = '/mapeditor/?embed=1';
  };

  const loadSaveMeta = useCallback(async () => {
    try {
      setSaveMeta(await getPveSaveMeta());
    } catch {
      setSaveMeta({ exists: false });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setMapsLoading(true);
    listPveMaps(undefined)
      .then((list) => {
        if (!cancelled) setMaps(list);
      })
      .catch((err) => {
        if (!cancelled) setMapsError(err instanceof ApiError ? err.message : '地图库加载失败');
      })
      .finally(() => {
        if (!cancelled) setMapsLoading(false);
      });
    void loadSaveMeta();

    const raw = sessionStorage.getItem('dl_pve_map_v1');
    if (raw) {
      sessionStorage.removeItem('dl_pve_map_v1');
      try {
        const parsed = JSON.parse(raw) as { map?: unknown };
        const res = normalizeImportedMap(parsed.map ?? parsed, 'mapeditor');
        if (res.ok) {
          setMap(res.map, null);
          setNotice(`已从地图编辑器导入「${res.map.title}」`);
        } else {
          setError(res.error);
        }
      } catch {
        setError('地图编辑器交接数据解析失败');
      }
    }
    return () => {
      cancelled = true;
    };
  }, [loadSaveMeta, setMap]);

  const forces = room.map ? [...room.map.player_list].sort((a, b) => a.seat - b.seat) : [];
  const hasTriggers = (room.map?.triggers?.length ?? 0) > 0;

  const handleSelectMap = async (id: string) => {
    if (!id) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const map = await getPveMap(id);
      setMap(map, id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '地图加载失败');
    } finally {
      setBusy(false);
    }
  };

  const handleRandom = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const map = await randomPveMap(room.mapId ?? undefined);
      setMap(map, map.id);
      setNotice(`随机到「${map.title}」`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '随机地图失败，请确认地图库里有可玩地图');
    } finally {
      setBusy(false);
    }
  };

  const handleCodeImport = async () => {
    if (!codeInput.trim()) {
      setCodeError('请先粘贴地图码');
      return;
    }
    setCodeBusy(true);
    setCodeError(null);
    try {
      const decoded = await decodeMapCode(codeInput.trim());
      if (!decoded.ok) {
        setCodeError(decoded.error);
        return;
      }
      const res = normalizeImportedMap(decoded.map, 'mapcode');
      if (!res.ok) {
        setCodeError(res.error);
        return;
      }
      setMap(res.map, null);
      setCodeOpen(false);
      setCodeInput('');
      setError(null);
      setNotice(`已从地图码导入「${res.map.title}」`);
    } finally {
      setCodeBusy(false);
    }
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await readMapFile(file);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setMap(res.map, null);
      setNotice(`已导入「${res.map.title}」`);
    } catch {
      setError('读取地图文件失败');
    } finally {
      setBusy(false);
    }
  };

  const handleStart = () => {
    if (!user) return;
    if (!room.map || room.playerSeat === null) {
      setError('请先选择地图与要扮演的势力');
      return;
    }
    if (room.map.player_num < 2) {
      setError('地图至少需要 2 个势力');
      return;
    }
    const sourceMap = room.map;
    const playerSeat = room.playerSeat;
    const map = room.usePersonalSkin && user.hasSkin
      ? withPersonalSkin(sourceMap, playerSeat, user.id)
      : sourceMap;
    const seatAssignments: SeatAssignment[] = map.player_list.map((p) => {
      const isHuman = p.seat === playerSeat;
      return {
        seat: p.seat,
        playerId: isHuman ? user.id : null,
        isAI: !isHuman,
        ...(isHuman ? {} : { computer: normalizeAiLevel(room.aiLevels[p.seat] ?? AI_LEVEL.EASY) }),
      };
    });
    const config: PveGameConfig = {
      gameId: `pve-${randomToken(8)}`,
      map,
      mapTitle: map.title,
      seatAssignments,
      seed: randomToken(16),
      timeSettings: { ...TIME_DEFAULTS },
      fogMode: room.fogMode,
      usePersonalSkin: room.usePersonalSkin,
      playerSeat,
      humanUserId: user.id,
      reducerVersion: reducerVersion(),
    };
    usePve.getState().setLastGame(config);
    usePve.getState().clearLoadSave();
    navigate('/pve/game');
  };

  const handleContinue = async () => {
    setBusy(true);
    setError(null);
    try {
      const save = await getPveSave();
      if (!save) {
        setError('存档不存在或已被清除');
        await loadSaveMeta();
        return;
      }
      if (save.state.finished) {
        await deletePveSave();
        await loadSaveMeta();
        setError('该存档已结束，已自动清除');
        return;
      }
      usePve.getState().restoreRoomFromConfig(save.config);
      usePve.getState().setLoadSave(save);
      navigate('/pve/game?load=1');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '读取存档失败');
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = async () => {
    if (!window.confirm('确定放弃当前存档？')) return;
    setBusy(true);
    try {
      await deletePveSave();
      await loadSaveMeta();
      setNotice('已放弃存档');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '删除存档失败');
    } finally {
      setBusy(false);
    }
  };

  const canStart = Boolean(room.map && room.playerSeat !== null && room.map.player_num >= 2 && !busy);

  return (
    <div className="flex min-h-screen flex-col bg-slate-900 text-white lg:h-screen lg:overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700 px-3 py-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          {isEditorTest ? (
            <button
              type="button"
              onClick={backToMapEditor}
              className="cursor-pointer text-sm text-emerald-400 hover:underline"
            >
              ← 返回
            </button>
          ) : (
            <Link to="/modes" className="text-sm text-emerald-400 hover:underline">
              ← 模式选择
            </Link>
          )}
          <h1 className="text-lg font-bold">单人 PVE</h1>
          <span className="rounded bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
            {hasTriggers ? '触发器地图' : '本地对局'}
          </span>
        </div>
      </header>

      {error && (
        <div className="mx-3 mt-3 rounded bg-red-900/50 px-3 py-2 text-sm text-red-200 sm:mx-6" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="mx-3 mt-3 rounded bg-emerald-900/40 px-3 py-2 text-sm text-emerald-200 sm:mx-6" role="status">
          {notice}
        </div>
      )}

      <main className="mx-auto grid min-h-0 w-full max-w-6xl flex-1 gap-3 px-3 py-4 sm:gap-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* 势力 + 开始 */}
        <section className="flex min-h-0 flex-col rounded-lg bg-slate-800 p-4 max-lg:order-2">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold text-slate-400">势力与 AI</h2>
            {room.map && (
              <span className="text-xs text-slate-500">
                {room.map.row}×{room.map.column} · {room.map.player_num} 势力
              </span>
            )}
          </div>

          {!room.map ? (
            <div className="flex flex-1 items-center justify-center rounded bg-slate-700/30 py-16 text-sm text-slate-500">
              请先在右侧选择、随机或导入一张地图
            </div>
          ) : (
            <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
              {forces.map((p) => {
                const isHuman = p.seat === room.playerSeat;
                return (
                  <li
                    key={p.seat}
                    className={`flex flex-nowrap items-center gap-1.5 rounded px-2 py-1.5 ${
                      isHuman ? 'bg-emerald-900/30 ring-1 ring-emerald-700' : 'bg-slate-700/30'
                    }`}
                  >
                    <span className="w-4 shrink-0 text-xs text-slate-500">{p.seat}</span>
                    <img
                      src={flagImgUrl(p.flag)}
                      alt=""
                      className="h-5 w-4 shrink-0 object-contain"
                      onError={(e) => {
                        (e.target as HTMLImageElement).style.visibility = 'hidden';
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{p.name}</span>
                    <span className="shrink-0 text-[11px] text-slate-400">队伍 {p.team}</span>
                    <span className={`shrink-0 text-xs ${isHuman ? 'text-emerald-300' : 'text-slate-400'}`}>
                      {isHuman ? '我' : 'AI'}
                    </span>
                    {isHuman ? (
                      <span className="shrink-0 rounded bg-emerald-700/50 px-1.5 py-0.5 text-[10px] text-emerald-200">当前</span>
                    ) : (
                      <>
                        <select
                          value={room.aiLevels[p.seat] ?? AI_LEVEL.EASY}
                          onChange={(e) => setAiLevel(p.seat, Number(e.target.value))}
                          className="w-14 shrink-0 rounded bg-slate-700 px-1 py-0.5 text-[11px] text-white"
                          title="AI 难度；新局默认全部简单；困难暂未实现"
                        >
                          <option value={AI_LEVEL.EASY}>简单</option>
                          <option value={AI_LEVEL.MEDIUM}>普通</option>
                          <option value={AI_LEVEL.LEISURE}>休闲</option>
                          <option value={AI_LEVEL.HARD} disabled title="开发中">
                            困难
                          </option>
                        </select>
                        <button
                          type="button"
                          onClick={() => setPlayerSeat(p.seat)}
                          className="shrink-0 rounded bg-emerald-600 px-2 py-0.5 text-[11px] text-white hover:bg-emerald-500"
                        >
                          选择
                        </button>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-700 pt-3">
            <button
              type="button"
              onClick={handleStart}
              disabled={!canStart}
              className={`rounded px-5 py-2 font-medium ${
                canStart ? 'bg-emerald-600 text-white hover:bg-emerald-500' : 'cursor-not-allowed bg-slate-700 text-slate-400'
              }`}
            >
              开始对局
            </button>
          </div>
        </section>

        {/* 地图 / 设置 / 存档 */}
        <section className="min-h-0 space-y-4 max-lg:contents lg:overflow-y-auto">
          {saveMeta?.exists && (
            <div className="rounded-lg border border-amber-700 bg-amber-900/20 p-4 max-lg:order-3">
              <h2 className="mb-1 text-sm font-bold text-amber-300">继续上次对局</h2>
              <p className="truncate text-sm font-medium">{saveMeta.mapTitle}</p>
              <p className="mt-0.5 text-xs text-slate-400">
                第 {saveMeta.turn} 回合 · {PHASE_LABEL[saveMeta.phase ?? ''] ?? saveMeta.phase} · 当前行动：
                {saveMeta.currentForce}
              </p>
              <p className="mt-0.5 text-xs text-slate-500">
                保存于 {saveMeta.savedAt ? new Date(saveMeta.savedAt).toLocaleString() : '—'}
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={handleContinue}
                  disabled={busy}
                  className="rounded bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50"
                >
                  继续对局
                </button>
                <button
                  type="button"
                  onClick={handleDiscard}
                  disabled={busy}
                  className="rounded bg-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-600 disabled:opacity-50"
                >
                  放弃存档
                </button>
              </div>
            </div>
          )}

          <div className="rounded-lg bg-slate-800 p-4 max-lg:order-1">
            <h2 className="mb-2 text-sm font-bold text-slate-400">地图</h2>
            {room.map ? (
              <>
                <HexMapPreview battlefield={room.map.battlefield} column={room.map.column} row={room.map.row} height={200} />
                <p className="mt-2 flex items-center gap-2 truncate text-sm font-medium">
                  <span className="truncate">{room.map.title}</span>
                  {hasTriggers && (
                    <span className="shrink-0 rounded bg-amber-700/40 px-1.5 py-0.5 text-[10px] text-amber-200">
                      含触发器
                    </span>
                  )}
                </p>
                <p className="text-xs text-slate-400">
                  {room.map.row}×{room.map.column} · {room.map.player_num} 势力 · 作者：
                  {room.map.author?.trim() || '未知作者'}
                </p>
              </>
            ) : (
              <div className="flex h-40 items-center justify-center rounded bg-slate-700/30 text-sm text-slate-500">
                未选择地图
              </div>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleRandom}
                disabled={busy}
                className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                title="点击时从 PVE 地图库随机选一张"
              >
                🎲 随机地图
              </button>
              <button
                type="button"
                onClick={() => {
                  setCodeOpen(true);
                  setCodeError(null);
                }}
                className="rounded bg-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-600"
              >
                🎴 地图码导入
              </button>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="rounded bg-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-600"
              >
                📂 JSON 导入
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  void handleFile(file);
                }}
              />
            </div>

            <div className="mt-3">
              <MapPicker
                maps={maps}
                value={room.mapId ?? ''}
                onChange={handleSelectMap}
                maxResults={100}
                disabled={busy || mapsLoading}
                placeholder={
                  mapsLoading ? '加载地图库…' : '搜索地图库（标题/作者/标签）'
                }
              />
              {mapsError && <p className="mt-1 text-xs text-red-400">{mapsError}</p>}
              {!mapsLoading && maps.length === 0 && (
                <p className="mt-1 text-xs text-slate-500">
                  地图库为空或没有可玩地图，可用随机/地图码/JSON/地图编辑器导入。
                </p>
              )}
            </div>
          </div>

          <div className="rounded-lg bg-slate-800 p-4 max-lg:order-4">
            <h2 className="mb-3 text-sm font-bold text-slate-400">设置</h2>
            <div className="space-y-2 text-sm">
              <label className="flex items-center justify-between">
                <span className="text-slate-300">战争迷雾</span>
                <input type="checkbox" checked={room.fogMode} onChange={(e) => setFogMode(e.target.checked)} />
              </label>
              <label
                className="flex items-center justify-between"
                title={user?.hasSkin ? '勾选后，你的势力旗帜替换为个人皮肤' : '未上传个人皮肤，勾选后仍保持原旗帜'}
              >
                <span className="text-slate-300">使用个人皮肤</span>
                <input
                  type="checkbox"
                  checked={room.usePersonalSkin}
                  disabled={!user?.hasSkin}
                  onChange={(e) => setUsePersonalSkin(e.target.checked)}
                />
              </label>
            </div>
          </div>
        </section>
      </main>

      {codeOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-lg rounded-lg bg-slate-800 p-5 shadow-xl">
            <h3 className="mb-2 text-lg font-bold">从地图码导入</h3>
            <p className="mb-2 text-xs text-slate-400">粘贴旧版地图编辑器导出的 base64 地图码。</p>
            <textarea
              value={codeInput}
              onChange={(e) => setCodeInput(e.target.value)}
              rows={6}
              spellCheck={false}
              placeholder="粘贴地图码…"
              className="w-full rounded bg-slate-700 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-emerald-500"
            />
            {codeError && <p className="mt-1 text-xs text-red-400">{codeError}</p>}
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setCodeOpen(false);
                  setCodeError(null);
                }}
                className="rounded bg-slate-600 px-4 py-2 text-sm text-slate-200 hover:bg-slate-500"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleCodeImport}
                disabled={codeBusy}
                className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {codeBusy ? '解析中…' : '导入'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
