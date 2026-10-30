// PVE 后端测试夹具：小地图 + PVE 座位分配
import type { BattlefieldTile, MapFullData, SeatAssignment } from '@dl/shared';

export interface PveMapOptions {
  id?: string;
  title?: string;
  row?: number;
  column?: number;
  playerNum?: number;
}

/** 4x5 小地图：每个势力一个据点（index = seat-1），其余平原无主 */
export function pveMapJson(opts: PveMapOptions = {}): MapFullData {
  const row = opts.row ?? 4;
  const column = opts.column ?? 5;
  const playerNum = opts.playerNum ?? 2;
  const battlefield: BattlefieldTile[] = Array.from({ length: row * column }, (_, i) => [0, 128, 0]);
  for (let seat = 1; seat <= playerNum; seat++) {
    battlefield[seat - 1] = [1, seat, 5];
  }
  return {
    id: opts.id ?? 'pve-test',
    version: 1,
    title: opts.title ?? 'PVE 测试图',
    description: 'test',
    author: 'test',
    timestamp: '2026-01-01 00:00:00.0',
    row,
    column,
    random_spawn: false,
    cylindrical_map: false,
    fog_mode: false,
    online_time_settings: { total_time: 600, round_time: 60, time_bonus: 0 },
    tags: [],
    player_num: playerNum,
    player_list: Array.from({ length: playerNum }, (_, i) => ({
      name: `势力${i + 1}`,
      team: i + 1,
      computer: 255,
      seat: i + 1,
      flag: i + 1,
    })),
    battlefield,
  };
}

/** PVE 座位：seat1 为玩家，其余 AI 简单 */
export function pveSeatAssignments(map: MapFullData, humanUserId = 1): SeatAssignment[] {
  return map.player_list.map((p) => ({
    seat: p.seat,
    playerId: p.seat === 1 ? humanUserId : null,
    isAI: p.seat !== 1,
    ...(p.seat === 1 ? {} : { computer: 1 }),
  }));
}
