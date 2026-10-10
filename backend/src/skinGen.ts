// 随机配色皮肤生成：把手写零依赖 PNG 编码器（源自 backend/scripts/gen-flags.mjs）参数化为任意
// 纯色六边形，产出与内置旗帜同规格的一对 192×216 PNG（solid + hollow）。
// 几何与 gen-flags.mjs、frontend/src/pages/SkinStudio.tsx 耦合（尖顶六边形 R=100 居中、
// hollow 环宽 16px），改动需三处同步。
import { randomInt } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { writeSkinPair } from './skin.js';

/** 皮肤 PNG 画布尺寸（与 backend/static/flags/*.png 一致） */
const W = 192;
const H = 216;
const CX = W / 2;
const CY = H / 2;
/** 尖顶六边形外接圆半径：高 2R=200 ≤ 216，宽 √3R≈173 ≤ 192 */
const R = 100;
const SQRT3 = Math.sqrt(3);
/** 断兵镂空环宽（与 gen-flags.mjs / SkinStudio.tsx 的 HOLLOW_RING 一致） */
const HOLLOW_RING = 16;
/** 边缘深色描边宽度（px）与压暗系数 */
const EDGE_PX = 3;
const EDGE_DARKEN = 0.55;
/** 随机取色区间（含端点，闭区间外的极暗/极亮色辨识度过低） */
const COLOR_MIN = 40;
const COLOR_MAX = 230;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** 手写 PNG（8bit RGBA、filter=none、zlib deflate），零第三方依赖 */
function encodePng(width: number, height: number, pixelAt: (x: number, y: number) => [number, number, number, number]): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      const o = y * (stride + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 六边形「到边界近似距离」（垂直约束换算到法向 ×cos30°），与 gen-flags.mjs 判定一致 */
function edgeDistance(x: number, y: number): number {
  const dx = Math.abs(x - CX);
  const dy = Math.abs(y - CY);
  return Math.min((SQRT3 / 2) * R - dx, (R - dy - dx / SQRT3) * 0.866);
}

function insideHex(x: number, y: number): boolean {
  const dx = Math.abs(x - CX);
  const dy = Math.abs(y - CY);
  return dx <= (SQRT3 / 2) * R && dy <= R - dx / SQRT3;
}

/** 随机皮肤颜色：每通道独立取 40–230，避开接近纯黑/纯白导致棋子难以辨认 */
export function randomSkinColor(): Rgb {
  return {
    r: randomInt(COLOR_MIN, COLOR_MAX + 1),
    g: randomInt(COLOR_MIN, COLOR_MAX + 1),
    b: randomInt(COLOR_MIN, COLOR_MAX + 1),
  };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const hex = (v: number) => v.toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** 由纯色渲染 solid + hollow（断兵）两张 PNG；内容与内置旗帜同规格 */
export function renderSkinPng(color: Rgb): { solid: Buffer; hollow: Buffer } {
  const { r, g, b } = color;
  const solid = encodePng(W, H, (x, y) => {
    if (!insideHex(x, y)) return [0, 0, 0, 0];
    if (edgeDistance(x, y) < EDGE_PX) {
      return [Math.round(r * EDGE_DARKEN), Math.round(g * EDGE_DARKEN), Math.round(b * EDGE_DARKEN), 255];
    }
    return [r, g, b, 255];
  });
  // 断兵视觉：外缘 HOLLOW_RING px 透明
  const hollow = encodePng(W, H, (x, y) => {
    if (!insideHex(x, y)) return [0, 0, 0, 0];
    if (edgeDistance(x, y) < HOLLOW_RING) return [0, 0, 0, 0];
    return [r, g, b, 255];
  });
  return { solid, hollow };
}

/** 随机取色 → 渲染 → 覆盖写入该用户皮肤文件，返回所用颜色 */
export function writeRandomSkin(skinDir: string, userId: number): Rgb {
  const color = randomSkinColor();
  const { solid, hollow } = renderSkinPng(color);
  writeSkinPair(skinDir, userId, solid, hollow);
  return color;
}
