/**
 * constants.js — 地图格式常量（对齐 packages/shared/src/types.ts、game/constants.ts）
 * 地形：0 平原 / 1 据点 / 3 海洋 / 4 山地 / 5 虚空（编码 2 已废弃空缺）
 * 归属：128 无主 / 0 野生 / 255 阻挡 / 1..127 玩家 seat
 * AI 难度：1 简单 / 2 普通 / 3 困难 / 255 休闲
 */
const MapConst = (() => {
  const TERRAIN = { PLAIN: 0, CITY: 1, OCEAN: 3, MOUNTAIN: 4, VOID: 5 };

  const TERRAIN_LABELS = {
    [TERRAIN.PLAIN]: '平原',
    [TERRAIN.CITY]: '据点',
    [TERRAIN.OCEAN]: '海洋',
    [TERRAIN.MOUNTAIN]: '山地',
    [TERRAIN.VOID]: '虚空',
  };
  // 与 static/terrain 贴图主色一致（虚空完全透明，仅作调色板色块）
  const TERRAIN_COLORS = {
    [TERRAIN.PLAIN]: '#53637c',
    [TERRAIN.CITY]: '#d4a017',
    [TERRAIN.OCEAN]: '#4fa3e3',
    [TERRAIN.MOUNTAIN]: '#434f63',
    [TERRAIN.VOID]: 'transparent',
  };
  /** 地形贴图文件名（static/terrain/terrain_{name}.png；虚空无贴图） */
  const TERRAIN_IMAGE_FILES = {
    [TERRAIN.PLAIN]: 'plain',
    [TERRAIN.CITY]: 'city',
    [TERRAIN.OCEAN]: 'ocean',
    [TERRAIN.MOUNTAIN]: 'mountain',
  };
  const TERRAIN_IMAGE_KEYS = Object.keys(TERRAIN_IMAGE_FILES).map(Number);
  function terrainImage(terrain) {
    const name = TERRAIN_IMAGE_FILES[terrain];
    return name ? `/static/terrain/terrain_${name}.png` : null;
  }
  /** 据点金环（旗面上沿地块轮廓的纯色金） */
  const CITY_RING = '#f2c14a';
  // 工具调色板顺序（当前项目合法地形码，绝不含 2）
  const TERRAIN_ORDER = [TERRAIN.PLAIN, TERRAIN.CITY, TERRAIN.OCEAN, TERRAIN.MOUNTAIN, TERRAIN.VOID];

  const TILE_OWNER = { EMPTY: 128, BLOCKER: 255, WILD: 0 };
  const OWNER_LABELS = {
    [TILE_OWNER.EMPTY]: '无主',
    [TILE_OWNER.WILD]: '野生',
    [TILE_OWNER.BLOCKER]: '阻挡',
  };
  const OWNER_COLORS = {
    [TILE_OWNER.WILD]: '#dc2626',
    [TILE_OWNER.EMPTY]: '#9e9e9e',
    [TILE_OWNER.BLOCKER]: '#6b7280',
  };
  const OWNER_ORDER = [TILE_OWNER.EMPTY, TILE_OWNER.WILD, TILE_OWNER.BLOCKER];

  const AI_LEVELS = [1, 2, 3, 255];
  const AI_LABELS = { 1: '简单', 2: '普通', 3: '困难', 255: '休闲' };

  const SEAT_COLORS = ['#e63946', '#457b9d', '#2a9d8f', '#e9c46a'];

  /** 全断地形：不可存在兵、不可通过 */
  const NO_SOLDIER_TERRAIN = new Set([TERRAIN.MOUNTAIN, TERRAIN.VOID]);

  const DEFAULT_STRENGTH = 5;
  const DEFAULT_SERVER = 'http://127.0.0.1:3000';

  /** 有图片的旗帜编号（static/flags/flag_N.png；1..30 为标准旗。断兵不单独出图，绘制时等比缩小） */
  const FLAG_IMAGE_NUMS = Array.from({ length: 30 }, (_, i) => i + 1);

  /** 旗帜实心文件 URL；无对应文件的旗号返回 ''（回退纯色） */
  function flagImage(flag) {
    return FLAG_IMAGE_NUMS.includes(flag) ? `/static/flags/flag_${flag}.png` : '';
  }

  /** 中立势力专属旗文件（owner 0/255 → flag_wild / flag_blocker，与玩家旗 1..30 分命名） */
  const NEUTRAL_FLAG_FILES = { [TILE_OWNER.WILD]: 'wild', [TILE_OWNER.BLOCKER]: 'blocker' };

  /** 战场按 owner 取旗：中立势力走专属文件，其余同 flagImage */
  function flagImageOwner(flag) {
    const name = NEUTRAL_FLAG_FILES[flag];
    return name ? `/static/flags/flag_${name}.png` : flagImage(flag);
  }

  /** 旗帜编号 → 颜色（黄金角 HSL，确定性；同参考编辑器 flag-colors.js） */
  function flagColor(flag) {
    const special = {
      [TILE_OWNER.WILD]: '#dc2626',
      [TILE_OWNER.EMPTY]: '#a0a0a0',
      [TILE_OWNER.BLOCKER]: '#6b7280',
    };
    if (flag in special) return special[flag];
    const hue = (flag * 137.508) % 360;
    const sat = 62 + (flag % 4) * 6;
    const light = 46 + (Math.floor(flag / 7) % 3) * 4;
    return `hsl(${hue.toFixed(1)}, ${sat}%, ${light}%)`;
  }

  /** 座次 → 颜色（0 基） */
  function seatColor(seat) {
    return SEAT_COLORS[(seat - 1) % SEAT_COLORS.length];
  }

  return {
    TERRAIN, TERRAIN_LABELS, TERRAIN_COLORS, TERRAIN_ORDER,
    TERRAIN_IMAGE_FILES, TERRAIN_IMAGE_KEYS, terrainImage, CITY_RING,
    TILE_OWNER, OWNER_LABELS, OWNER_COLORS, OWNER_ORDER,
    AI_LEVELS, AI_LABELS, SEAT_COLORS, NO_SOLDIER_TERRAIN,
    DEFAULT_STRENGTH, DEFAULT_SERVER, FLAG_IMAGE_NUMS, flagColor, flagImage,
    NEUTRAL_FLAG_FILES, flagImageOwner, seatColor,
  };
})();
