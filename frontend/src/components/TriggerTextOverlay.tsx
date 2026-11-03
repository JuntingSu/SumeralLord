// 战役触发器文本展示：8 个屏幕方位（固定） + 绑定地块的方形气泡（随棋盘平移/缩放）。
import type { ReactNode } from 'react';
import type { TextPlacement, TextScreenPosition } from '@dl/shared';
import { TEXT_SCREEN_POSITIONS } from '@dl/shared';

export interface TriggerTextItem {
  textId: string;
  text: string;
  placement?: TextPlacement;
}

const SCREEN_CLASSES: Record<TextScreenPosition, string> = {
  top: 'left-1/2 top-16 -translate-x-1/2 items-center',
  bottom: 'left-1/2 bottom-16 -translate-x-1/2 items-center',
  left: 'left-3 top-1/2 -translate-y-1/2 items-start',
  right: 'right-3 top-1/2 -translate-y-1/2 items-end',
  'top-left': 'left-3 top-16 items-start',
  'top-right': 'right-3 top-16 items-end',
  'bottom-left': 'left-3 bottom-16 items-start',
  'bottom-right': 'right-3 bottom-16 items-end',
};

const CARD =
  'pointer-events-auto rounded-lg border border-amber-600/60 bg-slate-800/95 px-3 py-2 text-sm text-amber-100 shadow-lg';

function TextCard({
  item,
  onDismiss,
}: {
  item: TriggerTextItem;
  onDismiss: (textId: string) => void;
}) {
  return (
    <div className={CARD}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 text-amber-400" aria-hidden="true">
          📜
        </span>
        <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{item.text}</p>
        <button
          type="button"
          onClick={() => onDismiss(item.textId)}
          className="shrink-0 text-slate-400 hover:text-white"
          aria-label="关闭"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function emptyScreenGroups(): Record<TextScreenPosition, TriggerTextItem[]> {
  return {
    top: [],
    bottom: [],
    left: [],
    right: [],
    'top-left': [],
    'top-right': [],
    'bottom-left': [],
    'bottom-right': [],
  };
}

/** 屏幕方位文本（fixed 到视口；缺省右上角） */
export function TriggerScreenTexts({
  texts,
  onDismiss,
}: {
  texts: TriggerTextItem[];
  onDismiss: (textId: string) => void;
}) {
  const groups = emptyScreenGroups();
  for (const t of texts) {
    const pos = t.placement?.kind === 'screen' ? t.placement.position : 'top-right';
    groups[pos].push(t);
  }
  return (
    <>
      {TEXT_SCREEN_POSITIONS.map((pos) => {
        const items = groups[pos];
        if (items.length === 0) return null;
        return (
          <div
            key={pos}
            className={`pointer-events-none fixed z-40 flex w-[min(22rem,calc(100vw-1.5rem))] flex-col gap-2 ${SCREEN_CLASSES[pos]}`}
          >
            {items.map((item) => (
              <TextCard key={item.textId} item={item} onDismiss={onDismiss} />
            ))}
          </div>
        );
      })}
    </>
  );
}

export interface TileScreenPosition {
  x: number;
  y: number;
  r: number;
}

/** 绑定地块的方形气泡（渲染在 BoardCanvas 的 overlay 中，坐标相对画布） */
export function TriggerTileBubbles({
  texts,
  positionOf,
  viewport,
  onDismiss,
}: {
  texts: TriggerTextItem[];
  positionOf: (tile: number) => TileScreenPosition | null;
  viewport: { w: number; h: number };
  onDismiss: (textId: string) => void;
}) {
  const groups = new Map<number, TriggerTextItem[]>();
  for (const t of texts) {
    if (t.placement?.kind !== 'tile') continue;
    const list = groups.get(t.placement.tile) ?? [];
    list.push(t);
    groups.set(t.placement.tile, list);
  }

  const nodes: ReactNode[] = [];
  for (const [tile, items] of groups) {
    const pos = positionOf(tile);
    if (!pos) continue;
    const above = pos.y > 150;
    // 让气泡尽量留在画布内（宽度上限 18rem，半宽约 144px）
    const half = Math.min(150, Math.max(0, viewport.w / 2 - 8));
    const x = Math.min(Math.max(pos.x, half + 8), Math.max(half + 8, viewport.w - half - 8));
    nodes.push(
      <div key={tile} className="pointer-events-none absolute z-30" style={{ left: x, top: pos.y }}>
        <div
          className="absolute left-0 h-2.5 w-2.5 -translate-x-1/2 rotate-45 border border-amber-600/60 bg-slate-800"
          style={{ top: above ? -6 : 2 }}
          aria-hidden="true"
        />
        <div
          className="absolute left-0 flex w-max max-w-[min(18rem,calc(100vw-1.5rem))] -translate-x-1/2 flex-col gap-1"
          style={above ? { bottom: 12 } : { top: 12 }}
        >
          {items.map((item) => (
            <TextCard key={item.textId} item={item} onDismiss={onDismiss} />
          ))}
        </div>
      </div>,
    );
  }
  return <>{nodes}</>;
}
