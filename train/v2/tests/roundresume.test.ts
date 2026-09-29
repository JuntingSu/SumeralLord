// roundresume.test.ts — 断点续跑扫描：countSamplesBinary + scanRoundResume + assignLegacyGi
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TrainSample } from '../lib/driver.js';
import { writeSamplesBinary } from '../lib/sampleio.js';
import { assignLegacyGi, scanRoundResume } from '../lib/roundresume.js';

function fakeSample(nTiles: number, piLen: number): TrainSample {
  return {
    gameId: 't',
    mapId: 'm',
    turn: 1,
    seat: 1,
    phase: 'ACTION',
    nTiles,
    rows: 10,
    columns: 10,
    cls: Array.from({ length: 14 }, (_, i) => i),
    tiles: Array.from({ length: nTiles }, () => Array.from({ length: 14 }, (_, i) => i)),
    pi: Array.from({ length: piLen }, (_, i) => [i, 1 / piLen] as [number, number]),
    z: 1,
  };
}

let tmp: string | null = null;
function makeTmp(): string {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'rr-'));
  return tmp;
}
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('断点续跑扫描', () => {
  it('countSamplesBinary：完整文件按记录头计数', () => {
    const dir = makeTmp();
    const file = writeSamplesBinary(dir, 'j5', [fakeSample(10, 8), fakeSample(12, 5), fakeSample(9, 3)]);
    // 3 条记录：20 + S*14*4 + L*8 逐条
    const buf = readFileSync(file);
    let off = 0;
    for (const [S, L] of [
      [11, 8],
      [13, 5],
      [10, 3],
    ]) {
      expect(buf.readUInt32LE(off)).toBe(S);
      expect(buf.readUInt32LE(off + 12)).toBe(L);
      off += 20 + S * 14 * 4 + L * 8;
    }
    expect(off).toBe(buf.length);
  });

  it('scanRoundResume：j<gi> 可跳过、旧格式保留、损坏文件视为未完成、非 .bin 忽略', () => {
    const dir = makeTmp();
    writeSamplesBinary(dir, 'j5', [fakeSample(10, 8), fakeSample(10, 8), fakeSample(10, 8)]); // 3 条
    writeSamplesBinary(dir, 'j7', [fakeSample(10, 8)]); // 1 条
    writeSamplesBinary(dir, 'tw636o5uq', [fakeSample(10, 8), fakeSample(10, 8)]); // 旧格式 2 条
    writeSamplesBinary(dir, 'abcd1234', [fakeSample(10, 8)]); // 旧格式 1 条
    // 损坏文件：截断的 game-j0.bin
    const full = readFileSync(path.join(dir, 'game-j5.bin'));
    writeFileSync(path.join(dir, 'game-j0.bin'), full.subarray(0, 10));
    writeFileSync(path.join(dir, 'notes.txt'), 'ignored');

    const r = scanRoundResume(dir);
    expect([...r.completed.entries()]).toEqual([
      [5, 3],
      [7, 1],
    ]);
    expect(r.legacyCounts).toEqual([1, 2]); // 文件名排序：game-abcd1234.bin(1) < game-tw636o5uq.bin(2)
  });

  it('assignLegacyGi：旧格式映射到最小编号空位，空位不足的保留', () => {
    const r: ReturnType<typeof scanRoundResume> = {
      completed: new Map([
        [5, 3],
        [6, 1],
      ]),
      legacyCounts: [2, 4, 7],
    };
    const leftover = assignLegacyGi(r, 0, 8);
    expect(leftover).toBe(0);
    expect([...r.completed.entries()].sort()).toEqual([
      [0, 2],
      [1, 4],
      [2, 7], // 最小编号空位（5、6 被占，2 空着）
      [5, 3],
      [6, 1],
    ]);
    expect(r.legacyCounts).toEqual([]);
  });

  it('assignLegacyGi：空位不足时剩余保留', () => {
    const r: ReturnType<typeof scanRoundResume> = {
      completed: new Map([
        [0, 1],
        [1, 1],
      ]),
      legacyCounts: [2, 4],
    };
    const leftover = assignLegacyGi(r, 0, 2);
    expect(leftover).toBe(2); // 两个空位都被占，全部保留
    expect([...r.completed.entries()]).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(r.legacyCounts).toEqual([2, 4]);
  });

  it('scanRoundResume：空目录 / 不存在目录返回全空', () => {
    const empty = scanRoundResume(makeTmp());
    expect(empty.completed.size).toBe(0);
    expect(empty.legacyCounts).toEqual([]);
    const missing = scanRoundResume(path.join(os.tmpdir(), 'definitely-not-exists-xyz'));
    expect(missing.completed.size).toBe(0);
    expect(missing.legacyCounts).toEqual([]);
  });
});
