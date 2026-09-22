// 战争迷雾三档计算（前端规划 §4.3）：visible / explored / hidden。
// 装饰性定位（WS 明文含全部意图），由房间 fogMode 开关决定是否启用。
// 滚筒地图（cylindrical）：邻居计算需列 wrap——复用 shared neighborsOf。
import type { BoardGeometry } from '@dl/shared';
import { neighborsOf } from '@dl/shared';

export type FogLevel = 'visible' | 'explored' | 'hidden';

/** 计算指定视角（观战/无迷雾时全 visible）下各地块的迷雾档位 */
export function computeFog(
  rows: number,
  columns: number,
  cylindrical: boolean,
  /** 视角所属势力的所有兵所在地块（观战/null → 全 visible） */
  mySoldierTiles: number[],
  fogEnabled: boolean,
  /** 上一回合的 explored 集合（跨回合保留已探索记忆） */
  prevExplored: ReadonlySet<number>,
): { levels: FogLevel[]; explored: Set<number> } {
  const total = rows * columns;
  const levels: FogLevel[] = new Array(total).fill('hidden');
  if (!fogEnabled) {
    return { levels: levels.fill('visible'), explored: new Set<number>() };
  }
  const geo: BoardGeometry = { rows, columns, cylindrical };
  const visible = new Set<number>();
  for (const t of mySoldierTiles) {
    visible.add(t);
    for (const n of neighborsOf(t, geo)) visible.add(n);
  }
  const explored = new Set(prevExplored);
  for (const t of visible) explored.add(t);
  for (let i = 0; i < total; i++) {
    if (visible.has(i)) levels[i] = 'visible';
    else if (explored.has(i)) levels[i] = 'explored';
  }
  return { levels, explored };
}
