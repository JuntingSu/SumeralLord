import { create } from 'zustand';
import type { RoomData, RoomServerMsg } from '@dl/shared';
import type { WsStatus } from '../ws/client';

export interface ChatEntry {
  from: number;
  username: string;
  text: string;
  ts: number;
  /** 系统通知（局内本地生成，非玩家发言；聊天为橙色样式） */
  kind?: 'system';
}

const CHAT_LIMIT = 200;

interface RoomState {
  room: RoomData | null;
  chat: ChatEntry[];
  connection: WsStatus;
  notice: string | null;
  setRoom: (room: RoomData | null) => void;
  setConnection: (status: WsStatus) => void;
  setNotice: (notice: string | null) => void;
  clearNotice: () => void;
  applyServer: (msg: RoomServerMsg) => void;
  reset: () => void;
}

/** 把服务器推送应用到本地房间副本（增量更新，避免每条消息都拉全量） */
function applyToRoom(room: RoomData, msg: RoomServerMsg): RoomData {
  switch (msg.type) {
    case 'PLAYER_JOIN':
      if (room.players.some((p) => p.id === msg.player.id)) return room;
      return { ...room, players: [...room.players, msg.player] };
    case 'PLAYER_LEAVE':
      return {
        ...room,
        players: room.players.filter((p) => p.id !== msg.playerId),
        hostId: msg.newHostId ?? room.hostId,
      };
    case 'PLAYER_READY':
      return {
        ...room,
        players: room.players.map((p) =>
          p.id === msg.playerId ? { ...p, state: msg.ready ? ('prepared' as const) : ('unready' as const) } : p,
        ),
      };
    case 'HOST_TRANSFER':
      return { ...room, hostId: msg.newHostId };
    case 'ROOM_UPDATE':
      return msg.room;
    case 'FORCE_SELECT':
      return {
        ...room,
        forces: room.forces.map((f) => (f.seat === msg.seat ? { ...f, playerId: msg.playerId } : f)),
      };
    default:
      return room;
  }
}

export const useRoom = create<RoomState>((set, get) => ({
  room: null,
  chat: [],
  connection: 'connecting',
  notice: null,

  setRoom: (room) => set({ room }),
  setConnection: (connection) => set({ connection }),
  setNotice: (notice) => set({ notice }),
  clearNotice: () => set({ notice: null }),

  applyServer: (msg) => {
    const { room, chat } = get();
    if (msg.type === 'CHAT') {
      const nextChat = [...chat, { from: msg.from, username: msg.username, text: msg.text, ts: msg.ts }];
      set({ chat: nextChat.slice(-CHAT_LIMIT) });
      return;
    }
    if (msg.type === 'ROOM_DISBANDED') {
      set({
        room: null,
        notice: msg.reason === 'idle_timeout' ? '房间长时间无活动，已自动解散' : '房间已被房主解散',
      });
      return;
    }
    if (msg.type === 'CONNECT_ACK' || msg.type === 'PONG' || msg.type === 'ERROR') return;
    if (room) set({ room: applyToRoom(room, msg) });
  },

  reset: () => set({ room: null, chat: [], connection: 'connecting', notice: null }),
}));
