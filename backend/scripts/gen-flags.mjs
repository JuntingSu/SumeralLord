// 生成占位旗帜 PNG（192x216 RGBA，尖顶六边形轮廓），BM2 换正式 TS 系列图。
// 尺寸与 backend/static/Sprite 参考图一致（192x216）；R=100 为旗帜内六边形外接圆半径，
// 与前端 BoardCanvas 的 FLAG_IMG_HEX_R 常量耦合，改动需同步。
// 零依赖：手写 PNG 编码器（zlib 为 Node 内置）。
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, '..', 'static', 'flags');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
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

function encodePng(width, height, pixelAt) {
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

const COLORS = [
  '#e63946', '#457b9d', '#2a9d8f', '#e9c46a', '#9b5de5',
  '#f15bb5', '#00bbf9', '#83c5be', '#b56576',
  '#ff6d00', '#8e44ad', '#16a085', '#e67e22', '#2980b9',
  '#c0392b', '#27ae60', '#7d3c98', '#1abc9c', '#f39c12',
  '#34495e', '#e84393', '#00b894', '#6c5ce7', '#fdcb6e',
  '#e17055', '#0984e3', '#55efc4', '#d63031', '#00cec9',
  '#ffeaa7',
];

const W = 192;
const H = 216;
const CX = W / 2;
const CY = H / 2;
const R = 100; // 尖顶六边形外接圆半径：高 2R=200 ≤ 216，宽 √3R≈173 ≤ 192
const SQRT3 = Math.sqrt(3);
// 断兵镂空环宽（图像像素）：保持棋盘上"露出宽度"与之前一致（TILE_GAP 0.04 时 16/100 ≈ 0.16×size）
const HOLLOW_RING = 16;

function hexToRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

mkdirSync(outDir, { recursive: true });
COLORS.forEach((hex, i) => {
  const [r, g, b] = hexToRgb(hex);
  const png = encodePng(W, H, (x, y) => {
    const dx = Math.abs(x - CX);
    const dy = Math.abs(y - CY);
    const inside = dx <= (SQRT3 / 2) * R && dy <= R - dx / SQRT3;
    if (!inside) return [0, 0, 0, 0];
    // 距边界近似距离（垂直约束换算到法向 ×cos30°），<3px 画深色描边
    const dEdge = Math.min((SQRT3 / 2) * R - dx, (R - dy - dx / SQRT3) * 0.866);
    if (dEdge < 3) return [Math.round(r * 0.55), Math.round(g * 0.55), Math.round(b * 0.55), 255];
    return [r, g, b, 255];
  });
  const file = path.join(outDir, `flag_${i + 1}.png`);
  writeFileSync(file, png);
  console.log(`written ${file} (${png.length} bytes)`);
  // 镂空版（断兵视觉）：外缘 HOLLOW_RING px 透明（露出下方地形，宽度 ≈ 2×地块间隔），其余实心
  const hollow = encodePng(W, H, (x, y) => {
    const dx = Math.abs(x - CX);
    const dy = Math.abs(y - CY);
    const inside = dx <= (SQRT3 / 2) * R && dy <= R - dx / SQRT3;
    if (!inside) return [0, 0, 0, 0];
    const dEdge = Math.min((SQRT3 / 2) * R - dx, (R - dy - dx / SQRT3) * 0.866);
    if (dEdge < HOLLOW_RING) return [0, 0, 0, 0]; // 外圈镂空
    return [r, g, b, 255];
  });
  const hollowFile = path.join(outDir, `flag_${i + 1}_hollow.png`);
  writeFileSync(hollowFile, hollow);
  console.log(`written ${hollowFile} (${hollow.length} bytes)`);
});
