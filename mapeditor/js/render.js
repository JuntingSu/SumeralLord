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
  const BROKEN_FLAG_SCALE = 0.84; // 断兵：整旗等比缩小（与 BoardCanvas 一致），不再单独出镂空图

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

  // ---------- 旗帜精灵缓存 ----------
  const sprites = {}; // flagNum -> { img }
  const spriteWatchers = new Set();

  /** 注册精灵加载完成回调（主画布与移动端预览各自注册；返回取消函数） */
  function onSpriteReady(fn) { spriteWatchers.add(fn); return () => spriteWatchers.delete(fn); }
  /** 兼容旧调用名：等价于 onSpriteReady */
  function setSpriteWatcher(fn) { return onSpriteReady(fn); }

  function fireSpriteWatchers() { spriteWatchers.forEach((fn) => fn()); }

  function preloadFlag(flagNum) {
    if (sprites[flagNum] !== undefined) return;
    const img = new Image();
    img.src = MapConst.flagImageOwner(flagNum);
    sprites[flagNum] = { img };
    img.onload = fireSpriteWatchers;
    img.onerror = fireSpriteWatchers;
  }

  // ---------- 地形贴图缓存（static/terrain；虚空无贴图） ----------
  const terrainSprites = {}; // terrain -> Image | null

  function preloadTerrain(terrain) {
    if (terrainSprites[terrain] !== undefined) return;
    const url = MapConst.terrainImage(terrain);
    if (!url) {
      terrainSprites[terrain] = null;
      return;
    }
    const img = new Image();
    img.src = url;
    img.onload = fireSpriteWatchers;
    img.onerror = fireSpriteWatchers;
    terrainSprites[terrain] = img;
  }

  /** 预载全部精灵：旗帜（含中立 0/255）与地形贴图 */
  function preloadAllFlags() {
    for (const n of MapConst.FLAG_IMAGE_NUMS) preloadFlag(n);
    for (const n of Object.keys(MapConst.NEUTRAL_FLAG_FILES)) preloadFlag(Number(n));
    if (!MapConst.FLAG_IMAGE_NUMS.includes(8)) preloadFlag(8);
    for (const t of MapConst.TERRAIN_IMAGE_KEYS) preloadTerrain(t);
  }

  /** 归属 → 旗帜编号（对齐战斗棋盘 flagOf：野生 0 / 阻挡 255 各有中立旗，未知用 8） */
  function flagNumOf(map, owner) {
    if (owner === MapConst.TILE_OWNER.WILD) return 0;
    if (owner === MapConst.TILE_OWNER.BLOCKER) return 255;
    if (owner >= 1 && owner <= 127) {
      const p = map.player_list.find((x) => x.seat === owner);
      return p ? p.flag : 8;
    }
    return 8;
  }

  /**
   * 绘制一枚兵：broken=true 时整旗等比缩小露出地形；无精灵时回退旗帜色块。
   * 主画布与单格预览共用，保证视觉一致。
   */
  function drawSoldier(ctx, cx, cy, size, flagNum, broken, owner) {
    const flagScale =
      ((size * TILE_SCALE * FLAG_COVER) / FLAG_IMG_HEX_R) * (broken ? BROKEN_FLAG_SCALE : 1);
    const img = sprites[flagNum]?.img;
    if (img && img.complete && img.naturalWidth > 0) {
      const w = img.naturalWidth * flagScale;
      const h = img.naturalHeight * flagScale;
      ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
      return;
    }
    // 兜底：旗帜色块（中立势力取中立旗主色）
    const NEUTRAL_TONE = { [MapConst.TILE_OWNER.WILD]: '#69433d', [MapConst.TILE_OWNER.BLOCKER]: '#684f3f' };
    const color = NEUTRAL_TONE[owner] ?? MapConst.flagColor(flagNum) ?? '#888';
    ctx.fillStyle = color;
    ctx.fillRect(cx - size * 0.22, cy - size * 0.3, size * 0.44, size * 0.6);
  }

  /** 兵力数字：白字 + 下方黑色底影（对齐战斗棋盘；不描边） */
  function drawStrength(ctx, cx, cy, size, strength) {
    const text = String(strength);
    ctx.font = `bold ${Math.max(10, size * 0.5)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#000';
    ctx.fillText(text, cx, cy + Math.max(1, size * 0.055));
    ctx.fillStyle = '#fff';
    ctx.fillText(text, cx, cy);
  }

  /**
   * 绘制。view: {zoom, panX, panY}；opts 可选：{ hover }
   */
  function draw(ctx, cssW, cssH, map, view, opts = {}) {
    const { column, row, battlefield } = map;
    const layout = computeLayout(column, row, cssW, cssH, view.zoom, view.panX, view.panY);
    const { hover } = opts;
    const { TERRAIN } = MapConst;

    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = '#16181d';
    ctx.fillRect(0, 0, cssW, cssH);

    // 地形层（static/terrain 贴图；虚空完全透明 —— 不填充也不描边）
    for (let i = 0; i < battlefield.length; i++) {
      const terrain = battlefield[i][0];
      if (terrain === TERRAIN.VOID) continue;
      const { cx, cy } = centerOf(i, column, layout);
      const img = terrainSprites[terrain];
      if (img && img.complete && img.naturalWidth > 0) {
        const sc = layout.size / FLAG_IMG_HEX_R;
        const w = img.naturalWidth * sc;
        const h = img.naturalHeight * sc;
        ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
      } else {
        hexPath(ctx, cx, cy, layout.size);
        ctx.fillStyle = MapConst.TERRAIN_COLORS[terrain] ?? '#888888';
        ctx.fill();
      }
      hexPath(ctx, cx, cy, layout.size);
      ctx.strokeStyle = 'rgba(10,15,24,0.85)';
      ctx.lineWidth = Math.max(1, layout.size * 0.035);
      ctx.stroke();
    }

    // 兵：旗帜精灵（据点驻军按连兵渲染）+ 兵力数字
    for (let i = 0; i < battlefield.length; i++) {
      const [, o, s] = battlefield[i];
      if (s <= 0) continue;
      const { cx, cy } = centerOf(i, column, layout);
      drawSoldier(ctx, cx, cy, layout.size, flagNumOf(map, o), false, o);
      drawStrength(ctx, cx, cy, layout.size, s);
    }

    // 据点金环（旗面上沿地块轮廓；空据点同样标出）
    for (let i = 0; i < battlefield.length; i++) {
      if (battlefield[i][0] !== TERRAIN.CITY) continue;
      const { cx, cy } = centerOf(i, column, layout);
      hexPath(ctx, cx, cy, layout.size);
      ctx.strokeStyle = MapConst.CITY_RING;
      ctx.lineWidth = Math.max(3, layout.size * 0.09); // 与战斗棋盘一致：初版 2 倍粗
      ctx.stroke();
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
   * - 全部：地形 + 据点金环 + 兵 + 兵力数字
   * 兵按「断兵」比例整体略缩，四周留出一点地形宽度，便于看清地形底色。
   */
  function drawPreview(ctx, cssW, cssH, opts) {
    const { TERRAIN } = MapConst;
    const { map, mode = 'all', terrain, owner, strength = 0 } = opts;
    ctx.clearRect(0, 0, cssW, cssH);
    const size = Math.min(cssW / SQRT3, cssH / 2) * 0.94;
    const cx = cssW / 2;
    const cy = cssH / 2;
    const showTerrain = mode !== 'strength';
    const showSoldier = mode !== 'terrain' && strength > 0;

    if (showTerrain && terrain !== TERRAIN.VOID) {
      const img = terrainSprites[terrain];
      if (img && img.complete && img.naturalWidth > 0) {
        const sc = size / FLAG_IMG_HEX_R;
        const w = img.naturalWidth * sc;
        const h = img.naturalHeight * sc;
        ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
      } else {
        hexPath(ctx, cx, cy, size);
        ctx.fillStyle = MapConst.TERRAIN_COLORS[terrain] ?? '#888888';
        ctx.fill();
      }
      hexPath(ctx, cx, cy, size);
      ctx.strokeStyle = 'rgba(10,15,24,0.85)';
      ctx.lineWidth = Math.max(1, size * 0.035);
      ctx.stroke();
    }
    if (showSoldier) {
      const flagNum = map && Array.isArray(map.player_list) ? flagNumOf(map, owner) : 8;
      const soldierSize = size * PREVIEW_SOLDIER_SCALE;
      drawSoldier(ctx, cx, cy, soldierSize, flagNum, false, owner);
      drawStrength(ctx, cx, cy, soldierSize, strength);
    }
    // 据点金环（旗面上沿地块轮廓）
    if (terrain === TERRAIN.CITY) {
      hexPath(ctx, cx, cy, size);
      ctx.strokeStyle = MapConst.CITY_RING;
      ctx.lineWidth = Math.max(3, size * 0.09); // 与战斗棋盘一致：初版 2 倍粗
      ctx.stroke();
    }
  }

  return {
    computeLayout, centerOf, hexPath, pickIndex, draw, drawPreview,
    setSpriteWatcher, onSpriteReady, preloadAllFlags,
  };
})();
