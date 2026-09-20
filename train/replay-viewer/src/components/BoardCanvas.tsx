// 双层 Canvas 棋盘（前端规划 §1.3，M5.1 动画版 + M5.2 交互版）：
// 底层静态层（地形+迷雾+据点圆点，dirty 重绘）、上层动态层（兵+动画中间帧+hover/选中/光圈/高亮，每帧）。
// 兵全部画在 overlay：动画播放时画"动画态+中间帧"（EventAnimator 驱动），空闲时画权威 board。
// M5.2：拖拽平移 + 滚轮锚点缩放（0.3x~4x）+ 双击复位（view 变换统一应用于两层与拾取）；
// 断兵视觉正式化：flag_{n}_hollow.png 镂空 sprite（未加载完成时回退 punchHollow 擦边）。
import { useEffect, useLayoutEffect, useMemo, useRef, useCallback, useState } from 'react';
import { TERRAIN, TILE_OWNER } from '@dl/shared';
import type { GameState, Phase, SoldierState } from '@dl/shared';
import { neighborsOf } from '@dl/shared';
import type { FogLevel } from '../game/fog';
import type { EventAnimator } from '../canvas/animator';
import { flagImgUrl, flagHollowImgUrl } from '../lib/flags';

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

type FlashKind = 'clear' | 'break' | 'rejoin' | 'victory';
const FLASH_COLORS: Record<FlashKind, string> = {
  clear: 'rgba(230, 57, 70, 0.85)',
  break: 'rgba(230, 57, 70, 0.85)',
  rejoin: 'rgba(42, 157, 143, 0.9)',
  victory: 'rgba(233, 196, 106, 0.95)',
};

const SQRT3 = Math.sqrt(3);
/** 拖拽阈值（px）：位移超过视为拖拽而非点击/长按 */
const DRAG_THRESHOLD = 4;
const MIN_SCALE = 0.3;
const MAX_SCALE = 4;
/** 地块间隔：绘制六边形半径相对布局边长的缩小比例（≈4% 边长），仅对局内棋盘生效 */
const TILE_GAP = 0.04;
/** 旗帜图片内六边形外接圆半径（与 backend/scripts/gen-flags.mjs 的 R=100 耦合，改动需同步） */
const FLAG_IMG_HEX_R = 100;
/** 连兵旗帜覆盖放大系数：略大于地块本体以盖住抗锯齿接缝，不侵占间隔 */
const FLAG_COVER = 1.02;

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
  /** M5.1：动画播放器实例（Game 页注入；null = 无动画直渲 board） */
  animatorRef?: React.MutableRefObject<EventAnimator | null> | null;
  className?: string;
}

interface View {
  scale: number;
  offX: number;
  offY: number;
}

interface DragState {
  x: number;
  y: number;
  startX: number;
  startY: number;
  moved: boolean;
}

interface SpriteEntry {
  solid: HTMLImageElement | null;
  hollow: HTMLImageElement | null;
}

function centerOf(index: number, column: number, size: number, offX: number, offY: number, totalH: number) {
  const r = Math.floor(index / column);
  const col = index % column;
  const hexW = SQRT3 * size;
  const cx = offX + hexW / 2 + col * hexW + (r % 2 === 1 ? hexW / 2 : 0);
  const cy = offY + totalH - (size + r * 1.5 * size);
  return { cx, cy };
}

/** 棋盘布局：由画布 CSS 尺寸与行列数计算六边形边长与居中偏移。静态层、动态层与拾取共用同一几何，避免两层错位。 */
function computeLayout(cssW: number, cssH: number, rows: number, columns: number) {
  const pad = 8;
  const totalWUnits = SQRT3 * (columns + 0.5);
  const totalHUnits = 2 + 1.5 * (rows - 1);
  const size = Math.min((cssW - pad * 2) / totalWUnits, (cssH - pad * 2) / totalHUnits);
  const totalW = totalWUnits * size;
  const totalH = totalHUnits * size;
  return { size, offX: (cssW - totalW) / 2, offY: (cssH - totalH) / 2, totalH };
}

/** 断兵 2px 镂空（过渡方案；hollow sprite 未加载时回退） */
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
  animatorRef,
  className,
}: BoardCanvasProps) {
  const staticRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const hoverRef = useRef<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const spritesRef = useRef<Record<string, SpriteEntry>>({});

  // M5.2：视图变换（缩放/平移）。viewRef 为实时权威值（拖拽/滚轮直接改，rAF 层与拾取每帧读取）；
  // view state 仅是 viewRef 的 rAF 节流镜像，用于触发静态层重绘。
  // 注：逐事件 setState 在浏览器输入管线中提交不可靠（同一手势只有首个事件生效），故用 ref+rAF 同步。
  const viewRef = useRef<View>({ scale: 1, offX: 0, offY: 0 });
  const [view, setView] = useState<View>(viewRef.current);
  const viewSyncRaf = useRef(0);
  const syncView = () => {
    if (viewSyncRaf.current) return;
    viewSyncRaf.current = requestAnimationFrame(() => {
      viewSyncRaf.current = 0;
      setView({ ...viewRef.current });
    });
  };
  useEffect(() => () => cancelAnimationFrame(viewSyncRaf.current), []);

  const geoRef = useRef({ rows: board.rows, columns: board.columns, cylindrical: board.cylindrical });

  const containerRef = useRef<HTMLDivElement>(null);
  /** 画布 CSS 尺寸 + DPR：静态层/动态层/拾取共用同一尺寸源，任何变化都触发两层按新几何重绘 */
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0, dpr: 1 });

  // 画布尺寸 / DPR 跟踪。静态层原先只在 view/board 变化时重绘，改窗口大小（桌面）或移动端浏览器
  // UI 收起/DPR 变化后位图停留在旧尺寸被 CSS 拉伸，与每帧自适应的动态层错位；这里统一由
  // ResizeObserver + 窗口 resize + DPR 监听驱动，使两层始终使用同一份几何。
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      setCanvasSize((prev) => (prev.w === w && prev.h === h && prev.dpr === dpr ? prev : { w, h, dpr }));
    };
    update();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(update);
      ro.observe(el);
    }
    window.addEventListener('resize', update);
    // 移动端浏览器 UI 收起/展开或缩放时 devicePixelRatio 可能变化（尺寸不变时 ResizeObserver 不触发），单独监听；
    // 旧 iOS Safari(<14)/部分 WebView 只支持 addListener，addEventListener 会静默失效
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    if (mq.addEventListener) mq.addEventListener('change', update);
    else mq.addListener?.(update);
    window.visualViewport?.addEventListener('resize', update);
    // 个别 WebView 旋转/浏览器 UI 变化不触发 ResizeObserver，补 orientationchange 驱动重算
    window.addEventListener('orientationchange', update);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', update);
      if (mq.removeEventListener) mq.removeEventListener('change', update);
      else mq.removeListener?.(update);
      window.visualViewport?.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  /** owner → 旗帜编号（预计算；野生 0 无 sprite 走色块兜底，阻挡/未知用 8） */
  const flagOf = useMemo(() => {
    const map = new Map<number, number>();
    for (const f of board.forces) map.set(f.seat, f.flag);
    return (owner: number): number => map.get(owner) ?? (owner === TILE_OWNER.WILD ? 0 : 8);
  }, [board.forces]);

  /** 空闲时（无动画）渲染的权威兵表 */
  const boardSoldiers = useMemo<Array<SoldierState | null>>(
    () => board.tiles.map((t) => t.soldier),
    [board.tiles],
  );

  /** 胜利常显：胜方 seat 集合（对局结束后金色高亮） */
  const victorySeats = useMemo(() => {
    if (!board.finished || board.winningTeam === null) return [];
    return board.forces.filter((f) => f.exists && f.team === board.winningTeam).map((f) => f.seat);
  }, [board.finished, board.winningTeam, board.forces]);

  const tileAtPointer = useCallback(
    (clientX: number, clientY: number): number | null => {
      const canvas = staticRef.current;
      if (!canvas) return null;
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      const { scale, offX, offY } = viewRef.current;
      const { rows, columns } = geoRef.current;
      // 拾取与静态/动态层共用同一布局几何（画布 css 尺寸下计算）
      const L = computeLayout(rect.width, rect.height, rows, columns);
      let best: number | null = null;
      let bestDist = Infinity;
      for (let i = 0; i < rows * columns; i++) {
        const c = centerOf(i, columns, L.size, L.offX, L.offY, L.totalH);
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

  // 滚轮缩放（以指针为锚点；原生 listener 以 preventDefault 阻止页面滚动）
  useEffect(() => {
    const canvas = staticRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const v = viewRef.current;
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor));
      const k = scale / v.scale;
      viewRef.current = { scale, offX: px - (px - v.offX) * k, offY: py - (py - v.offY) * k };
      syncView();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  // 静态层绘制（dirty 重绘，view 变化时重绘）：地形 + 迷雾遮罩 + 据点归属圆点（兵在 overlay 层）
  useEffect(() => {
    const canvas = staticRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { w: cssW, h: cssH, dpr } = canvasSize;
    if (cssW === 0 || cssH === 0) return;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const { rows, columns } = board;
    const L = computeLayout(cssW, cssH, rows, columns);
    const { size, offX, offY, totalH } = L;
    // 地块间隔：绘制半径缩小，相邻地块之间留缝（布局/拾取仍用 size）
    const ts = size * (1 - TILE_GAP);
    // M5.2：视图变换
    const tx = (c: { cx: number; cy: number }) => ({ cx: view.offX + c.cx * view.scale, cy: view.offY + c.cy * view.scale });

    // 1. 地形底色
    for (let i = 0; i < board.tiles.length; i++) {
      const c = tx(centerOf(i, columns, size, offX, offY, totalH));
      hexPath(ctx, c.cx, c.cy, ts * view.scale);
      ctx.fillStyle = TERRAIN_COLORS[board.tiles[i].terrain] ?? '#9e9e9e';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 2. 迷雾遮罩（hidden/explored）
    if (fogEnabled && fogLevels) {
      for (let i = 0; i < board.tiles.length; i++) {
        const c = tx(centerOf(i, columns, size, offX, offY, totalH));
        const level = fogLevels[i];
        if (level === 'hidden') {
          hexPath(ctx, c.cx, c.cy, ts * view.scale);
          ctx.fillStyle = FOG_COLOR;
          ctx.fill();
        } else if (level === 'explored') {
          hexPath(ctx, c.cx, c.cy, ts * view.scale);
          ctx.fillStyle = EXPLORED_DIM;
          ctx.fill();
        }
      }
    }

    // 3. 据点归属圆点（中立/无主据点也标）
    for (let i = 0; i < board.tiles.length; i++) {
      const t = board.tiles[i];
      if (t.terrain !== TERRAIN.CITY) continue;
      const belongs = t.soldier?.owner ?? TILE_OWNER.EMPTY;
      if (belongs === TILE_OWNER.EMPTY || belongs === TILE_OWNER.BLOCKER) continue;
      const c = tx(centerOf(i, columns, size, offX, offY, totalH));
      ctx.beginPath();
      ctx.arc(c.cx, c.cy, Math.max(2.5, size * 0.14) * view.scale, 0, Math.PI * 2);
      ctx.fillStyle = belongs === TILE_OWNER.WILD ? '#9e9e9e' : SEAT_COLORS[(belongs - 1) % SEAT_COLORS.length];
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }, [board, fogEnabled, fogLevels, view, canvasSize]);

  // 旗帜 sprite 预加载（实心 + 镂空；flag 为负数 → 个人皮肤 usr_{-flag}，加载失败自然走色块/擦边兜底）
  useEffect(() => {
    const load = (n: number) => {
      if (spritesRef.current[String(n)] !== undefined) return;
      const solid = new Image();
      solid.src = flagImgUrl(n);
      const hollow = new Image();
      hollow.src = flagHollowImgUrl(n);
      spritesRef.current[String(n)] = { solid, hollow };
    };
    for (let n = 1; n <= 30; n++) load(n);
    for (const f of board.forces) load(f.flag);
  }, [board.forces]);

  /** 画单个兵（旗帜 sprite + 兵力数字 + 闪光描边；hollow=true 用镂空 sprite 露出地形，未加载时擦边回退） */
  const drawSoldier = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      cx: number,
      cy: number,
      size: number,
      soldier: SoldierState,
      flagNum: number,
      alpha: number,
      flash: FlashKind | null,
      hollow: boolean,
    ) => {
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
      const entry = spritesRef.current[String(flagNum)];
      const img = hollow ? entry?.hollow : entry?.solid;
      // 旗帜按图片内六边形（FLAG_IMG_HEX_R）等比放大到地块本体（含小幅覆盖），中心对准地块中心
      const scale = (size * (1 - TILE_GAP) * FLAG_COVER) / FLAG_IMG_HEX_R;
      if (img && img.complete && img.naturalWidth > 0) {
        const flagW = img.naturalWidth * scale;
        const flagH = img.naturalHeight * scale;
        ctx.drawImage(img, cx - flagW / 2, cy - flagH / 2, flagW, flagH);
      } else {
        // 兜底：旗帜色块
        ctx.fillStyle = SEAT_COLORS[(soldier.owner - 1) % SEAT_COLORS.length] ?? '#888';
        ctx.fillRect(cx - size * 0.22, cy - size * 0.3, size * 0.44, size * 0.6);
      }
      // hollow sprite 未就绪时用擦边过渡方案（沿地块边缘擦出环带）
      if (hollow && (!entry?.hollow || !entry.hollow.complete || entry.hollow.naturalWidth === 0)) {
        punchHollow(ctx, cx, cy, size * (1 - TILE_GAP));
      }
      // 兵力数字：地块正中心（旗帜上方）
      ctx.font = `bold ${Math.max(10, size * 0.5)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#111';
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2.5;
      ctx.strokeText(String(soldier.strength), cx, cy);
      ctx.fillText(String(soldier.strength), cx, cy);
      ctx.restore();
      // 闪光描边（不受兵透明度影响）
      if (flash) {
        hexPath(ctx, cx, cy, size * (1 - TILE_GAP) * 0.92);
        ctx.strokeStyle = FLASH_COLORS[flash];
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    },
    [],
  );

  // 动态层：动画帧兵表 + hover / 选中 / 高亮，每帧（视图变换实时读 viewRef）
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      const now = performance.now();
      const canvas = overlayRef.current;
      const ctx = canvas?.getContext('2d');
      if (canvas && ctx) {
        const { w: cssW, h: cssH, dpr } = canvasSize;
        if (cssW === 0 || cssH === 0) return; // 尺寸未就绪，下一帧再画
        // 位图宽或高任一与目标不匹配即同时重置：移动端竖屏地址栏收起/浏览器 UI 变化时
        // 容器「高度变、宽度不变」，若只判宽度会停留在旧高度位图被 CSS 纵向拉伸，与静态层地块错位
        const bw = Math.round(cssW * dpr);
        const bh = Math.round(cssH * dpr);
        if (canvas.width !== bw || canvas.height !== bh) {
          canvas.width = bw;
          canvas.height = bh;
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cssW, cssH);
        const { rows, columns } = board;
        const L = computeLayout(cssW, cssH, rows, columns);
        const { size, offX, offY, totalH } = L;
        const ts = size * (1 - TILE_GAP);
        const v = viewRef.current;
        const tx = (c: { cx: number; cy: number }) => ({ cx: v.offX + c.cx * v.scale, cy: v.offY + c.cy * v.scale });

        // 动画帧（M5.1）：播放中画动画态+中间帧，空闲画权威 board
        const af = animatorRef?.current?.frame(now) ?? null;
        const ev = af?.event ?? null;
        const progress = af?.progress ?? 0;
        const showTiles = af ? af.tiles : boardSoldiers;

        const isMyTurn = mySeat !== null && board.currentSeat === mySeat && !isSpectator;

        // 行动阶段：选中兵 → 周围地块反击状态着色 + 可选目标高亮（兵之下）
        if (selected !== null && phase === 'ACTION' && isMyTurn) {
          const sel = board.tiles[selected].soldier;
          if (sel && sel.owner === mySeat) {
            const geo = { rows, columns, cylindrical: board.cylindrical };
            for (const n of neighborsOf(selected, geo)) {
              const t = board.tiles[n];
              const c = tx(centerOf(n, columns, size, offX, offY, totalH));
              hexPath(ctx, c.cx, c.cy, ts * v.scale);
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
        // 加点阶段：己方连兵白色数字高亮（兵之上）
        const addPointHighlights = new Set<number>();
        if (phase === 'ADD_POINT' && isMyTurn) {
          const force = board.forces.find((f) => f.seat === mySeat);
          if (force && force.points > 0) {
            for (let i = 0; i < board.tiles.length; i++) {
              const s = board.tiles[i].soldier;
              if (!s || s.owner !== mySeat || !s.isLinked) continue;
              if (fogEnabled && fogLevels && fogLevels[i] !== 'visible') continue;
              addPointHighlights.add(i);
            }
          }
        }

        // 兵主循环（动画中间帧在循环内特判）
        for (let i = 0; i < board.tiles.length; i++) {
          if (fogEnabled && fogLevels && fogLevels[i] !== 'visible') continue;
          const soldier = showTiles[i];
          if (!soldier) continue;
          // 据点特殊化：据点的连兵也按断兵（镂空）渲染，露出据点地形
          const hollow = !soldier.isLinked || board.tiles[i].terrain === TERRAIN.CITY;
          const c = tx(centerOf(i, columns, size, offX, offY, totalH));
          // MOVE：起点兵沿 from→to 插值滑动
          if (ev?.kind === 'MOVE' && ev.from === i) {
            const tc = tx(centerOf(ev.to, columns, size, offX, offY, totalH));
            drawSoldier(
              ctx,
              c.cx + (tc.cx - c.cx) * progress,
              c.cy + (tc.cy - c.cy) * progress,
              size * v.scale,
              soldier,
              flagOf(soldier.owner),
              1,
              null,
              hollow,
            );
            continue;
          }
          // DESPAWN：淡出
          if (ev?.kind === 'DESPAWN' && ev.tile === i) {
            drawSoldier(ctx, c.cx, c.cy, size * v.scale, soldier, flagOf(soldier.owner), 1 - progress, null, hollow);
            continue;
          }
          // 闪光判定
          let flash: FlashKind | null = null;
          if (af && af.clearingSeats.includes(soldier.owner)) flash = 'clear';
          else if (af && af.breakTiles.includes(i)) flash = 'break';
          else if (ev?.kind === 'REJOIN' && ev.tile === i) flash = 'rejoin';
          else if (victorySeats.includes(soldier.owner)) flash = 'victory';
          drawSoldier(ctx, c.cx, c.cy, size * v.scale, soldier, flagOf(soldier.owner), 1, flash, hollow);
        }
        // SPAWN：目标地块淡入（起点 30% 保证移动连续性）
        if (ev?.kind === 'SPAWN') {
          if (!(fogEnabled && fogLevels && fogLevels[ev.tile] !== 'visible')) {
            const c = tx(centerOf(ev.tile, columns, size, offX, offY, totalH));
            drawSoldier(
              ctx,
              c.cx,
              c.cy,
              size * v.scale,
              ev.soldier,
              flagOf(ev.soldier.owner),
              0.3 + 0.7 * progress,
              null,
              !ev.soldier.isLinked || board.tiles[ev.tile].terrain === TERRAIN.CITY,
            );
          }
        }
        // ATTACK：目标地块红闪（进攻演出）
        if (ev?.kind === 'ATTACK') {
          const c = tx(centerOf(ev.to, columns, size, offX, offY, totalH));
          hexPath(ctx, c.cx, c.cy, ts * v.scale);
          ctx.fillStyle = `rgba(230, 57, 70, ${0.25 * Math.sin(progress * Math.PI)})`;
          ctx.fill();
        }

        // 加点阶段连兵白字高亮
        for (const i of addPointHighlights) {
          const c = tx(centerOf(i, columns, size, offX, offY, totalH));
          ctx.font = `bold ${Math.max(10, size * 0.5 * v.scale)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = 'rgba(0,0,0,0.7)';
          ctx.lineWidth = 2;
          ctx.strokeText(String(board.tiles[i].soldier!.strength), c.cx, c.cy);
          ctx.fillText(String(board.tiles[i].soldier!.strength), c.cx, c.cy);
        }

        // 选中光圈
        if (selected !== null) {
          const c = tx(centerOf(selected, columns, size, offX, offY, totalH));
          ctx.beginPath();
          ctx.arc(c.cx, c.cy, size * 0.78 * v.scale, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255, 235, 59, 0.9)';
          ctx.lineWidth = 2.5;
          ctx.stroke();
        }
        // hover 描边
        if (hoverRef.current !== null && hoverRef.current !== selected) {
          const c = tx(centerOf(hoverRef.current, columns, size, offX, offY, totalH));
          hexPath(ctx, c.cx, c.cy, ts * v.scale);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [board, boardSoldiers, selected, phase, mySeat, isSpectator, fogEnabled, fogLevels, flagOf, victorySeats, animatorRef, drawSoldier, canvasSize]);

  return (
    <div ref={containerRef} className={className} style={{ position: 'relative', overflow: 'hidden' }}>
      <canvas
        ref={staticRef}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', touchAction: 'none' }}
        onPointerDown={(e) => {
          dragRef.current = { x: e.clientX, y: e.clientY, startX: e.clientX, startY: e.clientY, moved: false };
          (e.currentTarget as HTMLCanvasElement).setPointerCapture?.(e.pointerId);
          const tile = tileAtPointer(e.clientX, e.clientY);
          if (tile !== null) {
            if (onTilePointerDown) onTilePointerDown(tile);
            else onTileClick(tile);
          }
        }}
        onPointerMove={(e) => {
          const d = dragRef.current;
          if (d) {
            // M5.2：拖拽平移（位移超过阈值才生效；生效即取消加点长按）
            if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > DRAG_THRESHOLD) {
              if (!d.moved) {
                d.moved = true;
                onTilePointerUp?.();
              }
              // 直接改 viewRef（rAF 层立即跟随），rAF 节流同步 state 触发静态层重绘
              const v = viewRef.current;
              viewRef.current = { ...v, offX: v.offX + (e.clientX - d.x), offY: v.offY + (e.clientY - d.y) };
              syncView();
            }
            d.x = e.clientX;
            d.y = e.clientY;
          }
          const tile = tileAtPointer(e.clientX, e.clientY);
          if (tile !== hoverRef.current) {
            hoverRef.current = tile;
            onTileHover(tile);
          }
        }}
        onPointerUp={() => {
          dragRef.current = null;
          syncView();
          onTilePointerUp?.();
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          syncView();
          onTilePointerUp?.();
        }}
        onDoubleClick={() => {
          viewRef.current = { scale: 1, offX: 0, offY: 0 };
          syncView();
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
