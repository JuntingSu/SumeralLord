// 地形贴图生成（static/terrain）：与旗帜同规格 192x216 RGBA、尖顶六边形 R=100 居中。
// 虚空不生成贴图（完全透明，由渲染层直接跳过）。
// 配色取自参考图：地块 #53637C→#4A576C 竖向渐变、山体 #333D4A（受光面 #46505F）、山脚线 #4C5968。
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'static', 'terrain');

const W = 192;
const H = 216;
const CX = W / 2;
const CY = H / 2;
const R = 100;
const SQRT3 = Math.sqrt(3);
const SS = 4; // 超采样倍数

/* ---------------- PNG 编码（与 gen-flags.mjs 同款，零依赖） ---------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 绘制工具 ---------------- */
const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function insideHex(x, y) {
  const dx = Math.abs(x - CX);
  const dy = Math.abs(y - CY);
  return dx <= (SQRT3 / 2) * R && dy <= R - dx / SQRT3;
}

/** 射线法判断点是否在多边形内 */
function inPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 渲染一张 192x216 六边形贴图；pixelAt 返回超采样坐标下的 [r,g,b] 或 null（透明） */
function render(pixelAt) {
  const buf = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS;
          const py = y + (sy + 0.5) / SS;
          if (!insideHex(px, py)) continue;
          const c = pixelAt(px, py);
          if (!c) continue;
          r += c[0]; g += c[1]; b += c[2];
          a += 1;
        }
      }
      const n = SS * SS;
      const o = (y * W + x) * 4;
      if (a === 0) continue;
      buf[o] = Math.round(r / a);
      buf[o + 1] = Math.round(g / a);
      buf[o + 2] = Math.round(b / a);
      buf[o + 3] = Math.round((a / n) * 255);
    }
  }
  return encodePng(W, H, buf);
}

/** 竖向渐变：顶色 → 底色（按六边形高度做 t） */
function gradient(topHex, botHex) {
  const top = hex2rgb(topHex);
  const bot = hex2rgb(botHex);
  return (x, y) => {
    const t = Math.min(1, Math.max(0, (y - (CY - R)) / (2 * R)));
    return mix(top, bot, t);
  };
}

/* ---------------- 各地形 ---------------- */
// 平原 / 城市 / 海洋：纯渐变
const PLAIN_TOP = '#566680';
const PLAIN_BOT = '#4A576C';
const CITY_TOP = '#E3B02E';
const CITY_BOT = '#C08F12';
const OCEAN_TOP = '#58ADEB';
const OCEAN_BOT = '#4596D6';

// 山地：平原渐变 + 山体剪影（双峰 + 受光面 + 山脚线）
const ROCK_DARK = hex2rgb('#333D4A');
const ROCK_LIT = hex2rgb('#46505F');
const BASE_LINE = hex2rgb('#4C5968');

const PEAK_MAIN = [
  [74, 58],
  [20, 146],
  [124, 146],
];
const PEAK_MAIN_LIT = [
  [74, 58],
  [20, 146],
  [74, 146],
];
const PEAK_SIDE = [
  [132, 84],
  [96, 146],
  [166, 146],
];

const plains = gradient(PLAIN_TOP, PLAIN_BOT);
const mountainPixel = (x, y) => {
  if (y >= 146 && y < 149.5 && x > 18 && x < 168) return BASE_LINE;
  if (inPoly(x, y, PEAK_SIDE)) return ROCK_DARK;
  if (inPoly(x, y, PEAK_MAIN)) return inPoly(x, y, PEAK_MAIN_LIT) ? ROCK_LIT : ROCK_DARK;
  return plains(x, y);
};

mkdirSync(outDir, { recursive: true });
const tiles = {
  plain: gradient(PLAIN_TOP, PLAIN_BOT),
  city: gradient(CITY_TOP, CITY_BOT),
  ocean: gradient(OCEAN_TOP, OCEAN_BOT),
  mountain: mountainPixel,
};
for (const [name, fn] of Object.entries(tiles)) {
  const png = render(fn);
  const file = path.join(outDir, `terrain_${name}.png`);
  writeFileSync(file, png);
  console.log(`written ${file} (${png.length} bytes)`);
}
