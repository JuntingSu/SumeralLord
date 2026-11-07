import { useEffect, useState } from 'react';
import type { MapMeta, MapPreview } from '@dl/shared';
import HexMapPreview from './HexMapPreview';

export type GalleryMapMeta = MapMeta & {
  updatedAt?: number;
  likes?: number;
  published?: boolean;
};

interface Props {
  meta: GalleryMapMeta;
  loadPreview: (id: string) => Promise<MapPreview>;
  onClick: () => void;
  /** 社区场景显示点赞数 */
  showLikes?: boolean;
}

const previewCache = new Map<string, MapPreview>();

export function formatEditTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = Date.now();
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleString('zh-CN', {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function MapCard({ meta, loadPreview, onClick, showLikes }: Props) {
  const [preview, setPreview] = useState<MapPreview | null>(previewCache.get(meta.id) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    if (previewCache.has(meta.id)) {
      setPreview(previewCache.get(meta.id)!);
      setFailed(false);
      return;
    }
    setPreview(null);
    setFailed(false);
    loadPreview(meta.id)
      .then((p) => {
        previewCache.set(meta.id, p);
        if (alive) setPreview(p);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [meta.id, loadPreview]);

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-800 text-left transition-colors hover:border-emerald-500 hover:bg-slate-700"
    >
      <div className="relative flex h-36 items-center justify-center overflow-hidden bg-slate-900/60">
        {preview ? (
          <div className="w-full px-2">
            <HexMapPreview
              battlefield={preview.battlefield}
              row={preview.row}
              column={preview.column}
              height={132}
            />
          </div>
        ) : failed ? (
          <span className="text-xs text-slate-500">预览不可用</span>
        ) : (
          <span className="text-xs text-slate-600">加载预览…</span>
        )}
        {showLikes && typeof meta.likes === 'number' && (
          <span className="absolute right-2 top-2 rounded bg-slate-900/85 px-1.5 py-0.5 text-[11px] text-rose-300">
            ♥ {meta.likes}
          </span>
        )}
        {meta.published !== undefined && (
          <span
            className={`absolute left-2 top-2 rounded px-1.5 py-0.5 text-[11px] ${
              meta.published ? 'bg-emerald-900/80 text-emerald-300' : 'bg-slate-900/80 text-slate-400'
            }`}
          >
            {meta.published ? '已发布' : '未发布'}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 px-3 py-2.5">
        <div className="truncate text-sm font-medium text-slate-100" title={meta.title}>
          {meta.title}
        </div>
        <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
          <span className="truncate">{meta.author || '未知作者'}</span>
          <span className="shrink-0">{meta.row}×{meta.column} · {meta.playerNum}人</span>
        </div>
        {meta.updatedAt ? (
          <div className="text-[11px] text-slate-500">最近编辑 {formatEditTime(meta.updatedAt)}</div>
        ) : null}
      </div>
    </button>
  );
}
