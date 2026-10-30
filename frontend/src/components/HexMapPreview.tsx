import { useEffect, useRef } from 'react';
import { TERRAIN } from '@dl/shared';
import type { BattlefieldTile } from '@dl/shared';

/** 地形色（缩略图用）：山地用棕色以示高低起伏，虚空透明不绘制 */
const TERRAIN_COLORS: Record<number, string> = {
  [TERRAIN.PLAIN]: '#53637c',
  [TERRAIN.CITY]: '#d4a017',
  [TERRAIN.OCEAN]: '#4fa3e3',
  [TERRAIN.MOUNTAIN]: '#8a5a33',
};

interface HexMapPreviewProps {
  battlefield: BattlefieldTile[];
  column: number;
  row: number;
  height?: number;
  className?: string;
}

/** 六边形地图缩略图：尖顶、even-r（偶数行右移）、index 0 在左下；据点不标记归属（势力信息见对局侧栏） */
export default function HexMapPreview({ battlefield, column, row, height = 260, className }: HexMapPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || battlefield.length !== column * row) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const SQRT3 = Math.sqrt(3);
    const totalWUnits = SQRT3 * (column + 0.5);
    const totalHUnits = 2 + 1.5 * (row - 1);

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth || 320;
      // 位图尺寸与 CSS 尺寸/DPR 不一致时同步，否则画布会被拉伸
      const bw = Math.round(cssW * dpr);
      const bh = Math.round(height * dpr);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, height);

      const pad = 4;
      const size = Math.min((cssW - pad * 2) / totalWUnits, (height - pad * 2) / totalHUnits);
      const hexW = SQRT3 * size;
      const totalW = totalWUnits * size;
      const totalH = totalHUnits * size;
      const offX = (cssW - totalW) / 2;
      const offY = (height - totalH) / 2;

      const centerOf = (index: number) => {
        const r = Math.floor(index / column);
        const col = index % column;
        // 地图行号从下往上 1 起：index 行 r 对应地图行 r+1，偶数地图行（r 为奇数）右移半格
        const cx = offX + hexW / 2 + col * hexW + (r % 2 === 1 ? hexW / 2 : 0);
        const cy = offY + totalH - (size + r * 1.5 * size);
        return { cx, cy };
      };

      const hexPath = (cx: number, cy: number, s: number) => {
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const angle = (Math.PI / 180) * (60 * i - 30);
          const x = cx + s * Math.cos(angle);
          const y = cy + s * Math.sin(angle);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.closePath();
      };

      for (let i = 0; i < battlefield.length; i++) {
        const terrain = battlefield[i][0];
        if (terrain === TERRAIN.VOID) continue; // 虚空完全透明
        const { cx, cy } = centerOf(i);
        hexPath(cx, cy, size);
        ctx.fillStyle = TERRAIN_COLORS[terrain] ?? '#9e9e9e';
        ctx.fill();
        ctx.strokeStyle = 'rgba(10,15,24,0.85)';
        ctx.lineWidth = 1;
        ctx.stroke();
        // 山地棕色底上用深棕山形标记，保留缩略图上的起伏观感
        if (terrain === TERRAIN.MOUNTAIN) {
          const w = size * 0.62;
          const h = size * 0.42;
          const baseY = cy + h * 0.45;
          ctx.beginPath();
          ctx.moveTo(cx - w / 2, baseY);
          ctx.lineTo(cx - w * 0.12, baseY - h);
          ctx.lineTo(cx + w * 0.18, baseY);
          ctx.closePath();
          ctx.fillStyle = 'rgba(66, 39, 16, 0.85)';
          ctx.fill();
          ctx.beginPath();
          ctx.moveTo(cx + w * 0.02, baseY);
          ctx.lineTo(cx + w * 0.28, baseY - h * 0.62);
          ctx.lineTo(cx + w / 2, baseY);
          ctx.closePath();
          ctx.fill();
        }
      }
    };

    draw();

    // 画布或窗口尺寸变化时按新尺寸重绘，避免位图与 CSS 尺寸不一致被拉伸。
    // ResizeObserver 缺失（旧浏览器）时降级为仅监听窗口 resize，避免挂载即抛错导致白屏。
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(draw);
      observer.observe(canvas);
    }
    window.addEventListener('resize', draw);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', draw);
    };
  }, [battlefield, column, row, height]);

  return <canvas ref={canvasRef} className={className} style={{ width: '100%', height }} />;
}
