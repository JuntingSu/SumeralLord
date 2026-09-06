import { useEffect, useState } from 'react';
import type { MapMeta } from '@dl/shared';

interface MapPickerProps {
  id?: string;
  maps: MapMeta[];
  /** 选中的 mapId；空串 = 未选中（输入内容不匹配当前选中时视为取消选中） */
  value: string;
  onChange: (mapId: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

/** 模糊匹配：输入串出现在 title、author 或任一 tag 中即命中（不区分大小写） */
function matchesQuery(m: MapMeta, query: string): boolean {
  const q = query.trim().toLowerCase();
  return [m.title, m.author, ...m.tags].some((t) => t.toLowerCase().includes(q));
}

/** 地图筛选选择器：输入过滤 title/author/tags，点选列表项确定 */
export default function MapPicker({ id, maps, value, onChange, disabled, placeholder }: MapPickerProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  // 外部 value 变化（如换图推送回填）时同步显示标题；清空为 '' 时不覆盖用户输入
  useEffect(() => {
    if (!value) return;
    const meta = maps.find((m) => m.id === value);
    if (meta) setQuery(meta.title);
  }, [value, maps]);

  const results = query.trim() ? maps.filter((m) => matchesQuery(m, query)) : maps;
  const selected = maps.find((m) => m.id === value);

  return (
    <div className="relative">
      <input
        id={id}
        className="w-full rounded bg-slate-700 px-3 py-2 pr-8 text-white outline-none focus:ring-2 focus:ring-emerald-500 disabled:opacity-50"
        value={query}
        disabled={disabled}
        autoComplete="off"
        placeholder={placeholder ?? '按地图名 / 作者 / 标签搜索'}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          const text = e.target.value;
          setQuery(text);
          if (selected && !matchesQuery(selected, text)) onChange('');
        }}
      />
      {query && !disabled && (
        <button
          type="button"
          aria-label="清空输入"
          title="清空输入"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            setQuery('');
            onChange('');
            setOpen(true);
          }}
          className="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full bg-slate-500/70 text-slate-200 transition-colors hover:bg-slate-400"
        >
          <svg viewBox="0 0 12 12" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
          </svg>
        </button>
      )}
      {open && !disabled && (
        <ul
          role="listbox"
          className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded bg-slate-700 py-1 shadow-lg"
        >
          {results.map((m) => (
            <li key={m.id} role="option" aria-selected={m.id === value}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(m.id);
                  setQuery(m.title);
                  setOpen(false);
                }}
                className={`block w-full px-3 py-2 text-left text-sm hover:bg-slate-600 ${
                  m.id === value ? 'bg-slate-600 text-emerald-300' : 'text-white'
                }`}
              >
                {m.title}（{m.playerNum}人）
              </button>
            </li>
          ))}
          {results.length === 0 && <li className="px-3 py-2 text-sm text-slate-400">无匹配的地图</li>}
        </ul>
      )}
    </div>
  );
}
