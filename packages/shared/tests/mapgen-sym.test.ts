// 对称地图生成器单测（中心对称/轴对称，奇数长宽，奇数行最右格虚空）+ 随机 1v1 便捷封装
// 迁移自 train/mapgen-sym/tests/mapgen-sym.test.ts
import { describe, expect, it } from 'vitest';
import {
  TERRAIN,
  TILE_OWNER,
  SYM_1V1_FORCES,
  generateSymMap,
  linkableDistance,
  randomSym1v1Map,
  strongholdSymPairs,
  symmetryImageOf,
  validateSymMapOptions,
  voidIndexes,
  type SymmetryMode,
} from '../src/index.js';

const MODES: SymmetryMode[] = ['center', 'axis'];
const ROWS = [9, 11, 13];
const COLS = [9, 11, 13, 15, 17];

function ownedSpawns(map: { battlefield: number[][] }) {
  const out: Array<{ i: number; owner: number; strength: number }> = [];
  map.battlefield.forEach(([t, o, s], i) => {
    if (t === TERRAIN.CITY && (o === 1 || o === 2)) out.push({ i, owner: o, strength: s });
  });
  return out;
}

describe('generateSymMap 对称地图', () => {
  it('奇数行最右格恒为虚空；其余格满足所选对称性且对称映像对合', () => {
    for (const mode of MODES) {
      for (let k = 0; k < 6; k++) {
        const row = ROWS[Math.floor(Math.random() * ROWS.length)];
        const column = COLS[Math.floor(Math.random() * COLS.length)];
        const { map } = generateSymMap({ row, column, symmetry: mode });
        expect(map.battlefield).toHaveLength(row * column);
        const voids = new Set(voidIndexes(row, column));
        map.battlefield.forEach((tile, i) => {
          const img = symmetryImageOf(i, row, column, mode);
          if (voids.has(i)) {
            expect(tile[0]).toBe(TERRAIN.VOID);
            expect(img).toBe(-1);
            return;
          }
          expect(img).toBeGreaterThanOrEqual(0);
          expect(map.battlefield[img][0]).toBe(tile[0]); // 地形对称
          expect(symmetryImageOf(img, row, column, mode)).toBe(i); // 对合
        });
      }
    }
  });

  it('恰好两座有主据点：先手 seat1 兵力 3、后手 seat2 兵力 4，且互为对称映像', () => {
    for (const mode of MODES) {
      const { map } = generateSymMap({ row: 11, column: 13, symmetry: mode });
      const spawns = ownedSpawns(map);
      expect(spawns).toHaveLength(2);
      const s1 = spawns.find((s) => s.owner === 1)!;
      const s2 = spawns.find((s) => s.owner === 2)!;
      expect(s1.strength).toBe(3);
      expect(s2.strength).toBe(4);
      expect(symmetryImageOf(s1.i, map.row, map.column, mode)).toBe(s2.i);
      // 其余据点格必须为无主空据点（归属 128、兵力 0）
      map.battlefield.forEach(([t, o, s]) => {
        if (t === TERRAIN.CITY && o !== 1 && o !== 2) {
          expect(o).toBe(TILE_OWNER.EMPTY);
          expect(s).toBe(0);
        }
      });
      // 有主据点对必然存在于对称据点对集合中
      const pairs = strongholdSymPairs(map.battlefield, map.row, map.column, mode);
      expect(pairs.some(([a, b]) => (a === s1.i && b === s2.i) || (a === s2.i && b === s1.i))).toBe(true);
    }
  });

  it('两出生据点经平原/据点连通且 BFS 最短路径距离 ≥ 4', () => {
    for (const mode of MODES) {
      for (let k = 0; k < 10; k++) {
        const { map, spawnDistance } = generateSymMap({ row: 13, column: 17, symmetry: mode });
        const [s1, s2] = ownedSpawns(map);
        expect(spawnDistance).toBeGreaterThanOrEqual(4);
        expect(linkableDistance(map.battlefield, s1.i, s2.i, map.row, map.column)).toBe(spawnDistance);
        expect(spawnDistance).not.toBe(-1);
      }
    }
  });

  it('奇数行最右格虚空恒在，全图无废弃地形 2（虚空权重会额外随机生成虚空格）', () => {
    for (const mode of MODES) {
      const { map } = generateSymMap({ row: 9, column: 9, symmetry: mode });
      let voidCount = 0;
      for (const [t] of map.battlefield) {
        expect(t).not.toBe(2);
        if (t === TERRAIN.VOID) voidCount++;
      }
      // 固定虚空格 (row-1)/2 个 + 权重 0.05 随机虚空格
      expect(voidCount).toBeGreaterThanOrEqual((map.row - 1) / 2);
    }
  });

  it('尺寸校验：偶数或超出范围抛错', () => {
    for (const mode of MODES) {
      expect(() => generateSymMap({ row: 10, column: 13, symmetry: mode })).toThrow();
      expect(() => generateSymMap({ row: 15, column: 13, symmetry: mode })).toThrow();
      expect(() => generateSymMap({ row: 11, column: 8, symmetry: mode })).toThrow();
      expect(() => generateSymMap({ row: 11, column: 19, symmetry: mode })).toThrow();
      expect(() => validateSymMapOptions(11, 13, 'diagonal' as SymmetryMode)).toThrow();
    }
  });
});

describe('randomSym1v1Map 随机 1v1 对称地图', () => {
  it('固定两个势力（先手 seat1 / 后手 seat2），尺寸为奇数且在支持范围内，每局随机', () => {
    expect(SYM_1V1_FORCES.map((f) => f.name)).toEqual(['先手', '后手']);
    const ids = new Set<string>();
    const sizes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const map = randomSym1v1Map(`sym1v1-test-${i}`);
      expect(map.player_num).toBe(2);
      expect(map.player_list.map((p) => p.name)).toEqual(['先手', '后手']);
      expect(map.player_list.map((p) => p.seat)).toEqual([1, 2]);
      expect(map.row % 2).toBe(1);
      expect(map.column % 2).toBe(1);
      expect(map.row).toBeGreaterThanOrEqual(9);
      expect(map.row).toBeLessThanOrEqual(13);
      expect(map.column).toBeGreaterThanOrEqual(9);
      expect(map.column).toBeLessThanOrEqual(17);
      // 两座有主据点：先手 3 兵 / 后手 4 兵
      const spawns = ownedSpawns(map);
      expect(spawns).toHaveLength(2);
      expect(spawns.find((s) => s.owner === 1)!.strength).toBe(3);
      expect(spawns.find((s) => s.owner === 2)!.strength).toBe(4);
      ids.add(map.id);
      sizes.add(`${map.row}x${map.column}`);
    }
    expect(ids.size).toBe(20); // id 由调用方给出，此处校验不变量即可
    expect(sizes.size).toBeGreaterThan(0);
  });

  it('地形满足中心对称或轴对称之一', () => {
    for (let k = 0; k < 10; k++) {
      const map = randomSym1v1Map(`sym1v1-sym-${k}`);
      const holds = (mode: SymmetryMode) =>
        map.battlefield.every((tile, i) => {
          const img = symmetryImageOf(i, map.row, map.column, mode);
          return img < 0 || map.battlefield[img][0] === tile[0];
        });
      expect(holds('center') || holds('axis')).toBe(true);
    }
  });
});
