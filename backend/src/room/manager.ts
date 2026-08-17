import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { ROOMS } from '@dl/shared';
import type { ErrorCode, MapFullData, RoomData, RoomForce, RoomListItem, RoomManagerEvent } from '@dl/shared';

export class RoomError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RoomError';
  }
}

interface RoomPlayerInternal {
  id: number;
  username: string;
  flag: number;
  state: 'unready' | 'prepared' | 'spectating';
  online: boolean;
  joinedAt: number;
}

interface Room {
  id: string;
  name: string;
  passwordHash: string | null;
  hostId: number;
  allowSpectate: boolean;
  fogMode: boolean;
  randomSpawn: boolean;
  aiTakeover: boolean;
  mapId: string;
  mapTitle: string;
  mapPlayerNum: number;
  timeSettings: { stepTime: number; gameTime: number; additionalTime: number };
  status: 'ROOM_OPEN' | 'IN_GAME';
  players: Map<number, RoomPlayerInternal>;
  forces: RoomForce[];
  createdAt: number;
  lastActivityAt: number;
}

export interface RoomUser {
  id: number;
  username: string;
  flag: number;
}

export interface RoomManagerOptions {
  idleMs?: number;
  sweepIntervalMs?: number;
  /** 状态变更事件回调（WS 网关广播源） */
  onEvent?: (event: RoomManagerEvent) => void;
}

/** 地图 player_list → 房间势力（出生王城在 battlefield 中，房间层只关心元信息） */
function toRoomForces(map: MapFullData): RoomForce[] {
  return map.player_list.map((p) => ({ seat: p.seat, team: p.team, name: p.name, flag: p.flag, playerId: null }));
}

/** 房间内存状态机（单进程；WS 推送在 BM3 接入，本层只管状态与校验） */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly opts: RoomManagerOptions = {}) {
    this.sweeper = setInterval(() => this.sweep(), this.opts.sweepIntervalMs ?? ROOMS.SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  private emit(event: RoomManagerEvent): void {
    this.opts.onEvent?.(event);
  }

  create(
    host: RoomUser,
    body: {
      name: string;
      password?: string;
      allowSpectate: boolean;
      fogMode: boolean;
      randomSpawn: boolean;
      aiTakeover?: boolean;
      timeSettings: { stepTime: number; gameTime: number; additionalTime: number };
    },
    map: MapFullData,
  ): RoomData {
    const id = 'r' + randomUUID().replace(/-/g, '').slice(0, 8);
    const now = Date.now();
    const room: Room = {
      id,
      name: body.name,
      passwordHash: body.password ? bcrypt.hashSync(body.password, 10) : null,
      hostId: host.id,
      allowSpectate: body.allowSpectate,
      fogMode: body.fogMode,
      randomSpawn: body.randomSpawn,
      aiTakeover: body.aiTakeover ?? false,
      mapId: map.id,
      mapTitle: map.title,
      mapPlayerNum: map.player_num,
      timeSettings: body.timeSettings,
      status: 'ROOM_OPEN',
      players: new Map([[host.id, { ...host, state: 'unready', online: false, joinedAt: now }]]),
      forces: toRoomForces(map),
      createdAt: now,
      lastActivityAt: now,
    };
    this.rooms.set(id, room);
    return this.toRoomData(room);
  }

  get(id: string): Room | undefined {
    return this.rooms.get(id);
  }

  mustGet(id: string): Room {
    const room = this.rooms.get(id);
    if (!room) throw new RoomError('ROOM_NOT_FOUND', '房间不存在');
    return room;
  }

  listItems(status?: 'waiting' | 'in_game'): RoomListItem[] {
    return [...this.rooms.values()]
      .filter((r) => !status || (r.status === 'ROOM_OPEN' ? 'waiting' : 'in_game') === status)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .map((r) => this.toListItem(r));
  }

  findRoomOfPlayer(userId: number): Room | undefined {
    for (const room of this.rooms.values()) {
      if (room.players.has(userId)) return room;
    }
    return undefined;
  }

  join(user: RoomUser, roomId: string, body: { password?: string; asSpectator: boolean }): RoomData {
    const room = this.mustGet(roomId);
    this.touch(room);
    if (room.players.has(user.id)) return this.toRoomData(room); // 幂等重入
    if (room.status === 'IN_GAME' && !body.asSpectator) {
      throw new RoomError('GAME_IN_PROGRESS', '对局进行中，仅可观战加入');
    }
    if (body.asSpectator && !room.allowSpectate) {
      throw new RoomError('SPECTATE_NOT_ALLOWED', '该房间不允许观战');
    }
    if (room.passwordHash && !bcrypt.compareSync(body.password ?? '', room.passwordHash)) {
      throw new RoomError('PASSWORD_WRONG', '房间密码错误');
    }
    const spectators = this.spectatorCount(room);
    if (body.asSpectator) {
      if (spectators >= ROOMS.SPECTATOR_LIMIT) throw new RoomError('SPECTATOR_LIMIT', '观战人数已满');
    } else if (room.players.size - spectators >= room.mapPlayerNum) {
      throw new RoomError('ROOM_FULL', '房间已满');
    }
    room.players.set(user.id, {
      ...user,
      state: body.asSpectator ? 'spectating' : 'unready',
      online: false,
      joinedAt: Date.now(),
    });
    this.emit({ type: 'PLAYER_JOIN', roomId: room.id, player: this.toRoomPlayer(room, user.id) });
    return this.toRoomData(room);
  }

  /** 准备/取消准备（观战与对局中不可准备） */
  setReady(userId: number, roomId: string, ready: boolean): void {
    const room = this.mustGet(roomId);
    this.touch(room);
    const player = room.players.get(userId);
    if (!player) throw new RoomError('NOT_IN_ROOM', '你不在该房间中');
    if (player.state === 'spectating') throw new RoomError('INVALID_PARAMS', '观战玩家无需准备');
    if (room.status !== 'ROOM_OPEN') throw new RoomError('INVALID_PARAMS', '对局已开始');
    player.state = ready ? 'prepared' : 'unready';
    this.emit({ type: 'PLAYER_READY', roomId: room.id, playerId: userId, ready });
  }

  /** 选择势力（seat=-1 取消自己的选择；先到先得） */
  selectForce(userId: number, roomId: string, seat: number): RoomData {
    const room = this.mustGet(roomId);
    this.touch(room);
    const player = room.players.get(userId);
    if (!player) throw new RoomError('NOT_IN_ROOM', '你不在该房间中');
    if (player.state === 'spectating') throw new RoomError('INVALID_PARAMS', '观战玩家不能选择势力');
    if (room.status !== 'ROOM_OPEN') throw new RoomError('INVALID_PARAMS', '对局已开始');

    if (seat === -1) {
      for (const force of room.forces) {
        if (force.playerId === userId) {
          force.playerId = null;
          this.emit({ type: 'FORCE_SELECT', roomId: room.id, seat: force.seat, playerId: null });
        }
      }
      return this.toRoomData(room);
    }
    const force = room.forces.find((f) => f.seat === seat);
    if (!force) throw new RoomError('INVALID_PARAMS', '势力不存在');
    if (force.playerId !== null && force.playerId !== userId) {
      throw new RoomError('FORCE_TAKEN', '该势力已被其他玩家选择');
    }
    // 一个玩家只占一个 seat：清掉旧占用再落位
    for (const f of room.forces) {
      if (f.playerId === userId && f.seat !== seat) {
        f.playerId = null;
        this.emit({ type: 'FORCE_SELECT', roomId: room.id, seat: f.seat, playerId: null });
      }
    }
    force.playerId = userId;
    this.emit({ type: 'FORCE_SELECT', roomId: room.id, seat, playerId: userId });
    return this.toRoomData(room);
  }

  /** WS 连接/断开 → 在线标记（变化才广播 ROOM_UPDATE） */
  setOnline(userId: number, roomId: string, online: boolean): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    const player = room.players.get(userId);
    if (!player || player.online === online) return;
    player.online = online;
    this.emit({ type: 'ROOM_UPDATE', roomId: room.id, room: this.toRoomData(room) });
  }

  leave(userId: number, roomId: string): { room: RoomData | null; newHostId?: number } {
    const room = this.mustGet(roomId);
    this.touch(room);
    if (!room.players.delete(userId)) throw new RoomError('NOT_IN_ROOM', '你不在该房间中');
    this.releaseForces(room, userId);
    let newHostId: number | undefined;
    if (room.hostId === userId) {
      const rest = [...room.players.values()].sort((a, b) => a.joinedAt - b.joinedAt);
      const next = rest.find((p) => p.state !== 'spectating') ?? rest[0];
      if (next) {
        room.hostId = next.id;
        newHostId = next.id;
      }
    }
    if (room.players.size === 0) {
      this.rooms.delete(room.id);
      return { room: null, newHostId };
    }
    this.emit({ type: 'PLAYER_LEAVE', roomId: room.id, playerId: userId, ...(newHostId !== undefined ? { newHostId } : {}) });
    return { room: this.toRoomData(room), newHostId };
  }

  kick(hostUserId: number, roomId: string, targetPlayerId: number): RoomData {
    const room = this.mustGet(roomId);
    this.touch(room);
    if (room.hostId !== hostUserId) throw new RoomError('NOT_HOST', '仅房主可执行此操作');
    if (targetPlayerId === hostUserId) throw new RoomError('INVALID_PARAMS', '不能踢出自己，请使用退出或解散');
    if (!room.players.has(targetPlayerId)) throw new RoomError('NOT_IN_ROOM', '该玩家不在房间中');
    room.players.delete(targetPlayerId);
    this.releaseForces(room, targetPlayerId);
    this.emit({ type: 'PLAYER_LEAVE', roomId: room.id, playerId: targetPlayerId });
    return this.toRoomData(room);
  }

  transferHost(hostUserId: number, roomId: string, toPlayerId: number): RoomData {
    const room = this.mustGet(roomId);
    this.touch(room);
    if (room.hostId !== hostUserId) throw new RoomError('NOT_HOST', '仅房主可执行此操作');
    const target = room.players.get(toPlayerId);
    if (!target) throw new RoomError('NOT_IN_ROOM', '该玩家不在房间中');
    if (target.state === 'spectating') throw new RoomError('INVALID_PARAMS', '观战玩家不能成为房主');
    room.hostId = toPlayerId;
    this.emit({ type: 'HOST_TRANSFER', roomId: room.id, newHostId: toPlayerId });
    return this.toRoomData(room);
  }

  changeMap(hostUserId: number, roomId: string, map: MapFullData): RoomData {
    const room = this.mustGet(roomId);
    this.touch(room);
    if (room.hostId !== hostUserId) throw new RoomError('NOT_HOST', '仅房主可执行此操作');
    room.mapId = map.id;
    room.mapTitle = map.title;
    room.mapPlayerNum = map.player_num;
    room.forces = toRoomForces(map);
    const data = this.toRoomData(room);
    this.emit({ type: 'ROOM_UPDATE', roomId: room.id, room: data });
    return data;
  }

  updateSettings(
    hostUserId: number,
    roomId: string,
    patch: {
      name?: string;
      password?: string | null;
      allowSpectate?: boolean;
      fogMode?: boolean;
      randomSpawn?: boolean;
      aiTakeover?: boolean;
      timeSettings?: { stepTime: number; gameTime: number; additionalTime: number };
    },
  ): RoomData {
    const room = this.mustGet(roomId);
    this.touch(room);
    if (room.hostId !== hostUserId) throw new RoomError('NOT_HOST', '仅房主可执行此操作');
    if (patch.name !== undefined) room.name = patch.name;
    if (patch.password !== undefined) room.passwordHash = patch.password ? bcrypt.hashSync(patch.password, 10) : null;
    if (patch.allowSpectate !== undefined) room.allowSpectate = patch.allowSpectate;
    if (patch.fogMode !== undefined) room.fogMode = patch.fogMode;
    if (patch.randomSpawn !== undefined) room.randomSpawn = patch.randomSpawn;
    if (patch.aiTakeover !== undefined) room.aiTakeover = patch.aiTakeover;
    if (patch.timeSettings !== undefined) room.timeSettings = patch.timeSettings;
    const data = this.toRoomData(room);
    this.emit({ type: 'ROOM_UPDATE', roomId: room.id, room: data });
    return data;
  }

  disband(hostUserId: number, roomId: string): void {
    const room = this.mustGet(roomId);
    if (room.hostId !== hostUserId) throw new RoomError('NOT_HOST', '仅房主可执行此操作');
    this.emit({ type: 'ROOM_DISBANDED', roomId: room.id, reason: 'host_disband' });
    this.rooms.delete(room.id);
  }

  private toRoomPlayer(room: Room, userId: number): RoomData['players'][number] {
    const p = room.players.get(userId)!;
    return { id: p.id, username: p.username, flag: p.flag, state: p.state, online: p.online, joinedAt: p.joinedAt };
  }

  /** 离开/被踢时释放该玩家占用的势力（换图前的换选逻辑不复用，这里要逐 seat 广播） */
  private releaseForces(room: Room, userId: number): void {
    for (const force of room.forces) {
      if (force.playerId === userId) {
        force.playerId = null;
        this.emit({ type: 'FORCE_SELECT', roomId: room.id, seat: force.seat, playerId: null });
      }
    }
  }

  toRoomData(room: Room): RoomData {
    return {
      id: room.id,
      name: room.name,
      hostId: room.hostId,
      hasPassword: room.passwordHash !== null,
      allowSpectate: room.allowSpectate,
      fogMode: room.fogMode,
      randomSpawn: room.randomSpawn,
      aiTakeover: room.aiTakeover,
      mapId: room.mapId,
      mapTitle: room.mapTitle,
      playerNum: room.mapPlayerNum,
      timeSettings: room.timeSettings,
      status: room.status === 'ROOM_OPEN' ? 'waiting' : 'in_game',
      players: [...room.players.values()].sort((a, b) => a.joinedAt - b.joinedAt),
      forces: room.forces,
    };
  }

  private toListItem(room: Room): RoomListItem {
    const spectators = this.spectatorCount(room);
    return {
      id: room.id,
      name: room.name,
      currentPlayers: room.players.size - spectators,
      spectatorCount: spectators,
      maxPlayers: room.mapPlayerNum,
      status: room.status === 'ROOM_OPEN' ? 'waiting' : 'in_game',
      hasPassword: room.passwordHash !== null,
      allowSpectate: room.allowSpectate,
    };
  }

  private spectatorCount(room: Room): number {
    let n = 0;
    for (const p of room.players.values()) if (p.state === 'spectating') n++;
    return n;
  }

  private touch(room: Room): void {
    room.lastActivityAt = Date.now();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, room] of this.rooms) {
      // IN_GAME 房间的 4h 硬上限在 BM6 断线治理中接入
      if (room.status === 'ROOM_OPEN' && now - room.lastActivityAt > (this.opts.idleMs ?? ROOMS.IDLE_MS)) {
        this.emit({ type: 'ROOM_DISBANDED', roomId: id, reason: 'idle_timeout' });
        this.rooms.delete(id);
      }
    }
  }

  dispose(): void {
    clearInterval(this.sweeper);
    this.rooms.clear();
  }
}
