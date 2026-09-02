// 个人皮肤（usr_{id}.png / usr_{id}_hollow.png）读写与校验：
// - 存放于 backend/static/skin（@fastify/static 已把 /static/** 映射到该目录，新文件无需重启即可访问）
// - hasSkin 按文件存在性判定（用户资料 / 房间玩家 / 排行榜共用）
// - 尺寸与本地旗帜一致：192×216 RGBA（六边形内容由前端生成）
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PNG_BYTES = 2 * 1024 * 1024;

/** 皮肤 PNG 画布尺寸（与 backend/static/flags/*.png 一致，BoardCanvas 按此缩放） */
export const SKIN_PNG_WIDTH = 192;
export const SKIN_PNG_HEIGHT = 216;

export interface DecodedPng {
  buf: Buffer;
  width: number;
  height: number;
}

/** 从 data URL（data:image/png;base64,...）或裸 base64 解码出 PNG Buffer；非法返回 null */
export function decodePngDataUrl(value: string): DecodedPng | null {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(value.trim());
  const b64 = m ? m[1] : value.trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(b64) || b64.length % 4 !== 0) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
  if (buf.length < PNG_MAGIC.length || buf.length > MAX_PNG_BYTES) return null;
  if (!buf.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) return null;
  // IHDR 紧随 8 字节签名：4 长度 + 4 'IHDR' + 宽(4) + 高(4)
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width !== SKIN_PNG_WIDTH || height !== SKIN_PNG_HEIGHT) return null;
  return { buf, width, height };
}

export function skinFilePath(skinDir: string, userId: number, hollow = false): string {
  return path.join(skinDir, `usr_${userId}${hollow ? '_hollow' : ''}.png`);
}

export function hasSkin(skinDir: string, userId: number): boolean {
  return existsSync(skinFilePath(skinDir, userId));
}

export function writeSkinPair(skinDir: string, userId: number, solid: Buffer, hollow: Buffer): void {
  mkdirSync(skinDir, { recursive: true });
  writeFileSync(skinFilePath(skinDir, userId), solid);
  writeFileSync(skinFilePath(skinDir, userId, true), hollow);
}
