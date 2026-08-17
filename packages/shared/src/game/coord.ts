// 六边形坐标：尖顶、odd-r（0 基奇数行右移半格）、index 0 左下、从左到右从下到上（规则 v2 §2）
//
// 说明：规则 v2 §2.3 的"偶数行"邻接表有一处笔误（(-1,-1) 应为 (+1,-1)）。
// 此处采用与渲染（HexMapPreview）、地图生成器（gen-maps.mjs）、前端规划 §4.1 一致的标准 odd-r 邻居表，
// 几何推导见 even-r/odd-r 标准算法，全整数运算（P7 确定性要求）。

export interface BoardGeometry {
  rows: number;
  columns: number;
  /** 滚筒地图：列索引 wrap（§2.3） */
  cylindrical: boolean;
}

/** 0 基偶数行（不右移）邻居表：以 [dc, dr] 表示（col 增量, row 增量），固定顺序 */
const EVEN_ROW_DELTAS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, -1],
  [-1, -1],
  [0, 1],
  [-1, 1],
];

/** 0 基奇数行（右移半格）邻居表 */
const ODD_ROW_DELTAS: readonly [number, number][] = [
  [1, 0],
  [-1, 0],
  [1, -1],
  [0, -1],
  [1, 1],
  [0, 1],
];

export function rowOf(index: number, columns: number): number {
  return Math.floor(index / columns);
}

export function colOf(index: number, columns: number): number {
  return index % columns;
}

export function rcToIndex(row: number, col: number, columns: number): number {
  return row * columns + col;
}

/** 邻接地块（距离 1），按邻居表固定顺序返回；越界排除；滚筒地图列 wrap（§2.3） */
export function neighborsOf(index: number, geo: BoardGeometry): number[] {
  const row = rowOf(index, geo.columns);
  const col = colOf(index, geo.columns);
  const deltas = row % 2 === 0 ? EVEN_ROW_DELTAS : ODD_ROW_DELTAS;
  const result: number[] = [];
  for (const [dc, dr] of deltas) {
    const r = row + dr;
    if (r < 0 || r >= geo.rows) continue;
    let c = col + dc;
    if (c < 0 || c >= geo.columns) {
      if (!geo.cylindrical) continue;
      c = ((c % geo.columns) + geo.columns) % geo.columns;
    }
    result.push(r * geo.columns + c);
  }
  return result;
}

/** 是否邻接（含滚筒 wrap） */
export function areAdjacent(a: number, b: number, geo: BoardGeometry): boolean {
  return neighborsOf(a, geo).includes(b);
}
