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
  const PREVIEW_SOLDIER_SCALE = 0.86; // 单格预览的兵略缩，四周留出地形宽度

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
  const spriteWatchers = new Set();

  /** 注册精灵加载完成回调（主画布与移动端预览各自注册；返回取消函数） */
  function onSpriteReady(fn) { spriteWatchers.add(fn); return () => spriteWatchers.delete(fn); }
  /** 兼容旧调用名：等价于 onSpriteReady */
  function setSpriteWatcher(fn) { return onSpriteReady(fn); }

  function preloadFlag(flagNum) {
    if (sprites[flagNum] !== undefined) return;
    const solid = new Image();
    const hollow = new Image();
    solid.src = MapConst.flagImage(flagNum);
    hollow.src = MapConst.flagImageHollow(flagNum);
    sprites[flagNum] = { solid, hollow };
    let fired = false;
    const fire = () => {
      if (fired) return;
      fired = true;
      spriteWatchers.forEach((fn) => fn());
    };
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
   * 绘制一枚兵：hollow=true 按断兵（镂空精灵，缺失时擦边回退）；无精灵时回退旗帜色块。
   * 主画布与单格预览共用，保证视觉一致。
   */
  function drawSoldier(ctx, cx, cy, size, flagNum, hollow, owner) {
    const flagScale = (size * TILE_SCALE * FLAG_COVER) / FLAG_IMG_HEX_R;
    const entry = sprites[flagNum];
    const primary = hollow ? entry?.hollow : entry?.solid;
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
        punchHollow(ctx, cx, cy, size * TILE_SCALE);
      }
      return;
    }
    // 兜底：旗帜色块（wild 0 无精灵等）
    const color = owner === MapConst.TILE_OWNER.WILD ? '#9e9e9e' : MapConst.flagColor(flagNum) ?? '#888';
    ctx.fillStyle = color;
    ctx.fillRect(cx - size * 0.22, cy - size * 0.3, size * 0.44, size * 0.6);
  }

  /** 兵力数字：地块中心（深色字 + 白描边，对齐战斗棋盘） */
  function drawStrength(ctx, cx, cy, size, strength) {
    ctx.font = `bold ${Math.max(10, size * 0.5)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#111';
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2.5;
    ctx.strokeText(String(strength), cx, cy);
    ctx.fillText(String(strength), cx, cy);
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
    for (let i = 0; i < battlefield.length; i++) {
      const [t, o, s] = battlefield[i];
      if (s <= 0) continue;
      const { cx, cy } = centerOf(i, column, layout);
      drawSoldier(ctx, cx, cy, layout.size, flagNumOf(map, o), t === TERRAIN.CITY, o);
      drawStrength(ctx, cx, cy, layout.size, s);
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

  /**
   * 单格预览（移动端涂刷底栏最左）：把当前画笔「虚拟放在」一个格子上看效果。
   * opts: { map, mode: 'all'|'terrain'|'strength', terrain, owner, strength }
   * - 仅地形：只画地形色（不画兵，也不画据点归属点）
   * - 仅兵力：不画地形，只有兵
   * - 全部：地形 + 据点归属点 + 兵 + 兵力数字
   * 兵一律按「断兵」（镂空）渲染并整体略缩，四周留出一点地形宽度，便于看清地形底色。
   */
  function drawPreview(ctx, cssW, cssH, opts) {
    const { TERRAIN, TILE_OWNER } = MapConst;
    const { map, mode = 'all', terrain, owner, strength = 0 } = opts;
    ctx.clearRect(0, 0, cssW, cssH);
    const size = Math.min(cssW / SQRT3, cssH / 2) * 0.94;
    const cx = cssW / 2;
    const cy = cssH / 2;
    const showTerrain = mode !== 'strength';
    const showSoldier = mode !== 'terrain' && strength > 0;

    if (showTerrain) {
      hexPath(ctx, cx, cy, size);
      ctx.fillStyle = MapConst.TERRAIN_COLORS[terrain] ?? '#888888';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 1;
      ctx.stroke();
      if (terrain === TERRAIN.CITY && owner !== TILE_OWNER.EMPTY && owner !== TILE_OWNER.BLOCKER) {
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(2, size * 0.14), 0, Math.PI * 2);
        ctx.fillStyle = owner === TILE_OWNER.WILD ? '#9e9e9e' : MapConst.seatColor(owner);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }
    if (showSoldier) {
      const flagNum = map && Array.isArray(map.player_list) ? flagNumOf(map, owner) : 8;
      const soldierSize = size * PREVIEW_SOLDIER_SCALE;
      drawSoldier(ctx, cx, cy, soldierSize, flagNum, true, owner);
      drawStrength(ctx, cx, cy, soldierSize, strength);
    }
  }

  return {
    computeLayout, centerOf, hexPath, pickIndex, draw, drawPreview,
    setSpriteWatcher, onSpriteReady, preloadAllFlags,
  };
})();
