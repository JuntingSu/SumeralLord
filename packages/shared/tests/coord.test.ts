// §2 棋盘坐标、邻接与距离
import { describe, it, expect } from 'vitest';
import { neighborsOf, rowOf, colOf, rcToIndex } from '../src/game/coord.js';
import { axialOf, hexDistance } from '../src/game/distance.js';

const geo = { rows: 4, columns: 5, cylindrical: false };

describe('§2.2 行列换算', () => {
  it('index 0 在左下，从左到右、从下到上', () => {
    expect(rowOf(0, 5)).toBe(0);
    expect(colOf(0, 5)).toBe(0);
    expect(rowOf(7, 5)).toBe(1);
    expect(colOf(7, 5)).toBe(2);
    expect(rcToIndex(1, 2, 5)).toBe(7);
    expect(rowOf(19, 5)).toBe(3);
  });
});

describe('§2.3 邻接（even-r / odd-r：0 基奇数行右移半格）', () => {
  it('偶数地图行（0 基 row1，右移行）中间格恰有 6 个邻居', () => {
    // tile 7 = (row1, col2)；期望（按表序）：E(8) W(6) NE(3) NW(2) SE(13) SW(12)
    expect(neighborsOf(7, geo)).toEqual([8, 6, 3, 2, 13, 12]);
  });

  it('奇数地图行（0 基 row2，不右移行）中间格恰有 6 个邻居', () => {
    // tile 12 = (row2, col2)；期望：E(13) W(11) NE(7) NW(6) SE(17) SW(16)
    expect(neighborsOf(12, geo)).toEqual([13, 11, 7, 6, 17, 16]);
  });

  it('边界候选不是邻居（角/边格少于 6 个）', () => {
    // tile 0 = 左下角：E(1)、NE(5)
    expect(neighborsOf(0, geo)).toEqual([1, 5]);
    // tile 4 = 底行最右：W(3)、NE(9)、NW(8)
    expect(neighborsOf(4, geo)).toEqual([3, 9, 8]);
    // tile 15 = 顶行最左（row3 右移行）：E(16)、SE(11)、SW(10)
    expect(neighborsOf(15, geo)).toEqual([16, 11, 10]);
  });

  it('滚筒地图：左右列 wrap 相邻', () => {
    const cyc = { rows: 4, columns: 5, cylindrical: true };
    // tile 10 = (row2, col0)：W → (row2, col4)=14；NW → (row1, col4)=9；SW → (row3, col4)=19
    const ns = neighborsOf(10, cyc);
    expect(ns).toContain(14);
    expect(ns).toContain(9);
    expect(ns).toContain(19);
    expect(ns).toHaveLength(6);
  });
});

describe('§2.4 距离（整数 axial/cube）', () => {
  it('axial 换算：odd-r 奇数行右移', () => {
    // (row0,col0) → q=0,r=0；(row1,col0) → q = 0 - 0 = 0? row1 odd: q = col - (row-1)/2 = 0
    expect(axialOf(0, geo)).toEqual({ q: 0, r: 0 });
    // (row2,col1)=11 → q = 1 - 1 = 0, r=2
    expect(axialOf(11, geo)).toEqual({ q: 0, r: 2 });
    // (row1,col4)=9 → q = 4 - 0 = 4
    expect(axialOf(9, geo)).toEqual({ q: 4, r: 1 });
  });

  it('距离基本值', () => {
    expect(hexDistance(7, 7, geo)).toBe(0);
    expect(hexDistance(7, 8, geo)).toBe(1); // 邻格
    expect(hexDistance(7, 12, geo)).toBe(1); // 邻格（跨行）
    expect(hexDistance(7, 13, geo)).toBe(1);
    expect(hexDistance(0, 2, geo)).toBe(2); // 同行隔一格
    expect(hexDistance(0, 19, geo)).toBe(6); // 对角最远（左下→右上）
  });

  it('滚筒地图距离取 wrap 最小值：同行首尾相邻', () => {
    const cyc = { rows: 4, columns: 5, cylindrical: true };
    expect(hexDistance(10, 14, cyc)).toBe(1); // col0 ↔ col4 同行
    expect(hexDistance(0, 4, cyc)).toBe(1); // 底行首尾
    // 非滚筒时同为 4
    expect(hexDistance(0, 4, geo)).toBe(4);
  });
});
