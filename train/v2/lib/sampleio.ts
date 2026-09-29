// sampleio.ts — 样本与对局日志落盘（日志 JSONL；样本二进制，逐局一文件）
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { TrainSample } from './driver.js';
import { TILE_FEATURES } from './encode.js';

/** 写对局日志（GAME_START / INTENT_BROADCAST×N / GAME_OVER，与线上同构） */
export function writeGameLog(dir: string, gameId: string, log: object[]): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `game-${gameId}.jsonl`);
  writeFileSync(file, log.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}

/** 写训练样本（每步一条 JSON 行；小规模/调试用） */
export function writeSamples(dir: string, gameId: string, samples: TrainSample[]): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `samples-${gameId}.jsonl`);
  writeFileSync(file, samples.map((s) => JSON.stringify(s)).join('\n') + '\n');
  return file;
}

/**
 * 写训练样本（二进制，训练循环用；体积约为 JSONL 的 1/3~1/4）。
 * 记录布局（小端）：u32 S, u32 rows, u32 cols, u32 L, f32 z,
 *   f32[S×14] features（token 主序）, u32[L] legal, f32[L] target
 * 位置（rows/cols 坐标）由 Python 侧按 rows/cols 推导。
 */
export function writeSamplesBinary(dir: string, gameId: string, samples: TrainSample[]): string {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `game-${gameId}.bin`);
  const chunks: Buffer[] = [];
  const u32 = Buffer.allocUnsafe(4);
  const f32 = Buffer.allocUnsafe(4);
  for (const s of samples) {
    const S = s.nTiles + 1;
    const L = s.pi.length;
    const header = Buffer.allocUnsafe(20);
    header.writeUInt32LE(S, 0);
    header.writeUInt32LE(s.rows, 4);
    header.writeUInt32LE(s.columns, 8);
    header.writeUInt32LE(L, 12);
    header.writeFloatLE(s.z, 16);
    chunks.push(header);

    const feats = Buffer.allocUnsafe(S * TILE_FEATURES * 4);
    let off = 0;
    for (let i = 0; i < TILE_FEATURES; i++) feats.writeFloatLE(s.cls[i], off + i * 4);
    off += TILE_FEATURES * 4;
    for (const t of s.tiles) {
      for (let i = 0; i < TILE_FEATURES; i++) feats.writeFloatLE(t[i], off + i * 4);
      off += TILE_FEATURES * 4;
    }
    chunks.push(feats);

    const legalBuf = Buffer.allocUnsafe(L * 4);
    for (let i = 0; i < L; i++) legalBuf.writeUInt32LE(s.pi[i][0], i * 4);
    chunks.push(legalBuf);

    const targetBuf = Buffer.allocUnsafe(L * 4);
    for (let i = 0; i < L; i++) targetBuf.writeFloatLE(s.pi[i][1], i * 4);
    chunks.push(targetBuf);
  }
  writeFileSync(file, Buffer.concat(chunks));
  return file;
}

/**
 * 统计二进制样本文件记录数（按记录头布局遍历；文件损坏/截断返回 null）。
 * 断点续跑用：worker 按 jobId 确定性命名 j<gi>.bin，文件存在且可完整解析 = 该局已完成。
 */
export function countSamplesBinary(file: string): number | null {
  const buf = readFileSync(file);
  let off = 0;
  let n = 0;
  while (off < buf.length) {
    if (off + 20 > buf.length) return null;
    const S = buf.readUInt32LE(off);
    const L = buf.readUInt32LE(off + 12);
    const rec = 20 + S * TILE_FEATURES * 4 + L * 8;
    if (rec <= 20 || off + rec > buf.length) return null;
    off += rec;
    n++;
  }
  return n;
}
