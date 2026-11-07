import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';
import type { UserMapSort } from '@dl/shared';
import { MapGallery, type MapGallerySort } from '../components/MapGallery';
import type { GalleryMapMeta } from '../components/MapCard';
import { getUserMapPreview, listMyMaps, publishUserMap } from '../api/userMaps';

const SORTS: MapGallerySort[] = [
  { value: 'recent', label: '最近更新' },
  { value: 'oldest', label: '最早更新' },
  { value: 'title_asc', label: '地图名 A→Z' },
  { value: 'title_desc', label: '地图名 Z→A' },
];

export default function MyWorks() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [error, setError] = useState('');

  const fetchPage = useCallback(
    (q: { search: string; sort: UserMapSort; page: number; pageSize: number }) =>
      listMyMaps(q),
    [],
  );

  const loadPreview = useCallback((id: string) => getUserMapPreview(id), []);

  const publish = async (meta: GalleryMapMeta, close: () => void) => {
    if (meta.published || publishing) return;
    setPublishing(meta.id);
    setError('');
    try {
      await publishUserMap(meta.id);
      setRefreshKey((n) => n + 1);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : '发布失败');
    } finally {
      setPublishing(null);
    }
  };

  return (
    <div className="min-h-screen bg-slate-900 text-white">
      <header className="flex items-center justify-between border-b border-slate-700 px-6 py-3">
        <div className="flex items-center gap-3">
          <Link
            to="/profile"
            className="rounded bg-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-600"
          >
            ← 个人中心
          </Link>
          <h1 className="text-sm font-medium text-slate-300">我的作品</h1>
        </div>
        <span className="text-xs text-slate-500">每个账号最多 200 张</span>
      </header>

      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
        {error ? (
          <div className="mb-4 rounded bg-red-900/50 px-3 py-2 text-sm text-red-200" role="alert">
            {error}
          </div>
        ) : null}
        <MapGallery
          fetchPage={fetchPage}
          loadPreview={loadPreview}
          sorts={SORTS}
          defaultSort="recent"
          refreshKey={refreshKey}
          emptyText="还没有作品。在地图编辑器中点击「保存为我的作品」即可创建。"
          renderActions={(meta, { close }) => (
            <>
              <button
                type="button"
                className="rounded bg-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-600"
                onClick={() => {
                  window.location.href = `/mapeditor/?embed=1&work=${encodeURIComponent(meta.id)}`;
                }}
              >
                编辑
              </button>
              <button
                type="button"
                disabled={!!meta.published || publishing === meta.id}
                className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void publish(meta, close)}
              >
                {meta.published ? '已发布' : publishing === meta.id ? '发布中…' : '发布'}
              </button>
            </>
          )}
        />
      </main>
    </div>
  );
}
