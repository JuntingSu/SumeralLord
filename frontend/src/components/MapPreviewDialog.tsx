import { useEffect, useState } from 'react';
import type { MapPreview } from '@dl/shared';
import HexMapPreview from './HexMapPreview';
import { formatEditTime, type GalleryMapMeta } from './MapCard';

interface Props {
  meta: GalleryMapMeta;
  loadPreview: (id: string) => Promise<MapPreview>;
  onClose: () => void;
  actions: React.ReactNode;
  showLikes?: boolean;
}

export function MapPreviewDialog({ meta, loadPreview, onClose, actions, showLikes }: Props) {
  const [preview, setPreview] = useState<MapPreview | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    loadPreview(meta.id)
      .then((p) => alive && setPreview(p))
      .catch(() => alive && setError('预览加载失败'));
    return () => {
      alive = false;
    };
  }, [meta.id, loadPreview]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`地图预览：${meta.title}`}
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-slate-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-700 px-5 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-slate-100">{meta.title}</h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
              <span>{meta.author || '未知作者'}</span>
              <span>{meta.row}×{meta.column} · {meta.playerNum} 人</span>
              {meta.updatedAt ? <span>最近编辑 {formatEditTime(meta.updatedAt)}</span> : null}
              {showLikes && typeof meta.likes === 'number' ? (
                <span className="text-rose-300">♥ {meta.likes}</span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded bg-slate-700 px-2.5 py-1 text-sm text-slate-300 hover:bg-slate-600"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {preview ? (
            <HexMapPreview
              battlefield={preview.battlefield}
              row={preview.row}
              column={preview.column}
              height={420}
            />
          ) : (
            <div className="flex h-64 items-center justify-center text-sm text-slate-500">
              {error || '加载预览…'}
            </div>
          )}
          {meta.description ? (
            <p className="mt-3 whitespace-pre-wrap text-sm text-slate-300">{meta.description}</p>
          ) : null}
          {meta.tags.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {meta.tags.map((t) => (
                <span key={t} className="rounded bg-slate-700 px-2 py-0.5 text-[11px] text-slate-300">
                  {t}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-700 px-5 py-3">
          {actions}
        </div>
      </div>
    </div>
  );
}
