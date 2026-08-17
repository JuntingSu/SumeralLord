import { create } from 'zustand';
import type { RoomData, RoomListItem } from '@dl/shared';
import { getMyRoom, getRoom, joinRoom, leaveRoom, listRooms } from '../api/room';
import { useAuth } from './auth';

const JOINED_KEY = 'dl_room_id';

interface LobbyState {
  rooms: RoomListItem[];
  joinedRoom: RoomData | null;
  refreshRooms: () => Promise<void>;
  refreshJoined: () => Promise<void>;
  join: (room: RoomListItem, options: { asSpectator: boolean; password?: string }) => Promise<void>;
  leave: () => Promise<void>;
  setJoined: (room: RoomData | null) => void;
}

export const useLobby = create<LobbyState>((set, get) => ({
  rooms: [],
  joinedRoom: null,

  refreshRooms: async () => {
    set({ rooms: await listRooms() });
  },

  // 刷新已加入房间：以服务器为准（换账号/被踢/解散/本地缓存丢失均自动校正）
  refreshJoined: async () => {
    const cachedId = localStorage.getItem(JOINED_KEY);
    if (cachedId) {
      try {
        const room = await getRoom(cachedId);
        const me = useAuth.getState().user?.id;
        if (me && room.players.some((p) => p.id === me)) {
          set({ joinedRoom: room });
          return;
        }
      } catch {
        // 缓存失效，回退到服务器查询
      }
    }
    const mine = await getMyRoom().catch(() => null);
    if (mine) {
      localStorage.setItem(JOINED_KEY, mine.id);
      set({ joinedRoom: mine });
    } else {
      localStorage.removeItem(JOINED_KEY);
      set({ joinedRoom: null });
    }
  },

  join: async (room, options) => {
    const result = await joinRoom(room.id, options);
    localStorage.setItem(JOINED_KEY, result.room.id);
    set({ joinedRoom: result.room });
    await get().refreshRooms();
  },

  leave: async () => {
    const current = get().joinedRoom;
    if (!current) return;
    await leaveRoom(current.id);
    localStorage.removeItem(JOINED_KEY);
    set({ joinedRoom: null });
    await get().refreshRooms();
  },

  setJoined: (room) => {
    if (room) localStorage.setItem(JOINED_KEY, room.id);
    else localStorage.removeItem(JOINED_KEY);
    set({ joinedRoom: room });
  },
}));
