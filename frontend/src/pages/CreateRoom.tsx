import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { CreateRoomBody, MapMeta, MapPreview } from '@dl/shared';
import { TIME_DEFAULTS, TIME_OPTIONS } from '@dl/shared';
import { getMapPreview, listMaps } from '../api/map';
import { createRoom } from '../api/room';
import { ApiError } from '../api/client';
import { useAuth } from '../stores/auth';
import { useLobby } from '../stores/lobby';
import HexMapPreview from '../components/HexMapPreview';
import MapPicker from '../components/MapPicker';

export default function CreateRoom() {
  const navigate = useNavigate();
  const user = useAuth((s) => s.user);
  const setJoined = useLobby((s) => s.setJoined);

  const [maps, setMaps] = useState<MapMeta[]>([]);
  const [mapId, setMapId] = useState('');
  const [preview, setPreview] = useState<MapPreview | null>(null);
  const [name, setName] = useState(`${user?.username ?? '玩家'}的房间`);
  const [password, setPassword] = useState('');
  const [allowSpectate, setAllowSpectate] = useState(true);
  const [fogMode, setFogMode] = useState(false);
  const [randomSpawn, setRandomSpawn] = useState(true);
  const [usePersonalSkin, setUsePersonalSkin] = useState(false);
  const [stepTime, setStepTime] = useState<number>(TIME_DEFAULTS.stepTime);
  const [gameTime, setGameTime] = useState<number>(TIME_DEFAULTS.gameTime);
  const [additionalTime, setAdditionalTime] = useState<number>(TIME_DEFAULTS.additionalTime);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    listMaps()
      .then((list) => {
        setMaps(list);
        // 初始不预选任何地图，由用户自行搜索选择
      })
      .catch(() => setError('地图列表加载失败'));
  }, []);

  useEffect(() => {
    if (!mapId) return;
    setPreview(null);
    getMapPreview(mapId)
      .then(setPreview)
      .catch(() => setPreview(null));
  }, [mapId]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!mapId) {
      setError('请先选择地图再创建房间');
      return;
    }
    setBusy(true);
    try {
      const body: CreateRoomBody = {
        name: name.trim(),
        ...(password ? { password } : {}),
        allowSpectate,
        fogMode,
        randomSpawn,
        usePersonalSkin,
        mapId,
        timeSettings: { stepTime, gameTime, additionalTime },
      };
      const result = await createRoom(body);
      setJoined(result.room);
      navigate(`/room/${result.room.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误，请稍后再试');
    } finally {
      setBusy(false);
    }
  }

  const inputCls = 'w-full rounded bg-slate-700 px-3 py-2 text-white outline-none focus:ring-2 focus:ring-emerald-500';
  const labelCls = 'mb-1 block text-sm text-slate-300';

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="border-b border-slate-700 px-6 py-4">
        <Link to="/lobby" className="text-sm text-emerald-400 hover:underline">
          ← 返回大厅
        </Link>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">
        <form onSubmit={handleSubmit} className="rounded-lg bg-slate-800 p-6">
          <h1 className="mb-6 text-xl font-bold">创建房间</h1>
          {error && (
            <div className="mb-4 rounded bg-red-900/50 px-3 py-2 text-sm text-red-200" role="alert">
              {error}
            </div>
          )}

          {/* 左列全部输入项 + 右列地图预览：步时/局时/加时竖排三行、复选框与计时都只占左半，右半留给预览（窄屏同样两栏） */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:gap-x-6">
            <div className="min-w-0 space-y-4">
              <div>
                <label className={labelCls} htmlFor="room-name">房间名</label>
                <input id="room-name" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required maxLength={20} />
              </div>
              <div>
                <label className={labelCls} htmlFor="room-password">密码（留空为无密码）</label>
                <input id="room-password" className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)} maxLength={32} />
              </div>
              <div>
                <label className={labelCls} htmlFor="map-select">地图</label>
                <MapPicker id="map-select" maps={maps} value={mapId} onChange={setMapId} />
              </div>

              {/* 允许观战/战争迷雾/随机出生点/使用个人皮肤：宽屏在左列一行四列；窄屏移入右列预览图下方 */}
              <div className="hidden gap-2 pt-2 sm:grid sm:grid-cols-4">
                <label className="flex items-center gap-1.5 text-sm text-slate-300">
                  <input type="checkbox" checked={allowSpectate} onChange={(e) => setAllowSpectate(e.target.checked)} />
                  允许观战
                </label>
                <label className="flex items-center gap-1.5 text-sm text-slate-300">
                  <input type="checkbox" checked={fogMode} onChange={(e) => setFogMode(e.target.checked)} />
                  战争迷雾
                </label>
                <label className="flex items-center gap-1.5 text-sm text-slate-300">
                  <input type="checkbox" checked={randomSpawn} onChange={(e) => setRandomSpawn(e.target.checked)} />
                  随机出生点
                </label>
                <label
                  className="flex items-center gap-1.5 text-sm text-slate-300"
                  title="勾选后，对局初始化时各势力旗帜替换为扮演玩家的个人皮肤（未上传皮肤的玩家保持原旗帜）"
                >
                  <input type="checkbox" checked={usePersonalSkin} onChange={(e) => setUsePersonalSkin(e.target.checked)} />
                  使用个人皮肤
                </label>
              </div>

              {/* 步时/局时/加时：足够宽时一行三列，过窄则一行一个 */}
              <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-3">
                <div>
                  <label className={labelCls} htmlFor="step-time">步时(秒)</label>
                  <select id="step-time" className={inputCls} value={stepTime} onChange={(e) => setStepTime(Number(e.target.value))}>
                    {TIME_OPTIONS.stepTime.map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls} htmlFor="game-time">局时(秒)</label>
                  <select id="game-time" className={inputCls} value={gameTime} onChange={(e) => setGameTime(Number(e.target.value))}>
                    {TIME_OPTIONS.gameTime.map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls} htmlFor="add-time">加时(秒)</label>
                  <select id="add-time" className={inputCls} value={additionalTime} onChange={(e) => setAdditionalTime(Number(e.target.value))}>
                    {TIME_OPTIONS.additionalTime.map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                </div>
              </div>

              <button
                type="submit"
                disabled={busy}
                className="mt-2 w-full rounded bg-emerald-600 py-2 font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {busy ? '创建中…' : '创建并进入'}
              </button>
            </div>

            {/* 右列：地图预览（占满右半高度） */}
            <div className="min-w-0">
              <h2 className="mb-2 text-sm font-bold text-slate-400">地图预览</h2>
              {preview ? (
                <HexMapPreview battlefield={preview.battlefield} column={preview.column} row={preview.row} height={280} />
              ) : mapId ? (
                <div className="flex h-56 items-center justify-center text-slate-500">加载中…</div>
              ) : (
                <div className="flex h-56 items-center justify-center text-slate-500">请选择地图以查看预览</div>
              )}
              {(() => {
                const meta = maps.find((m) => m.id === mapId);
                return meta ? (
                  <p className="mt-2 text-sm text-slate-400">
                    {meta.title} · {meta.playerNum} 人 · {meta.description}
                  </p>
                ) : null;
              })()}

              {/* 窄屏：观战/迷雾/出生点/个人皮肤选项放在预览图下方 */}
              <div className="mt-4 grid grid-cols-1 gap-2 sm:hidden">
                <label className="flex items-center gap-1.5 text-sm text-slate-300">
                  <input type="checkbox" checked={allowSpectate} onChange={(e) => setAllowSpectate(e.target.checked)} />
                  允许观战
                </label>
                <label className="flex items-center gap-1.5 text-sm text-slate-300">
                  <input type="checkbox" checked={fogMode} onChange={(e) => setFogMode(e.target.checked)} />
                  战争迷雾
                </label>
                <label className="flex items-center gap-1.5 text-sm text-slate-300">
                  <input type="checkbox" checked={randomSpawn} onChange={(e) => setRandomSpawn(e.target.checked)} />
                  随机出生点
                </label>
                <label
                  className="flex items-center gap-1.5 text-sm text-slate-300"
                  title="勾选后，对局初始化时各势力旗帜替换为扮演玩家的个人皮肤（未上传皮肤的玩家保持原旗帜）"
                >
                  <input type="checkbox" checked={usePersonalSkin} onChange={(e) => setUsePersonalSkin(e.target.checked)} />
                  使用个人皮肤
                </label>
              </div>
            </div>
          </div>
        </form>
      </main>
    </div>
  );
}
