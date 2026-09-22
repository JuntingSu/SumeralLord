// mapgen.test.ts — 阶段 0：地图生成器与图池单测（设计方案 §7 / §10）
import { describe, expect, it } from 'vitest';
import { TERRAIN, TILE_OWNER, initState } from '@dl/shared';
import {
  FIRST_SEAT_STRENGTH,
  SECOND_SEAT_STRENGTH,
  generateTrainMap,
  strongholdDistance,
  strongholdsLandConnected,
  walkableConnected,
} from '../lib/mapgen.js';

const TIME_SETTINGS = { stepTime: 30, gameTime: 600, additionalTime: 10 };

/** 训练对局双方势力构造（设计方案 §9 默认项 4）：isAI=false + 非空虚拟 playerId */
export function trainSeatAssignments() {
  return [
    { seat: 1, playerId: 900001, isAI: false },
    { seat: 2, playerId: 900002, isAI: false },
  ];
}

describe('generateTrainMap（mode=plain 移植）', () => {
  it('尺寸在 row∈[9,15]、column∈[11,17] 内，可走格全连通', () => {
    for (let i = 0; i < 10; i++) {
      const { map } = generateTrainMap(`t-${i}`);
      expect(map.row).toBeGreaterThanOrEqual(9);
      expect(map.row).toBeLessThanOrEqual(15);
      expect(map.column).toBeGreaterThanOrEqual(11);
      expect(map.column).toBeLessThanOrEqual(17);
      expect(map.battlefield).toHaveLength(map.row * map.column);
      expect(walkableConnected(map.battlefield, map.row, map.column)).toBe(true);
    }
  });

  it('恰好两座有主据点：先手 seat1 兵力 3、后手 seat2 兵力 4；其余 CITY 为无主空据点', () => {
    for (let i = 0; i < 10; i++) {
      const { map } = generateTrainMap(`t-${i}`);
      const s1 = map.battlefield.find(([, owner]) => owner === 1)!;
      const s2 = map.battlefield.find(([, owner]) => owner === 2)!;
      expect(s1[0]).toBe(TERRAIN.CITY);
      expect(s2[0]).toBe(TERRAIN.CITY);
      expect(s1[2]).toBe(FIRST_SEAT_STRENGTH);
      expect(s2[2]).toBe(SECOND_SEAT_STRENGTH);
      // 权重含 2% 随机据点：其余 CITY 均为无主（128）空据点（无兵）
      for (const [terrain, owner, strength] of map.battlefield) {
        if (terrain === TERRAIN.CITY && owner !== 1 && owner !== 2) {
          expect(owner).toBe(TILE_OWNER.EMPTY);
          expect(strength).toBe(0);
        }
      }
    }
  });

  it('player_list：2 势力、不同队伍、座次 1/2', () => {
    const { map } = generateTrainMap('t-players');
    expect(map.player_num).toBe(2);
    expect(map.player_list).toHaveLength(2);
    expect(map.player_list[0].seat).toBe(1);
    expect(map.player_list[1].seat).toBe(2);
    expect(map.player_list[0].team).not.toBe(map.player_list[1].team);
  });

  it('敌我初始据点必须能通过平原/据点连通（2026-09-20 新增检查；生成器保证满足）', () => {
    for (let i = 0; i < 10; i++) {
      const { map } = generateTrainMap(`t-land-${i}`);
      expect(strongholdsLandConnected(map.battlefield, map.row, map.column)).toBe(true);
    }
  });

  it('出生据点间距 > 4（2026-09-21 新增检查；生成器保证满足）', () => {
    for (let i = 0; i < 10; i++) {
      const { map } = generateTrainMap(`t-dist-${i}`);
      expect(strongholdDistance(map.battlefield, map.row, map.column)).toBeGreaterThan(4);
    }
  });
});

describe('strongholdsLandConnected（校验函数）', () => {
  it('两据点间有纯平原/据点路径 → true', () => {
    const battlefield: Array<[number, number, number]> = [
      [TERRAIN.CITY, 1, 3], // 0 我城
      [TERRAIN.PLAIN, TILE_OWNER.EMPTY, 0],
      [TERRAIN.PLAIN, TILE_OWNER.EMPTY, 0],
      [TERRAIN.CITY, 2, 4], // 3 敌城（1x4 行内直连）
    ];
    expect(strongholdsLandConnected(battlefield, 1, 4)).toBe(true);
  });

  it('两据点被海洋隔断（无纯平原/据点路径）→ false', () => {
    const battlefield: Array<[number, number, number]> = [
      [TERRAIN.CITY, 1, 3], // 0 我城
      [TERRAIN.OCEAN, TILE_OWNER.EMPTY, 0], // 海洋隔断
      [TERRAIN.OCEAN, TILE_OWNER.EMPTY, 0],
      [TERRAIN.CITY, 2, 4], // 3 敌城
    ];
    // 注意：海洋可走（walkableConnected 仍 true），但平原/据点连通失败
    expect(walkableConnected(battlefield, 1, 4)).toBe(true);
    expect(strongholdsLandConnected(battlefield, 1, 4)).toBe(false);
  });

  it('据点数量不为 2 → false', () => {
    const battlefield: Array<[number, number, number]> = [
      [TERRAIN.CITY, 1, 3],
      [TERRAIN.PLAIN, TILE_OWNER.EMPTY, 0],
      [TERRAIN.PLAIN, TILE_OWNER.EMPTY, 0],
    ];
    expect(strongholdsLandConnected(battlefield, 1, 3)).toBe(false);
  });
});

describe('strongholdDistance（出生据点间距）', () => {
  it('同排 1x5：城0 与 城4 距离 4（拒绝）；1x6：城0 与 城5 距离 5（通过）', () => {
    const near: Array<[number, number, number]> = [
      [TERRAIN.CITY, 1, 3],
      [TERRAIN.PLAIN, TILE_OWNER.EMPTY, 0],
      [TERRAIN.PLAIN, TILE_OWNER.EMPTY, 0],
      [TERRAIN.PLAIN, TILE_OWNER.EMPTY, 0],
      [TERRAIN.CITY, 2, 4],
    ];
    expect(strongholdDistance(near, 1, 5)).toBe(4); // ≤4 → 拒绝
    const far: Array<[number, number, number]> = [
      [TERRAIN.CITY, 1, 3],
      [TERRAIN.PLAIN, TILE_OWNER.EMPTY, 0],
      [TERRAIN.PLAIN, TILE_OWNER.EMPTY, 0],
      [TERRAIN.PLAIN, TILE_OWNER.EMPTY, 0],
      [TERRAIN.PLAIN, TILE_OWNER.EMPTY, 0],
      [TERRAIN.CITY, 2, 4],
    ];
    expect(strongholdDistance(far, 1, 6)).toBe(5); // >4 → 通过
  });

  it('据点数量不为 2 → −1', () => {
    const one: Array<[number, number, number]> = [
      [TERRAIN.CITY, 1, 3],
      [TERRAIN.PLAIN, TILE_OWNER.EMPTY, 0],
    ];
    expect(strongholdDistance(one, 1, 2)).toBe(-1);
  });
});

describe('initState 接受训练地图', () => {
  it('双方势力存活、据点兵力 3/4、出生兵为连兵', () => {
    const { map } = generateTrainMap('t-init');
    const { state } = initState({
      map,
      seatAssignments: trainSeatAssignments(),
      seed: 'test-seed',
      timeSettings: TIME_SETTINGS,
    });
    expect(state.finished).toBe(false);
    expect(state.forces).toHaveLength(2);
    expect(state.forces[0].exists).toBe(true);
    expect(state.forces[0].alive).toBe(true);
    expect(state.forces[1].exists).toBe(true);
    expect(state.forces[1].alive).toBe(true);
    expect(state.forces.map((f) => f.playerId)).toEqual([900001, 900002]);

    // 有兵据点 = 双方出生据点；无主空据点无兵
    const cityTiles = state.tiles.filter((t) => t.terrain === TERRAIN.CITY && t.soldier !== null);
    expect(cityTiles).toHaveLength(2);
    const strengths = cityTiles.map((t) => t.soldier?.strength).sort();
    expect(strengths).toEqual([FIRST_SEAT_STRENGTH, SECOND_SEAT_STRENGTH]);
    for (const t of cityTiles) {
      expect(t.soldier?.isLinked).toBe(true); // 全接地形初始化后为连兵
      expect(t.soldier?.owner).toBeGreaterThanOrEqual(1);
    }
  });
});
