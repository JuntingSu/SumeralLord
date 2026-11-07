import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MapPreview, UserMapListResult, UserMapSort } from '@dl/shared';
import { MapCard, type GalleryMapMeta } from './MapCard';
import { MapPreviewDialog } from './MapPreviewDialog';
import { PaginationBar } from './PaginationBar';

export interface MapGallerySort {
  value: UserMapSort;
  label: string;
}

interface Props {
  /** 必须用 useCallback 保持稳定，避免重复请求 */
  fetchPage: (q: {
    search: string;
    sort: UserMapSort;
    page: number;
    pageSize: number;
  }) => Promise<UserMapListResult>;
  loadPreview: (id: string) => Promise<MapPreview>;
  sorts: MapGallerySort[];
  defaultSort?: UserMapSort;
  /** 弹窗底部动作按钮；close 用于操作完成后关闭弹窗 */
  renderActions: (meta: GalleryMapMeta, helpers: { close: () => void }) => ReactNode;
  showLikes?: boolean;
  emptyText?: string;
  /** 父级数据变化时递增以刷新 */
  refreshKey?: number;
}

function columnsForWidth(width: number): number {
  if (width >= 1000) return 3;
  if (width >= 640) return 2;
  return 1;
}

export function MapGallery({
  fetchPage,
  loadPreview,
  sorts,
  defaultSort = 'recent',
  renderActions,
  showLikes,
  emptyText = '还没有地图',
  refreshKey = 0,
}: Props) {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<UserMapSort>(defaultSort);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const [result, setResult] = useState<UserMapListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<GalleryMapMeta | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    const update = () => {
      const cols = columnsForWidth(el.clientWidth);
      const next = cols * 4;
      setPageSize((prev) => (prev === next ? prev : next));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    fetchPage({ search, sort, page, pageSize })
      .then((r) => {
        if (!alive) return;
        setResult(r);
        const totalPages = Math.max(1, Math.ceil(r.total / r.pageSize));
        if (r.page > totalPages) setPage(totalPages);
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : '地图加载失败');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [fetchPage, search, sort, page, pageSize, refreshKey]);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil((result?.total ?? 0) / Math.max(1, result?.pageSize ?? pageSize))),
    [result, pageSize],
  );
  const columns = Math.max(1, Math.round(pageSize / 4));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <input
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          placeholder="搜索地图名 / tag"
          className="w-full max-w-xs rounded bg-slate-800 px-3 py-2 text-sm text-white outline-none ring-1 ring-slate-700 focus:ring-2 focus:ring-emerald-500"
        />
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <span>排序</span>
          <select
            value={sort}
            onChange={(e) => {
              setSort(e.target.value as UserMapSort);
              setPage(1);
            }}
            className="rounded bg-slate-800 px-2 py-1.5 text-sm text-slate-200 outline-none ring-1 ring-slate-700 focus:ring-2 focus:ring-emerald-500"
          >
            {sorts.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div
        ref={gridRef}
        className="grid gap-3"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {result?.mapList.map((m) => (
          <MapCard
            key={m.id}
            meta={m}
            loadPreview={loadPreview}
            showLikes={showLikes}
            onClick={() => setSelected(m)}
          />
        ))}
      </div>

      {loading && !result && (
        <div className="py-12 text-center text-sm text-slate-500">加载地图…</div>
      )}
      {!loading && error && (
        <div className="rounded bg-red-900/40 px-3 py-2 text-sm text-red-200">{error}</div>
      )}
      {!loading && !error && result && result.mapList.length === 0 && (
        <div className="py-12 text-center text-sm text-slate-500">{emptyText}</div>
      )}

      <div className="flex flex-col items-center gap-2">
        <PaginationBar page={page} totalPages={totalPages} onChange={setPage} />
        {result ? (
          <span className="text-xs text-slate-500">共 {result.total} 张地图</span>
        ) : null}
      </div>

      {selected && (
        <MapPreviewDialog
          meta={selected}
          loadPreview={loadPreview}
          showLikes={showLikes}
          onClose={() => setSelected(null)}
          actions={renderActions(selected, { close: () => setSelected(null) })}
        />
      )}
    </div>
  );
}
