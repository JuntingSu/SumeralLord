// 测试辅助：小地图构造与对局快捷驱动
import type { MapFullData, BattlefieldTile } from '../src/index.js';
import type { ApplyResult, GameState, InitStateResult, PlayerIntent, SeatAssignment } from '../src/index.js';
import { initState, applyIntent } from '../src/index.js';

export const PLAIN = 0;
export const CITY = 1;
export const OCEAN = 3;
export const MOUNTAIN = 4;
export const VOID = 5;
export const EMPTY = 128;
export const WILD = 0;
export const BLOCKER = 255;

export interface MapSpec {
  rows?: number;
  columns?: number;
  cylindrical?: boolean;
  players?: Array<{ seat: number; team?: number; computer?: number; flag?: number; name?: string }>;
  /** 稀疏覆盖：index → [terrain, belongs, strength]，未列出的地块为 [平原, 无主, 0] */
  tiles?: Record<number, [number, number, number]>;
}

export function makeMap(spec: MapSpec = {}): MapFullData {
  const rows = spec.rows ?? 4;
  const columns = spec.columns ?? 5;
  const players = spec.players ?? [
    { seat: 1, team: 1, flag: 1, name: '红方' },
    { seat: 2, team: 2, flag: 2, name: '蓝方' },
  ];
  const battlefield: BattlefieldTile[] = [];
  for (let i = 0; i < rows * columns; i++) {
    const t = spec.tiles?.[i];
    battlefield.push(t ? [t[0], t[1], t[2]] : [PLAIN, EMPTY, 0]);
  }
  return {
    id: 'test-map',
    version: 1,
    title: '测试图',
    description: '',
    author: 'test',
    timestamp: '2026-08-16 00:00:00.0',
    row: rows,
    column: columns,
    random_spawn: false,
    cylindrical_map: spec.cylindrical ?? false,
    fog_mode: false,
    online_time_settings: { total_time: 600, round_time: 60, time_bonus: 0 },
    tags: [],
    player_num: players.length,
    player_list: players.map((p) => ({
      name: p.name ?? `势力${p.seat}`,
      team: p.team ?? p.seat,
      computer: p.computer ?? 255,
      seat: p.seat,
      flag: p.flag ?? (p.seat % 9) + 1,
    })),
    battlefield,
  };
}

export const DEFAULT_TIME = { stepTime: 90, gameTime: 1200, additionalTime: 0 };

export function assignments(...list: Array<{ seat: number; playerId?: number | null; isAI?: boolean }>): SeatAssignment[] {
  return list.map((a) => ({ seat: a.seat, playerId: a.playerId ?? null, isAI: a.isAI ?? false }));
}

export function startGame(map: MapFullData, seatAssignments: SeatAssignment[] = assignments({ seat: 1, playerId: 1 }, { seat: 2, playerId: 2 })): InitStateResult {
  return initState({ map, seatAssignments, timeSettings: DEFAULT_TIME });
}

export function act(state: GameState, seat: number, intent: PlayerIntent): ApplyResult {
  return applyIntent(state, { actor: { kind: 'PLAYER', seat }, intent });
}

export function actServer(state: GameState, intent: PlayerIntent): ApplyResult {
  return applyIntent(state, { actor: { kind: 'SERVER' }, intent });
}

export function force(state: GameState, seat: number) {
  const f = state.forces.find((x) => x.seat === seat);
  if (!f) throw new Error(`force ${seat} 不存在`);
  return f;
}

export function soldierAt(state: GameState, index: number) {
  return state.tiles[index].soldier;
}

export function chainKinds(result: ApplyResult | { chain: Array<{ kind: string }> }): string[] {
  if ('ok' in result && !result.ok) return [];
  return (result as { chain: Array<{ kind: string }> }).chain.map((e) => e.kind);
}
