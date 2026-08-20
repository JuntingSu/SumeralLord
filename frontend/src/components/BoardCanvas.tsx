// 双层 Canvas 棋盘（前端规划 §1.3）：底层静态层（地形+旗帜+兵力数字，dirty 重绘）、
// 上层动态层（hover/选中/光圈/迷雾，每帧）。尖顶六边形 odd-r（0 基奇数行右移），index 0 左下。
// 断兵视觉：过渡期用 globalCompositeOperation 擦边实现 2px 镂空（正式 hollow sprite 后补）。
import { useEffect, useRef, useCallback } from 'react';
import { TERRAIN, TILE_OWNER } from '@dl/shared';
import type { GameState, Phase } from '@dl/shared';
import { neighborsOf } from '@dl/shared';
import type { FogLevel } from '../game/fog';

const TERRAIN_COLORS: Record<number, string> = {
  [TERRAIN.PLAIN]: '#7cb342',
  [TERRAIN.CITY]: '#d4a017',
  [TERRAIN.OCEAN]: '#4fa3e3',
  [TERRAIN.MOUNTAIN]: '#a1887f',
  [TERRAIN.VOID]: '#263238',
};
const SEAT_COLORS = ['#e63946', '#457b9d', '#2a9d8f', '#e9c46a', '#8e44ad', '#d35400'];
const FOG_COLOR = 'rgba(10, 14, 20, 0.92)';
const EXPLORED_DIM = 'rgba(10, 14, 20, 0.45)';

const SQRT3 = Math.sqrt(3);

interface BoardCanvasProps {
  board: GameState;
  /** 视角归属（观战 null → 全图可见） */
  mySeat: number | null;
  isSpectator: boolean;
  fogEnabled: boolean;
  fogLevels: FogLevel[] | null;
  phase: Phase;
  selected: number | null;
  onTileClick: (tile: number) => void;
  onTileHover: (tile: number | null) => void;
  /** 地块按下（加点长按入口；行动阶段点击由 onTileClick 处理） */
  onTilePointerDown?: (tile: number) => void;
  onTilePointerUp?: () => void;
  className?: string;
}

interface View {
  scale: number;
  offX: number;
  offY: number;
}

function centerOf(index: number, column: number, size: number, offX: number, offY: number, totalH: number) {
  const r = Math.floor(index / column);
  const col = index % column;
  const hexW = SQRT3 * size;
  const cx = offX + hexW / 2 + col * hexW + (r % 2 === 1 ? hexW / 2 : 0);
  const cy = offY + totalH - (size + r * 1.5 * size);
  return { cx, cy };
}

/** 断兵 2px 镂空：擦除六边形外圈（过渡方案） */
function punchHollow(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  ctx.save();
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    const x = cx + size * Math.cos(angle);
    const y = cy + size * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.strokeStyle = 'rgba(0,0,0,1)';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.restore();
}

function hexPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    const x = cx + size * Math.cos(angle);
    const y = cy + size * Math.sin(angle);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

export default function BoardCanvas({
  board,
  mySeat,
  isSpectator,
  fogEnabled,
  fogLevels,
  phase,
  selected,
  onTileClick,
  onTileHover,
  onTilePointerDown,
  onTilePointerUp,
  className,
}: BoardCanvasProps) {
  const staticRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<View>({ scale: 1, offX: 0, offY: 0 });
  const hoverRef = useRef<number | null>(null);
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const spritesRef = useRef<Record<string, HTMLImageElement | null>>({});

  const geoRef = useRef({ rows: board.rows, columns: board.columns, cylindrical: board.cylindrical });

  const tileAtPointer = useCallback(
    (clientX: number, clientY: number): number | null => {
      const canvas = staticRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const { scale, offX, offY } = viewRef.current;
      const { rows, columns } = geoRef.current;
      // 尺寸参数与静态层绘制一致（画布 css 尺寸下计算）
      const cssW = rect.width;
      const cssH = rect.height;
      const pad = 8;
      const totalWUnits = SQRT3 * (columns + 0.5);
      const totalHUnits = 2 + 1.5 * (rows - 1);
      const size = Math.min((cssW - pad * 2) / totalWUnits, (cssH - pad * 2) / totalHUnits);
      const totalH = totalHUnits * size;
      const baseOffX = (cssW - totalWUnits * size) / 2;
      const baseOffY = (cssH - totalH) / 2;
      let best: number | null = null;
      let bestDist = Infinity;
      for (let i = 0; i < rows * columns; i++) {
        const c = centerOf(i, columns, size, baseOffX, baseOffY, totalH);
        const wx = offX + c.cx * scale;
        const wy = offY + c.cy * scale;
        const d = (x - wx) ** 2 + (y - wy) ** 2;
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      return best;
    },
    [],
  );

  // 静态层绘制（dirty 重绘）
  useEffect(() => {
    const canvas = staticRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const { rows, columns } = board;
    const pad = 8;
    const totalWUnits = SQRT3 * (columns + 0.5);
    const totalHUnits = 2 + 1.5 * (rows - 1);
    const size = Math.min((cssW - pad * 2) / totalWUnits, (cssH - pad * 2) / totalHUnits);
    const totalW = totalWUnits * size;
    const totalH = totalHUnits * size;
    const offX = (cssW - totalW) / 2;
    const offY = (cssH - totalH) / 2;
    viewRef.current = { scale: 1, offX: 0, offY: 0 };

    // 1. 地形底色
    for (let i = 0; i < board.tiles.length; i++) {
      const { cx, cy } = centerOf(i, columns, size, offX, offY, totalH);
      hexPath(ctx, cx, cy, size);
      ctx.fillStyle = TERRAIN_COLORS[board.tiles[i].terrain] ?? '#9e9e9e';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 2. 迷雾遮罩（hidden/explored）
    if (fogEnabled && fogLevels) {
      for (let i = 0; i < board.tiles.length; i++) {
        const { cx, cy } = centerOf(i, columns, size, offX, offY, totalH);
        const level = fogLevels[i];
        if (level === 'hidden') {
          hexPath(ctx, cx, cy, size);
          ctx.fillStyle = FOG_COLOR;
          ctx.fill();
        } else if (level === 'explored') {
          hexPath(ctx, cx, cy, size);
          ctx.fillStyle = EXPLORED_DIM;
          ctx.fill();
        }
      }
    }

    // 3. 据点归属圆点（中立/无主据点也标）——先画地形上的标记再画兵
    for (let i = 0; i < board.tiles.length; i++) {
      const t = board.tiles[i];
      if (t.terrain !== TERRAIN.CITY) continue;
      const belongs = t.soldier?.owner ?? TILE_OWNER.EMPTY;
      if (belongs === TILE_OWNER.EMPTY || belongs === TILE_OWNER.BLOCKER) continue;
      const { cx, cy } = centerOf(i, columns, size, offX, offY, totalH);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(2.5, size * 0.14), 0, Math.PI * 2);
      ctx.fillStyle = belongs === TILE_OWNER.WILD ? '#9e9e9e' : SEAT_COLORS[(belongs - 1) % SEAT_COLORS.length];
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 4. 旗帜 + 兵力数字（迷雾 explored 不画兵；hidden 不画）
    for (let i = 0; i < board.tiles.length; i++) {
      const soldier = board.tiles[i].soldier;
      if (!soldier) continue;
      if (fogEnabled && fogLevels && fogLevels[i] !== 'visible') continue;
      const { cx, cy } = centerOf(i, columns, size, offX, offY, totalH);
      const force = board.forces.find((f) => f.seat === soldier.owner);
      const flagNum = force ? force.flag : soldier.owner === TILE_OWNER.WILD ? 0 : 8;
      const flag = spritesRef.current[String(flagNum)];
      const flagW = size * 1.1;
      const flagH = size * 1.24;
      if (flag && flag.complete && flag.naturalWidth > 0) {
        ctx.drawImage(flag, cx - flagW / 2, cy - flagH / 2 - size * 0.12, flagW, flagH);
      } else {
        // 兜底：旗帜色块
        ctx.fillStyle = SEAT_COLORS[(soldier.owner - 1) % SEAT_COLORS.length] ?? '#888';
        ctx.fillRect(cx - size * 0.22, cy - size * 0.3, size * 0.44, size * 0.6);
      }
      // 断兵 2px 镂空（过渡方案）
      if (!soldier.isLinked) punchHollow(ctx, cx, cy, size * 0.52);
      // 兵力数字
      ctx.font = `bold ${Math.max(10, size * 0.5)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#111';
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2.5;
      ctx.strokeText(String(soldier.strength), cx, cy + size * 0.52);
      ctx.fillText(String(soldier.strength), cx, cy + size * 0.52);
    }
  }, [board, fogEnabled, fogLevels]);

  // 旗帜 sprite 预加载
  useEffect(() => {
    const load = (n: number) => {
      if (spritesRef.current[String(n)] !== undefined) return;
      const img = new Image();
      img.src = `/static/flags/flag_${n}.png`;
      spritesRef.current[String(n)] = img;
    };
    for (let n = 1; n <= 9; n++) load(n);
  }, []);

  // 动态层：hover / 选中 / 行动阶段反击着色 / 加点阶段连兵高亮，每帧
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const canvas = overlayRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) {
        const cssW = canvas.clientWidth;
        const cssH = canvas.clientHeight;
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(cssW * dpr)) {
          canvas.width = Math.round(cssW * dpr);
          canvas.height = Math.round(cssH * dpr);
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        const { rows, columns } = board;
        const pad = 8;
        const totalWUnits = SQRT3 * (columns + 0.5);
        const totalHUnits = 2 + 1.5 * (rows - 1);
        const size = Math.min((cssW - pad * 2) / totalWUnits, (cssH - pad * 2) / totalHUnits);
        const totalH = totalHUnits * size;
        const offX = (cssW - totalWUnits * size) / 2;
        const offY = (cssH - totalH) / 2;

        const isMyTurn = mySeat !== null && board.currentSeat === mySeat && !isSpectator;

        // 行动阶段：选中兵 → 周围地块反击状态着色 + 可选目标高亮
        if (selected !== null && phase === 'ACTION' && isMyTurn) {
          const sel = board.tiles[selected].soldier;
          if (sel && sel.owner === mySeat) {
            const geo = { rows, columns, cylindrical: board.cylindrical };
            for (const n of neighborsOf(selected, geo)) {
              const t = board.tiles[n];
              const c = centerOf(n, columns, size, offX, offY, totalH);
              hexPath(ctx, c.cx, c.cy, size);
              if (!t.soldier) {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
                ctx.fill();
              } else if (t.soldier.owner === mySeat) {
                ctx.fillStyle = 'rgba(120, 120, 130, 0.25)';
                ctx.fill();
              } else {
                // 非同队：反击>0 红 / =0 白
                ctx.fillStyle = t.soldier.counter > 0 ? 'rgba(230, 57, 70, 0.35)' : 'rgba(255, 255, 255, 0.3)';
                ctx.fill();
              }
            }
          }
        }
        // 加点阶段：己方连兵白色数字高亮
        if (phase === 'ADD_POINT' && isMyTurn) {
          const force = board.forces.find((f) => f.seat === mySeat);
          if (force && force.points > 0) {
            for (let i = 0; i < board.tiles.length; i++) {
              const s = board.tiles[i].soldier;
              if (!s || s.owner !== mySeat || !s.isLinked) continue;
              if (fogEnabled && fogLevels && fogLevels[i] !== 'visible') continue;
              const c = centerOf(i, columns, size, offX, offY, totalH);
              ctx.font = `bold ${Math.max(10, size * 0.5)}px sans-serif`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillStyle = '#ffffff';
              ctx.strokeStyle = 'rgba(0,0,0,0.7)';
              ctx.lineWidth = 2;
              ctx.strokeText(String(s.strength), c.cx, c.cy + size * 0.52);
              ctx.fillText(String(s.strength), c.cx, c.cy + size * 0.52);
            }
          }
        }
        // 选中光圈
        if (selected !== null) {
          const c = centerOf(selected, columns, size, offX, offY, totalH);
          ctx.beginPath();
          ctx.arc(c.cx, c.cy, size * 0.78, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255, 235, 59, 0.9)';
          ctx.lineWidth = 2.5;
          ctx.stroke();
        }
        // hover 描边
        if (hoverRef.current !== null && hoverRef.current !== selected) {
          const c = centerOf(hoverRef.current, columns, size, offX, offY, totalH);
          hexPath(ctx, c.cx, c.cy, size);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [board, selected, phase, mySeat, isSpectator, fogEnabled, fogLevels]);

  return (
    <div className={className} style={{ position: 'relative', overflow: 'hidden' }}>
      <canvas
        ref={staticRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
        onPointerDown={(e) => {
          const tile = tileAtPointer(e.clientX, e.clientY);
          if (tile !== null) {
            if (onTilePointerDown) onTilePointerDown(tile);
            else onTileClick(tile);
          }
          dragRef.current = { x: e.clientX, y: e.clientY, ox: 0, oy: 0 };
        }}
        onPointerUp={() => onTilePointerUp?.()}
        onPointerMove={(e) => {
          const tile = tileAtPointer(e.clientX, e.clientY);
          if (tile !== hoverRef.current) {
            hoverRef.current = tile;
            onTileHover(tile);
          }
        }}
        onPointerLeave={() => {
          hoverRef.current = null;
          onTileHover(null);
        }}
      />
      <canvas ref={overlayRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }} />
    </div>
  );
}
