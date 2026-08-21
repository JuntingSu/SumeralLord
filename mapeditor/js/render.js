/**
 * render.js — Canvas 六边形渲染 + 拾取
 * 对齐 HexMapPreview.tsx 几何：尖顶、数组奇数行（r%2===1）右移半格、index 0 左下、Y 翻转。
 */
const HexRender = (() => {
  const SQRT3 = Math.sqrt(3);

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function computeLayout(column, row, cssW, cssH, zoom, panX, panY) {
    const baseSize = clamp(Math.min(cssW / ((column + 1.5) * SQRT3), cssH / ((row + 1.5) * 1.5)), 8, 64);
    const size = baseSize * zoom;
    const hexW = SQRT3 * size;
    const totalW = SQRT3 * (column + 0.5) * size;
    const totalH = (2 + 1.5 * (row - 1)) * size;
    const offX = (cssW - totalW) / 2 + panX;
    const offY = (cssH - totalH) / 2 + panY;
    return { size, hexW, totalW, totalH, offX, offY };
  }

  function centerOf(index, column, layout) {
    const r = Math.floor(index / column);
    const col = index % column;
    const cx = layout.offX + layout.hexW / 2 + col * layout.hexW + (r % 2 === 1 ? layout.hexW / 2 : 0);
    const cy = layout.offY + layout.totalH - (layout.size + r * 1.5 * layout.size);
    return { cx, cy };
  }

  function hexPath(ctx, cx, cy, s) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 30);
      const x = cx + s * Math.cos(a);
      const y = cy + s * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  /** 像素 → 格子索引（最近格心距离 ≤ size 判定命中） */
  function pickIndex(x, y, column, row, layout) {
    const r2 = layout.size * layout.size;
    let best = -1;
    let bestD = r2;
    for (let i = 0; i < row * column; i++) {
      const { cx, cy } = centerOf(i, column, layout);
      const dx = x - cx;
      const dy = y - cy;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return bestD <= r2 ? best : -1;
  }

  /**
   * 绘制。view: {zoom, panX, panY}；opts 可选：
   *   selected, hover, selection:{r0,c0,r1,c1}, ghost:{indices, cells}
   */
  function draw(ctx, cssW, cssH, map, view, opts = {}) {
    const { column, row, battlefield } = map;
    const layout = computeLayout(column, row, cssW, cssH, view.zoom, view.panX, view.panY);
    const { selected, hover, selection, ghost } = opts;

    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = '#16181d';
    ctx.fillRect(0, 0, cssW, cssH);

    // 地形层
    for (let i = 0; i < battlefield.length; i++) {
      const { cx, cy } = centerOf(i, column, layout);
      hexPath(ctx, cx, cy, layout.size * 0.98);
      ctx.fillStyle = MapConst.TERRAIN_COLORS[battlefield[i][0]] ?? '#888888';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.30)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 归属/兵力标记层
    const fontPx = Math.max(8, Math.round(layout.size * 0.62));
    ctx.font = `bold ${fontPx}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < battlefield.length; i++) {
      const [t, o, s] = battlefield[i];
      const { cx, cy } = centerOf(i, column, layout);
      if (t === MapConst.TERRAIN.CITY && o >= 1 && o <= 127) {
        // 归属据点：座次色描边 + 兵力数字
        hexPath(ctx, cx, cy, layout.size * 0.88);
        ctx.strokeStyle = MapConst.seatColor(o);
        ctx.lineWidth = Math.max(2, layout.size * 0.14);
        ctx.stroke();
        if (s > 0) {
          ctx.fillStyle = '#ffffff';
          ctx.shadowColor = 'rgba(0,0,0,0.8)';
          ctx.shadowBlur = 4;
          ctx.fillText(String(s), cx, cy + 0.5);
          ctx.shadowBlur = 0;
        }
      } else if (s > 0) {
        // 驻军（玩家势力/野生/阻挡）
        let color = MapConst.flagColor(o);
        if (o === MapConst.TILE_OWNER.WILD) color = MapConst.OWNER_COLORS[MapConst.TILE_OWNER.WILD];
        else if (o === MapConst.TILE_OWNER.BLOCKER) color = MapConst.OWNER_COLORS[MapConst.TILE_OWNER.BLOCKER];
        const markR = Math.max(4, layout.size * 0.30);
        ctx.beginPath();
        ctx.arc(cx, cy, markR, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 4;
        ctx.fillText(String(s), cx, cy + 0.5);
        ctx.shadowBlur = 0;
      }
    }

    // 框选高亮
    if (selection && selection.r0 >= 0) {
      const { r0, c0, r1, c1 } = selection;
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const { cx, cy } = centerOf(r * column + c, column, layout);
          hexPath(ctx, cx, cy, layout.size * 0.98);
          ctx.fillStyle = 'rgba(255, 200, 60, 0.18)';
          ctx.fill();
        }
      }
      const corners = [
        centerOf(r0 * column + c0, column, layout),
        centerOf(r0 * column + c1, column, layout),
        centerOf(r1 * column + c1, column, layout),
        centerOf(r1 * column + c0, column, layout),
      ];
      ctx.beginPath();
      corners.forEach((p, i) => (i === 0 ? ctx.moveTo(p.cx, p.cy) : ctx.lineTo(p.cx, p.cy)));
      ctx.closePath();
      ctx.strokeStyle = '#ffc83c';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // 粘贴 ghost 预览（按剪贴板内容半透明绘制）
    if (ghost && ghost.indices && ghost.indices.length) {
      const cells = ghost.cells || [];
      for (let k = 0; k < ghost.indices.length; k++) {
        const idx = ghost.indices[k];
        const { cx, cy } = centerOf(idx, column, layout);
        const cell = cells[k];
        if (cell) {
          hexPath(ctx, cx, cy, layout.size * 0.98);
          ctx.globalAlpha = 0.55;
          ctx.fillStyle = MapConst.TERRAIN_COLORS[cell[0]] ?? '#888888';
          ctx.fill();
          ctx.globalAlpha = 1;
          if (cell[2] > 0) {
            const markR = Math.max(4, layout.size * 0.30);
            ctx.beginPath();
            ctx.arc(cx, cy, markR, 0, Math.PI * 2);
            ctx.globalAlpha = 0.7;
            ctx.fillStyle = MapConst.flagColor(cell[1]);
            ctx.fill();
            ctx.globalAlpha = 1;
          }
        } else {
          hexPath(ctx, cx, cy, layout.size * 0.98);
          ctx.fillStyle = 'rgba(120, 200, 255, 0.30)';
          ctx.fill();
        }
      }
    }

    // 悬停/选中描边
    if (hover >= 0) {
      const { cx, cy } = centerOf(hover, column, layout);
      hexPath(ctx, cx, cy, layout.size);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    if (selected >= 0 && selected !== hover) {
      const { cx, cy } = centerOf(selected, column, layout);
      hexPath(ctx, cx, cy, layout.size);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    return layout;
  }

  return { computeLayout, centerOf, hexPath, pickIndex, draw };
})();
