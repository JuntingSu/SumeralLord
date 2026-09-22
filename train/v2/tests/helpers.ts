// helpers.ts — v2 测试公共设施：构造小型测试地图
import type { MapFullData } from '@dl/shared';

/**
 * 构造小型测试地图（rows×cols）：左下 = seat1 据点（兵力 3），右上 = seat2 据点（兵力 4），
 * 其余平原。双方各 1 兵 1 据点，用于掩码/编码/驱动单测。
 */
export function makeTestMap(rows = 5, cols = 5): MapFullData {
  const battlefield: [number, number, number][] = [];
  for (let i = 0; i < rows * cols; i++) battlefield.push([0, 128, 0]);
  const idx = (r: number, c: number) => r * cols + c;
  battlefield[idx(0, 0)] = [1, 1, 3];
  battlefield[idx(rows - 1, cols - 1)] = [1, 2, 4];
  return {
    id: 'test-map',
    version: 1,
    title: 'test map',
    description: 'test map',
    author: 'test',
    timestamp: '2026-09-21 00:00:00.0000000',
    row: rows,
    column: cols,
    random_spawn: false,
    cylindrical_map: false,
    fog_mode: false,
    online_time_settings: { total_time: 600, round_time: 60, time_bonus: 0 },
    tags: ['test'],
    player_num: 2,
    player_list: [
      { name: 'P1', team: 1, computer: 255, seat: 1, flag: 1 },
      { name: 'P2', team: 2, computer: 255, seat: 2, flag: 2 },
    ],
    battlefield,
  };
}
