import { useEffect, useState } from 'react';

/** 窄屏判定与 Tailwind 的 lg 断点一致：宽度 < 1024px 时为窄屏 */
const NARROW_QUERY = '(max-width: 1023px)';

function matchesNarrow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(NARROW_QUERY).matches
    : false;
}

/** 订阅视口窄屏状态：窄屏 UI 与非窄屏 UI 需要分别渲染时使用 */
export function useNarrowScreen(): boolean {
  const [narrow, setNarrow] = useState(matchesNarrow);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(NARROW_QUERY);
    const onChange = () => setNarrow(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return narrow;
}
