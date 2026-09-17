// 校验生成的个人皮肤：画布尺寸、六边形包围盒（应与 flag_1.png 一致：173×201）、hollow 环、内容颜色
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

function decodePng(file) {
  const buf = readFileSync(file);
  let off = 8, width, height, colorType;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { width = data.readUInt32BE(0); height = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    off += 12 + len;
  }
  if (colorType !== 6) throw new Error('not RGBA ' + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = row[x];
      const b = prev ? prev[x] : 0;
      const c = x >= 4 ? px[y * stride + x - 4] : 0;
      let v = a;
      switch (filter) {
        case 1: v = (a + c) & 255; break;
        case 2: v = (a + b) & 255; break; // Up：加正上方像素
        case 3: v = (a + ((b + c) >> 1)) & 255; break;
        case 4: {
          const p = b + c - (x >= 4 ? prev[x - 4] : 0);
          const pa = Math.abs(p - b), pb = Math.abs(p - c), pc = Math.abs(p - (x >= 4 ? prev[x - 4] : 0));
          const pr = (pa <= pb && pa <= pc) ? b : (pb <= pc ? c : (x >= 4 ? prev[x - 4] : 0));
          v = (a + pr) & 255; break;
        }
      }
      px[y * stride + x] = v;
    }
  }
  return { width, height, px };
}

for (const f of process.argv.slice(2)) {
  const { width, height, px } = decodePng(f);
  const at = (x, y) => { const o = (y * width + x) * 4; return [px[o], px[o + 1], px[o + 2], px[o + 3]]; };
  let minX = width, maxX = -1, minY = height, maxY = -1, opaque = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (at(x, y)[3] > 0) { opaque++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  console.log(`\n== ${f}`);
  console.log(`canvas ${width}x${height}; alpha bbox x[${minX},${maxX}] y[${minY},${maxY}] => ${maxX - minX + 1} x ${maxY - minY + 1}; opaque px ${opaque}`);
  // 内容颜色采样
  console.log('  leftInside(60,108)=', at(60, 108), ' rightInside(130,108)=', at(130, 108), ' center(96,108)=', at(96, 108), ' topInside(96,60)=', at(96, 60));
  console.log('  outside(5,5)=', at(5, 5), ' outside(5,108)=', at(5, 108));
  console.log('  nearEdgeInside(25,108)=', at(25, 108), ' nearTopInside(96,20)=', at(96, 20));
}
