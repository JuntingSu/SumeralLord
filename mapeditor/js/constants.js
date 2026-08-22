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
  const TERRAIN_COLORS = {
    [TERRAIN.PLAIN]: '#7cb342',
    [TERRAIN.CITY]: '#d4a017',
    [TERRAIN.OCEAN]: '#4fa3e3',
    [TERRAIN.MOUNTAIN]: '#a1887f',
    [TERRAIN.VOID]: '#263238',
  };
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

  /** 有图片的旗帜编号（static/flags/flag_N.png 实心 + flag_N_hollow.png 镂空；45753/45754 为新增自定义旗） */
  const FLAG_IMAGE_NUMS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 45753, 45754];

  /** 旗帜实心文件 URL；无对应文件的旗号返回 ''（回退纯色） */
  function flagImage(flag) {
    return FLAG_IMAGE_NUMS.includes(flag) ? `/static/flags/flag_${flag}.png` : '';
  }

  /** 旗帜镂空文件 URL（断兵视觉，露出下方地形）；无对应文件的旗号返回 '' */
  function flagImageHollow(flag) {
    return FLAG_IMAGE_NUMS.includes(flag) ? `/static/flags/flag_${flag}_hollow.png` : '';
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
    TILE_OWNER, OWNER_LABELS, OWNER_COLORS, OWNER_ORDER,
    AI_LEVELS, AI_LABELS, SEAT_COLORS, NO_SOLDIER_TERRAIN,
    DEFAULT_STRENGTH, DEFAULT_SERVER, FLAG_IMAGE_NUMS, flagColor, flagImage, flagImageHollow, seatColor,
  };
})();
