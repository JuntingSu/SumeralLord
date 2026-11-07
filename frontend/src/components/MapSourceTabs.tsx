export type MapSourceTab = 'official' | 'community';

interface Props {
  value: MapSourceTab;
  onChange: (value: MapSourceTab) => void;
  className?: string;
}

export default function MapSourceTabs({ value, onChange, className = '' }: Props) {
  const base = 'rounded px-3 py-1.5 text-sm transition-colors';
  return (
    <div className={`inline-flex rounded-lg bg-slate-800 p-0.5 ${className}`}>
      <button
        type="button"
        className={`${base} ${value === 'official' ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
        onClick={() => onChange('official')}
      >
        官方地图
      </button>
      <button
        type="button"
        className={`${base} ${value === 'community' ? 'bg-slate-600 text-white' : 'text-slate-400 hover:text-slate-200'}`}
        onClick={() => onChange('community')}
      >
        社区地图
      </button>
    </div>
  );
}
