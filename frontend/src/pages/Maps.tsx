import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MapFullData, MapMeta } from '@dl/shared';
import { getMap, listMaps } from '../api/map';
import HexMapPreview from '../components/HexMapPreview';

export default function Maps() {
  const [search, setSearch] = useState('');
  const [maps, setMaps] = useState<MapMeta[]>([]);
  const [selected, setSelected] = useState<MapFullData | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load(keyword: string) {
    try {
      const list = await listMaps(keyword || undefined);
      setMaps(list);
      setSelected(list.length > 0 ? await getMap(list[0].id) : null);
    } catch {
      setError('地图列表加载失败');
    }
  }

  useEffect(() => {
    load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSelect(meta: MapMeta) {
    setError(null);
    try {
      setSelected(await getMap(meta.id));
    } catch {
      setError('地图加载失败');
    }
  }

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="border-b border-slate-700 px-6 py-4">
        <Link to="/lobby" className="text-sm text-emerald-400 hover:underline">
          ← 返回大厅
        </Link>
      </header>
      <main className="mx-auto max-w-5xl px-6 py-8">
        <div className="mb-6 flex items-center justify-between gap-4">
          <h1 className="text-xl font-bold">地图库</h1>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              load(search.trim());
            }}
          >
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索标题 / 作者 / 标签"
              className="w-64 rounded bg-slate-800 px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <button type="submit" className="rounded bg-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-600">
              搜索
            </button>
          </form>
        </div>

        {error && (
          <div className="mb-4 rounded bg-red-900/50 px-3 py-2 text-sm text-red-200" role="alert">
            {error}
          </div>
        )}

        <div className="grid gap-8 md:grid-cols-[280px_1fr]">
          <ul className="space-y-2">
            {maps.map((m) => (
              <li key={m.id}>
                <button
                  onClick={() => handleSelect(m)}
                  className={`w-full rounded-lg px-4 py-3 text-left hover:bg-slate-700 ${
                    selected?.id === m.id ? 'bg-slate-700' : 'bg-slate-800'
                  }`}
                >
                  <p className="font-medium">{m.title}</p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    {m.playerNum} 人 · {m.author}
                  </p>
                </button>
              </li>
            ))}
            {maps.length === 0 && <li className="rounded-lg bg-slate-800 p-6 text-center text-slate-500">无匹配地图</li>}
          </ul>

          {selected && (
            <section className="rounded-lg bg-slate-800 p-6">
              <div className="mb-4 flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-bold">{selected.title}</h2>
                  <p className="mt-1 text-sm text-slate-400">{selected.description}</p>
                </div>
                <div className="flex flex-wrap justify-end gap-1">
                  {selected.tags.map((tag) => (
                    <span key={tag} className="rounded bg-slate-700 px-2 py-0.5 text-xs text-slate-300">
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
              <HexMapPreview battlefield={selected.battlefield} column={selected.column} row={selected.row} height={360} />
              <div className="mt-4 grid grid-cols-2 gap-2 text-sm text-slate-400 md:grid-cols-4">
                <span>尺寸 {selected.column}×{selected.row}</span>
                <span>势力 {selected.player_num}</span>
                <span>迷雾 {selected.fog_mode ? '开' : '关'}</span>
                <span>随机出生 {selected.random_spawn ? '开' : '关'}</span>
              </div>
              <div className="mt-3 flex flex-wrap gap-3 text-sm">
                {selected.player_list.map((p) => (
                  <span key={p.seat} className="rounded bg-slate-700/60 px-2 py-1">
                    座次{p.seat} · {p.name} · 队伍{p.team}
                  </span>
                ))}
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
