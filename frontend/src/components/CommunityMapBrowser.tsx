import { useCallback, useState } from 'react';
import type { MapFullData, UserMapSort } from '@dl/shared';
import { getCommunityMap, getCommunityMapPreview, listCommunityMaps } from '../api/userMaps';
import { MapGallery, type MapGallerySort } from './MapGallery';

const SORTS: MapGallerySort[] = [
  { value: 'recent', label: '最近更新' },
  { value: 'oldest', label: '最早更新' },
  { value: 'title_asc', label: '地图名 A→Z' },
  { value: 'title_desc', label: '地图名 Z→A' },
  { value: 'author_asc', label: '作者名 A→Z' },
  { value: 'author_desc', label: '作者名 Z→A' },
  { value: 'popular', label: '最受欢迎' },
];

interface Props {
  onPick: (map: MapFullData) => void;
  onClose: () => void;
}

export function CommunityMapBrowser({ onPick, onClose }: Props) {
  const [error, setError] = useState('');
  const fetchPage = useCallback(
    (q: { search: string; sort: UserMapSort; page: number; pageSize: number }) =>
      listCommunityMaps(q),
    [],
  );
  const loadPreview = useCallback((id: string) => getCommunityMapPreview(id), []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-slate-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-700 px-5 py-3">
          <h2 className="text-base font-semibold text-slate-100">社区地图</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-slate-700 px-2.5 py-1 text-sm text-slate-300 hover:bg-slate-600"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">
          {error ? (
            <div className="mb-3 rounded bg-red-900/50 px-3 py-2 text-sm text-red-200">{error}</div>
          ) : null}
          <MapGallery
            fetchPage={fetchPage}
            loadPreview={loadPreview}
            sorts={SORTS}
            defaultSort="recent"
            showLikes
            emptyText="还没有已发布的社区地图"
            renderActions={(meta, { close }) => (
              <button
                type="button"
                className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
                onClick={async () => {
                  setError('');
                  try {
                    const full = await getCommunityMap(meta.id);
                    onPick(full);
                    close();
                    onClose();
                  } catch (err) {
                    setError(err instanceof Error ? err.message : '地图加载失败');
                  }
                }}
              >
                立即游玩
              </button>
            )}
          />
        </div>
      </div>
    </div>
  );
}
