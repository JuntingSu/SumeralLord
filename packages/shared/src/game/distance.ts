// 整数距离：odd-r → axial/cube 换算，distance = max(|dq|, |dr|, |dq+dr|)（规则 v2 §2.4）
// 滚筒地图按列 wrap 取最小值；全程整数运算（P7）。
import type { BoardGeometry } from './coord.js';
import { rowOf, colOf } from './coord.js';

/** odd-r offset → axial（q = col - (row - (row&1)) / 2） */
export function axialOf(index: number, geo: BoardGeometry): { q: number; r: number } {
  const row = rowOf(index, geo.columns);
  const col = colOf(index, geo.columns);
  return { q: col - ((row - (row & 1)) >> 1), r: row };
}

function cubeDistance(dq: number, dr: number): number {
  const ds = dq + dr;
  return Math.max(Math.abs(dq), Math.abs(dr), Math.abs(ds));
}

/** 两地块整数距离（滚筒地图取水平 wrap 后最小值） */
export function hexDistance(a: number, b: number, geo: BoardGeometry): number {
  const qa = axialOf(a, geo);
  const qb = axialOf(b, geo);
  let dq = qb.q - qa.q;
  const dr = qb.r - qa.r;
  if (geo.cylindrical && geo.columns > 0) {
    // 水平环绕一周 = q ± columns（行不变）；取最近倍数
    dq -= Math.round(dq / geo.columns) * geo.columns;
  }
  return cubeDistance(dq, dr);
}
