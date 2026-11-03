// 战争迷雾三档计算（前端规划 §4.3）：visible / explored / hidden。
// 装饰性定位（WS 明文含全部意图），由房间 fogMode 开关决定是否启用。
// 滚筒地图（cylindrical）：邻居计算需列 wrap——复用 shared neighborsOf。
import type { BoardGeometry } from '@dl/shared';
import { neighborsOf } from '@dl/shared';

export type FogLevel = 'visible' | 'explored' | 'hidden';

/** 计算指定视角（观战/无迷雾时全 visible）下各地块的迷雾档位 */
export interface FogOverrides {
  enabled?: boolean;
  revealed: number[];
  hidden: number[];
}

export function computeFog(
  rows: number,
  columns: number,
  cylindrical: boolean,
  /** 视角所属势力的所有兵所在地块（观战/null → 全 visible） */
  mySoldierTiles: number[],
  fogEnabled: boolean,
  /** 上一回合的 explored 集合（跨回合保留已探索记忆） */
  prevExplored: ReadonlySet<number>,
  /** 战役触发器覆盖：enabled 强制开关；revealed 永久揭示；hidden 强制隐藏；revealed 优先 */
  overrides?: FogOverrides | null,
): { levels: FogLevel[]; explored: Set<number> } {
  const total = rows * columns;
  const levels: FogLevel[] = new Array(total).fill('hidden');
  const enabled = overrides?.enabled ?? fogEnabled;
  if (!enabled) {
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
  if (overrides) {
    for (const t of overrides.hidden) {
      if (t < 0 || t >= total) continue;
      levels[t] = 'hidden';
      explored.delete(t);
    }
    for (const t of overrides.revealed) {
      if (t < 0 || t >= total) continue;
      levels[t] = 'visible';
      explored.add(t);
    }
  }
  return { levels, explored };
}
