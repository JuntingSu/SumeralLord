import { create } from 'zustand';
import { defaultPveSetup, normalizeAiLevel } from '@dl/shared';
import type { MapFullData, PveGameConfig, PveSavePayload, SeatAssignment } from '@dl/shared';

export interface PveRoomState {
  map: MapFullData | null;
  /** 来自 PVE 地图库的 id；本地导入/随机（也来自库但可留 id）为 null 表示不在选择器里 */
  mapId: string | null;
  playerSeat: number | null;
  /** seat → 难度（仅 AI 座位） */
  aiLevels: Record<number, number>;
  fogMode: boolean;
  usePersonalSkin: boolean;
}

type RoomConfigSource = Pick<
  PveGameConfig,
  'map' | 'seatAssignments' | 'fogMode' | 'usePersonalSkin' | 'playerSeat'
>;

const emptyRoom = (): PveRoomState => ({
  map: null,
  mapId: null,
  playerSeat: null,
  aiLevels: {},
  fogMode: false,
  usePersonalSkin: false,
});

function aiLevelsOf(seatAssignments: SeatAssignment[], playerSeat: number): Record<number, number> {
  const levels: Record<number, number> = {};
  for (const a of seatAssignments) {
    if (a.seat === playerSeat || !a.isAI) continue;
    levels[a.seat] = normalizeAiLevel(a.computer ?? 1);
  }
  return levels;
}

interface PveStore {
  room: PveRoomState;
  /** 本局配置：开场/再来一局用 */
  lastGame: PveGameConfig | null;
  /** 从服务端读出的存档：游戏页 load=1 时消费 */
  loadSave: PveSavePayload | null;

  setMap: (map: MapFullData, mapId: string | null) => void;
  clearMap: () => void;
  setPlayerSeat: (seat: number) => void;
  setAiLevel: (seat: number, level: number) => void;
  setFogMode: (on: boolean) => void;
  setUsePersonalSkin: (on: boolean) => void;
  restoreRoomFromConfig: (config: RoomConfigSource) => void;
  resetRoom: () => void;

  setLastGame: (config: PveGameConfig | null) => void;
  setLoadSave: (save: PveSavePayload | null) => void;
  clearLoadSave: () => void;
}

export const usePve = create<PveStore>((set, get) => ({
  room: emptyRoom(),
  lastGame: null,
  loadSave: null,

  setMap: (map, mapId) => {
    const setup = defaultPveSetup(map);
    set({
      room: {
        ...get().room,
        map,
        mapId,
        playerSeat: setup.playerSeat,
        aiLevels: setup.aiLevels,
      },
    });
  },

  clearMap: () => set({ room: { ...get().room, map: null, mapId: null, playerSeat: null, aiLevels: {} } }),

  setPlayerSeat: (seat) => {
    const room = get().room;
    if (!room.map || !room.map.player_list.some((p) => p.seat === seat)) return;
    if (room.playerSeat === seat) return;
    const aiLevels = { ...room.aiLevels };
    if (room.playerSeat !== null) aiLevels[room.playerSeat] = 1;
    delete aiLevels[seat];
    set({ room: { ...room, playerSeat: seat, aiLevels } });
  },

  setAiLevel: (seat, level) => {
    const room = get().room;
    if (room.playerSeat === seat) return;
    set({ room: { ...room, aiLevels: { ...room.aiLevels, [seat]: normalizeAiLevel(level) } } });
  },

  setFogMode: (on) => set({ room: { ...get().room, fogMode: on } }),
  setUsePersonalSkin: (on) => set({ room: { ...get().room, usePersonalSkin: on } }),

  restoreRoomFromConfig: (config) =>
    set({
      room: {
        map: config.map,
        mapId: null,
        playerSeat: config.playerSeat,
        aiLevels: aiLevelsOf(config.seatAssignments, config.playerSeat),
        fogMode: config.fogMode,
        usePersonalSkin: config.usePersonalSkin,
      },
    }),

  resetRoom: () => set({ room: emptyRoom() }),

  setLastGame: (config) => set({ lastGame: config }),
  setLoadSave: (save) => set({ loadSave: save }),
  clearLoadSave: () => set({ loadSave: null }),
}));
