/**
 * render.js — Canvas 六边形渲染 + 拾取
 * 对齐 HexMapPreview.tsx 几何：尖顶、数组奇数行（r%2===1）右移半格、index 0 左下、Y 翻转。
 * 兵/据点渲染对齐战斗棋盘 BoardCanvas：据点画归属圆点，其上兵按「断兵」镂空旗帜渲染；
 * 普通驻军用实心旗帜精灵渲染；兵力数字为深色+白描边。
 */
const HexRender = (() => {
  const SQRT3 = Math.sqrt(3);
  // 旗帜图片内尖顶六边形外接圆半径（与 backend/scripts/gen-flags.mjs R=100、BoardCanvas FLAG_IMG_HEX_R 耦合）
  const FLAG_IMG_HEX_R = 100;
  const FLAG_COVER = 1.02;
  const TILE_SCALE = 0.96; // 与战斗棋盘 size*(1-TILE_GAP) 一致

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

  // ---------- 旗帜精灵缓存（实心 + 镂空） ----------
  const sprites = {}; // flagNum -> { solid, hollow }
  let spriteWatcher = null;

  /** 注册精灵加载完成回调（main.js 用于触发重绘） */
  function setSpriteWatcher(fn) { spriteWatcher = fn; }

  function preloadFlag(flagNum) {
    if (sprites[flagNum] !== undefined) return;
    const solid = new Image();
    const hollow = new Image();
    solid.src = MapConst.flagImage(flagNum);
    hollow.src = MapConst.flagImageHollow(flagNum);
    sprites[flagNum] = { solid, hollow };
    let fired = false;
    const fire = () => { if (!fired && spriteWatcher) { fired = true; spriteWatcher(); } };
    solid.onload = fire;
    hollow.onload = fire;
    solid.onerror = fire;
    hollow.onerror = fire;
  }

  /** 预载全部可用旗帜精灵（旗号 8 兼作阻挡/未知兜底） */
  function preloadAllFlags() {
    for (const n of MapConst.FLAG_IMAGE_NUMS) preloadFlag(n);
    if (!MapConst.FLAG_IMAGE_NUMS.includes(8)) preloadFlag(8);
  }

  /** 归属 → 旗帜编号（对齐战斗棋盘 flagOf：野生 0 无精灵走色块，阻挡/未知用 8） */
  function flagNumOf(map, owner) {
    if (owner === MapConst.TILE_OWNER.WILD) return 0;
    if (owner === MapConst.TILE_OWNER.BLOCKER) return 8;
    if (owner >= 1 && owner <= 127) {
      const p = map.player_list.find((x) => x.seat === owner);
      return p ? p.flag : 8;
    }
    return 8;
  }

  /** 断兵擦边过渡（hollow 精灵缺失/未加载时回退）：沿地块边缘擦出环带 */
  function punchHollow(ctx, cx, cy, size) {
    ctx.save();
    hexPath(ctx, cx, cy, size);
    ctx.clip();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 30);
      const x = cx + size * Math.cos(a);
      const y = cy + size * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.lineWidth = 4;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 绘制。view: {zoom, panX, panY}；opts 可选：{ hover }
   */
  function draw(ctx, cssW, cssH, map, view, opts = {}) {
    const { column, row, battlefield } = map;
    const layout = computeLayout(column, row, cssW, cssH, view.zoom, view.panX, view.panY);
    const { hover } = opts;
    const { TERRAIN, TILE_OWNER } = MapConst;

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

    // 据点归属圆点（对齐战斗棋盘静态层：中立/无主据点也标，阻挡不标）
    for (let i = 0; i < battlefield.length; i++) {
      const [t, o] = battlefield[i];
      if (t !== TERRAIN.CITY) continue;
      if (o === TILE_OWNER.EMPTY || o === TILE_OWNER.BLOCKER) continue;
      const { cx, cy } = centerOf(i, column, layout);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(2.5, layout.size * 0.14), 0, Math.PI * 2);
      ctx.fillStyle = o === TILE_OWNER.WILD ? '#9e9e9e' : MapConst.seatColor(o);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // 兵：旗帜精灵（据点上的兵按断兵镂空渲染）+ 兵力数字
    const flagScale = (layout.size * TILE_SCALE * FLAG_COVER) / FLAG_IMG_HEX_R;
    for (let i = 0; i < battlefield.length; i++) {
      const [t, o, s] = battlefield[i];
      if (s <= 0) continue;
      const { cx, cy } = centerOf(i, column, layout);
      const flagNum = flagNumOf(map, o);
      const hollow = t === TERRAIN.CITY;
      const entry = sprites[flagNum];
      const primary = hollow ? entry?.hollow : entry?.solid;
      // 断兵：镂空精灵缺失/未加载时回退到实心精灵 + 擦边（新旗号无 hollow 文件也能显示断兵视觉）
      const usable =
        primary && primary.complete && primary.naturalWidth > 0
          ? primary
          : hollow
            ? (entry?.solid && entry.solid.complete && entry.solid.naturalWidth > 0 ? entry.solid : null)
            : null;
      if (usable) {
        const w = usable.naturalWidth * flagScale;
        const h = usable.naturalHeight * flagScale;
        ctx.drawImage(usable, cx - w / 2, cy - h / 2, w, h);
        if (hollow && (!primary || !primary.complete || primary.naturalWidth === 0)) {
          punchHollow(ctx, cx, cy, layout.size * TILE_SCALE);
        }
      } else {
        // 兜底：旗帜色块（wild 0 无精灵等）
        const color = o === TILE_OWNER.WILD ? '#9e9e9e' : MapConst.flagColor(flagNum) ?? '#888';
        ctx.fillStyle = color;
        ctx.fillRect(cx - layout.size * 0.22, cy - layout.size * 0.3, layout.size * 0.44, layout.size * 0.6);
      }
      // 兵力数字：地块中心（深色字 + 白描边，对齐战斗棋盘）
      ctx.font = `bold ${Math.max(10, layout.size * 0.5)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#111';
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 2.5;
      ctx.strokeText(String(s), cx, cy);
      ctx.fillText(String(s), cx, cy);
    }

    // 悬停描边
    if (hover >= 0) {
      const { cx, cy } = centerOf(hover, column, layout);
      hexPath(ctx, cx, cy, layout.size);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    return layout;
  }

  return {
    computeLayout, centerOf, hexPath, pickIndex, draw,
    setSpriteWatcher, preloadAllFlags,
  };
})();
