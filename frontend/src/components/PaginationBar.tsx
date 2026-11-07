import { useEffect, useState } from 'react';

interface Props {
  page: number;
  totalPages: number;
  onChange: (page: number) => void;
}

/** 页码条：< 1 2 3 ... 10 > [输入页码] */
export function PaginationBar({ page, totalPages, onChange }: Props) {
  const [jump, setJump] = useState(String(page));
  useEffect(() => setJump(String(page)), [page]);
  if (totalPages <= 1) return null;

  const pages: Array<number | '...'> = [];
  const push = (p: number | '...') => {
    if (pages[pages.length - 1] !== p) pages.push(p);
  };
  const windowStart = Math.max(1, page - 2);
  const windowEnd = Math.min(totalPages, page + 2);
  push(1);
  if (windowStart > 2) push('...');
  for (let p = Math.max(2, windowStart); p <= Math.min(totalPages - 1, windowEnd); p++) push(p);
  if (windowEnd < totalPages - 1) push('...');
  if (totalPages > 1) push(totalPages);

  const btn =
    'h-8 min-w-8 rounded px-2 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40';

  const submitJump = () => {
    const n = Number(jump);
    if (!Number.isInteger(n) || n < 1 || n > totalPages) {
      setJump(String(page));
      return;
    }
    if (n !== page) onChange(n);
  };

  return (
    <div className="flex flex-wrap items-center justify-center gap-1.5">
      <button
        type="button"
        className={`${btn} bg-slate-800 text-slate-300 hover:bg-slate-700`}
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
      >
        ‹
      </button>
      {pages.map((p, i) =>
        p === '...' ? (
          <span key={`e${i}`} className="px-1 text-sm text-slate-500">
            …
          </span>
        ) : (
          <button
            key={p}
            type="button"
            className={`${btn} ${
              p === page
                ? 'bg-emerald-600 text-white'
                : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
            onClick={() => p !== page && onChange(p)}
          >
            {p}
          </button>
        ),
      )}
      <button
        type="button"
        className={`${btn} bg-slate-800 text-slate-300 hover:bg-slate-700`}
        disabled={page >= totalPages}
        onClick={() => onChange(page + 1)}
      >
        ›
      </button>
      <span className="ml-2 flex items-center gap-1 text-xs text-slate-400">
        跳至
        <input
          value={jump}
          onChange={(e) => setJump(e.target.value.replace(/[^\d]/g, ''))}
          onBlur={submitJump}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitJump();
          }}
          inputMode="numeric"
          className="w-12 rounded bg-slate-800 px-2 py-1 text-center text-sm text-white outline-none focus:ring-2 focus:ring-emerald-500"
          aria-label="跳转页码"
        />
        页
      </span>
    </div>
  );
}
