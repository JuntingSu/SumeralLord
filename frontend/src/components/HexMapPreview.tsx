import { useEffect, useRef } from 'react';
import { TERRAIN, TILE_OWNER } from '@dl/shared';
import type { BattlefieldTile } from '@dl/shared';

/** 地形色：0 平原 1 据点（原王城色已并入据点）3 海洋 4 山地 5 虚空；编码 2 已废弃空缺 */
const TERRAIN_COLORS: Record<number, string> = {
  [TERRAIN.PLAIN]: '#7cb342',
  [TERRAIN.CITY]: '#d4a017',
  [TERRAIN.OCEAN]: '#4fa3e3',
  [TERRAIN.MOUNTAIN]: '#a1887f',
  [TERRAIN.VOID]: '#263238',
};

const SEAT_COLORS = ['#e63946', '#457b9d', '#2a9d8f', '#e9c46a'];

interface HexMapPreviewProps {
  battlefield: BattlefieldTile[];
  column: number;
  row: number;
  height?: number;
  className?: string;
}

/** 六边形地图缩略图：尖顶、even-r（偶数行右移）、index 0 在左下；有归属座次的据点地块标记座次颜色 */
export default function HexMapPreview({ battlefield, column, row, height = 260, className }: HexMapPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || battlefield.length !== column * row) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 320;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, height);

    const SQRT3 = Math.sqrt(3);
    const totalWUnits = SQRT3 * (column + 0.5);
    const totalHUnits = 2 + 1.5 * (row - 1);
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
      const { cx, cy } = centerOf(i);
      hexPath(cx, cy, size);
      ctx.fillStyle = TERRAIN_COLORS[battlefield[i][0]] ?? '#9e9e9e';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    for (let i = 0; i < battlefield.length; i++) {
      const [terrain, belongs] = battlefield[i];
      if (terrain !== TERRAIN.CITY || belongs === TILE_OWNER.EMPTY || belongs === TILE_OWNER.BLOCKER || belongs === TILE_OWNER.WILD) continue;
      const { cx, cy } = centerOf(i);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(3, size * 0.18), 0, Math.PI * 2);
      ctx.fillStyle = SEAT_COLORS[(belongs - 1) % SEAT_COLORS.length];
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }, [battlefield, column, row, height]);

  return <canvas ref={canvasRef} className={className} style={{ width: '100%', height }} />;
}
