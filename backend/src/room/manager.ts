import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { GAME, ROOMS, AI_LEVEL } from '@dl/shared';
import type {
  ErrorCode,
  GameStartMsg,
  MapFullData,
  RoomData,
  RoomForce,
  RoomListItem,
  RoomManagerEvent,
  SeatAssignment,
  SpawnAssignment,
} from '@dl/shared';

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
  hasSkin: boolean;
  state: 'unready' | 'prepared' | 'spectating' | 'in_game';
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
  usePersonalSkin: boolean;
  mapId: string;
  mapTitle: string;
  mapPlayerNum: number;
  timeSettings: { stepTime: number; gameTime: number; additionalTime: number };
  status: 'ROOM_OPEN' | 'IN_GAME' | 'GAME_OVER';
  players: Map<number, RoomPlayerInternal>;
  forces: RoomForce[];
  gameId?: string;
  createdAt: number;
  lastActivityAt: number;
  /** IN_GAME 硬上限计时起点（startGame 时记录） */
  gameStartedAt?: number;
  /** GAME_OVER 回落计时起点（finishGame 时记录） */
  gameOverAt?: number;
}

export interface RoomUser {
  id: number;
  username: string;
  flag: number;
  /** 是否已上传个人皮肤（头像展示 / 开局换肤判定用） */
  hasSkin: boolean;
}

/** 玩家战绩统计（房间玩家列表展示用；由调用方从 DB 读取，实时序列化） */
export interface PlayerStats {
  score: number;
  wins: number;
  matches: number;
}

export interface RoomManagerOptions {
  idleMs?: number;
  sweepIntervalMs?: number;
  /** IN_GAME 对局硬上限（BM6 idleSweeper，超时解散 game_timeout） */
  gameHardCapMs?: number;
  /** GAME_OVER 结算展示保留时长，超时回落 ROOM_OPEN */
  gameOverRetainMs?: number;
  /** 状态变更事件回调（WS 网关广播源） */
  onEvent?: (event: RoomManagerEvent) => void;
  /** 玩家战绩统计读取（缺省 0；供房间玩家列表显示积分/胜率） */
  statsOf?: (userId: number) => PlayerStats;
}

/** 地图 player_list → 房间势力（出生王城在 battlefield 中，房间层只关心元信息；aiLevel 初始未指定） */
function toRoomForces(map: MapFullData): RoomForce[] {
  return map.player_list.map((p) => ({
    seat: p.seat,
    team: p.team,
    name: p.name,
    flag: p.flag,
    playerId: null,
    aiLevel: null,
  }));
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
      usePersonalSkin?: boolean;
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
      usePersonalSkin: body.usePersonalSkin ?? false,
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

  listItems(status?: 'waiting' | 'in_game' | 'game_over'): RoomListItem[] {
    return [...this.rooms.values()]
      .filter(
        (r) =>
          !status ||
          (r.status === 'ROOM_OPEN' ? 'waiting' : r.status === 'GAME_OVER' ? 'game_over' : 'in_game') === status,
      )
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

  /** 准备/取消准备（观战与对局中不可准备；未选择势力不可准备） */
  setReady(userId: number, roomId: string, ready: boolean): void {
    const room = this.mustGet(roomId);
    this.touch(room);
    const player = room.players.get(userId);
    if (!player) throw new RoomError('NOT_IN_ROOM', '你不在该房间中');
    if (player.state === 'spectating') throw new RoomError('INVALID_PARAMS', '观战玩家无需准备');
    if (room.status === 'IN_GAME') throw new RoomError('INVALID_PARAMS', '对局已开始');
    if (room.status === 'GAME_OVER') throw new RoomError('INVALID_PARAMS', '对局已结束，结算展示中，稍后可再来一局');
    if (ready && !room.forces.some((f) => f.playerId === userId)) {
      throw new RoomError('FORCE_NOT_SELECTED', '请先选择势力再准备');
    }
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
    if (room.status === 'IN_GAME') throw new RoomError('INVALID_PARAMS', '对局已开始');
    if (room.status === 'GAME_OVER') throw new RoomError('INVALID_PARAMS', '对局已结束，结算展示中，稍后可再来一局');

    if (seat === -1) {
      for (const force of room.forces) {
        if (force.playerId === userId) {
          force.playerId = null;
          this.emit({ type: 'FORCE_SELECT', roomId: room.id, seat: force.seat, playerId: null });
        }
      }
      // 取消势力后不再是"已选择势力"的玩家：准备状态同步回落（保持不变式）
      if (player.state === 'prepared') {
        player.state = 'unready';
        this.emit({ type: 'PLAYER_READY', roomId: room.id, playerId: userId, ready: false });
      }
      return this.toRoomData(room);
    }
    const force = room.forces.find((f) => f.seat === seat);
    if (!force) throw new RoomError('INVALID_PARAMS', '势力不存在');
    if (force.aiLevel !== null) throw new RoomError('FORCE_AI_LOCKED', '该势力已指定 AI 难度，不可选择');
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

  /** 房主将某势力上的玩家移出（无论其是否已准备；被移者回落"未选择势力·未准备"状态） */
  kickForce(hostUserId: number, roomId: string, seat: number): RoomData {
    const room = this.mustGet(roomId);
    this.touch(room);
    if (room.hostId !== hostUserId) throw new RoomError('NOT_HOST', '仅房主可执行此操作');
    if (room.status === 'IN_GAME') throw new RoomError('INVALID_PARAMS', '对局已开始');
    if (room.status === 'GAME_OVER') throw new RoomError('INVALID_PARAMS', '对局已结束，结算展示中，稍后可再来一局');
    const force = room.forces.find((f) => f.seat === seat);
    if (!force) throw new RoomError('INVALID_PARAMS', '势力不存在');
    if (force.playerId === null) throw new RoomError('INVALID_PARAMS', '该势力没有玩家');
    if (force.playerId === hostUserId) throw new RoomError('INVALID_PARAMS', '不能移出自己，请使用取消');
    const targetId = force.playerId;
    force.playerId = null;
    this.emit({ type: 'FORCE_SELECT', roomId: room.id, seat: force.seat, playerId: null });
    const target = room.players.get(targetId);
    if (target && target.state === 'prepared') {
      target.state = 'unready';
      this.emit({ type: 'PLAYER_READY', roomId: room.id, playerId: targetId, ready: false });
    }
    return this.toRoomData(room);
  }

  /**
   * 房主为势力指定/清除 AI 难度（AI 接管开启时可用；aiLevel=null 清除指定）。
   * 指定后该势力 AI 专属、玩家不可选取（selectForce 拦截）；已被玩家占据的势力不可指定（先移出）。
   */
  assignForceAiLevel(hostUserId: number, roomId: string, seat: number, aiLevel: number | null): RoomData {
    const room = this.mustGet(roomId);
    this.touch(room);
    if (room.hostId !== hostUserId) throw new RoomError('NOT_HOST', '仅房主可执行此操作');
    if (room.status === 'IN_GAME') throw new RoomError('INVALID_PARAMS', '对局已开始');
    if (room.status === 'GAME_OVER') throw new RoomError('INVALID_PARAMS', '对局已结束，结算展示中，稍后可再来一局');
    if (!room.aiTakeover) throw new RoomError('AI_TAKEOVER_OFF', '请先开启 AI 接管');
    if (
      aiLevel !== null &&
      aiLevel !== AI_LEVEL.EASY &&
      aiLevel !== AI_LEVEL.MEDIUM &&
      aiLevel !== AI_LEVEL.HARD &&
      aiLevel !== AI_LEVEL.LEISURE
    ) {
      throw new RoomError('INVALID_PARAMS', 'AI 难度仅允许 1/2/3/255');
    }
    const force = room.forces.find((f) => f.seat === seat);
    if (!force) throw new RoomError('INVALID_PARAMS', '势力不存在');
    if (force.playerId !== null) {
      throw new RoomError('FORCE_OCCUPIED', '该势力已有玩家，请先将其移出再指定 AI 难度');
    }
    force.aiLevel = aiLevel;
    const data = this.toRoomData(room);
    this.emit({ type: 'ROOM_UPDATE', roomId: room.id, room: data });
    return data;
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
    // 换图视为房间配置变更：已准备玩家回落未准备（观战不变）
    for (const p of room.players.values()) {
      if (p.state === 'prepared') p.state = 'unready';
    }
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
      usePersonalSkin?: boolean;
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
    if (patch.aiTakeover !== undefined) {
      room.aiTakeover = patch.aiTakeover;
      // 关闭 AI 接管：清除全部势力的 AI 难度指定（势力恢复可选取；重新开启后需重新指定）
      if (!patch.aiTakeover) {
        for (const f of room.forces) f.aiLevel = null;
      }
    }
    if (patch.usePersonalSkin !== undefined) room.usePersonalSkin = patch.usePersonalSkin;
    if (patch.timeSettings !== undefined) room.timeSettings = patch.timeSettings;
    const data = this.toRoomData(room);
    this.emit({ type: 'ROOM_UPDATE', roomId: room.id, room: data });
    return data;
  }

  /** 开始对局：房主 + 全员已准备 + 房间等待中；不再要求全部 seat 已分配（M4 备忘） */
  startGame(
    hostUserId: number,
    roomId: string,
    payload: {
      gameId: string;
      seatAssignments: SeatAssignment[];
      spawnAssignments: SpawnAssignment[];
      seed: string;
      reducerVersion: string;
      map: MapFullData;
      timeSettings: { stepTime: number; gameTime: number; additionalTime: number };
    },
  ): RoomData {
    const room = this.mustGet(roomId);
    this.touch(room);
    if (room.hostId !== hostUserId) throw new RoomError('NOT_HOST', '仅房主可执行此操作');
    if (room.status !== 'ROOM_OPEN') throw new RoomError('INVALID_PARAMS', '对局已开始');
    const players = [...room.players.values()].filter((p) => p.state !== 'spectating');
    if (players.length === 0) throw new RoomError('INVALID_PARAMS', '房间内没有可参战玩家');
    if (!players.every((p) => p.state === 'prepared')) {
      throw new RoomError('PLAYERS_NOT_READY', '仍有玩家未准备');
    }
    room.status = 'IN_GAME';
    room.gameId = payload.gameId;
    room.gameStartedAt = Date.now();
    for (const p of room.players.values()) {
      if (p.state !== 'spectating') p.state = 'in_game';
    }
    const startMsg: GameStartMsg = {
      type: 'GAME_START',
      roomId: room.id,
      gameId: payload.gameId,
      map: payload.map,
      seatAssignments: payload.seatAssignments,
      spawnAssignments: payload.spawnAssignments,
      seed: payload.seed,
      timeSettings: payload.timeSettings,
      reducerVersion: payload.reducerVersion,
    };
    this.emit(startMsg);
    return this.toRoomData(room);
  }

  /** 某玩家对局中的 seat（无则 -1；观战 -1） */
  seatOf(roomId: string, userId: number): number {
    const room = this.rooms.get(roomId);
    if (!room) return -1;
    return room.forces.find((f) => f.playerId === userId)?.seat ?? -1;
  }

  gameIdOf(roomId: string): string | undefined {
    return this.rooms.get(roomId)?.gameId;
  }

  /** VICTORY 确认：房间进入 GAME_OVER（结算展示；5min 未重开由 idleSweeper 回落 ROOM_OPEN） */
  finishGame(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'IN_GAME') return;
    room.status = 'GAME_OVER';
    room.gameOverAt = Date.now();
    // 参战玩家状态同步回落 unready（不再显示"对局中"；forces 分配保留待重开）
    for (const p of room.players.values()) {
      if (p.state !== 'spectating') p.state = 'unready';
    }
    this.emit({ type: 'ROOM_UPDATE', roomId: room.id, room: this.toRoomData(room) });
  }

  /** 对局中止（共识分歧/超时）：立即回 ROOM_OPEN、全员 unready，可重开 */
  abortGame(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.status = 'ROOM_OPEN';
    room.gameId = undefined;
    for (const p of room.players.values()) {
      if (p.state !== 'spectating') p.state = 'unready';
    }
    this.emit({ type: 'ROOM_UPDATE', roomId: room.id, room: this.toRoomData(room) });
  }

  /** GAME_OVER 回落 ROOM_OPEN（idleSweeper 5min 超时调用）：全员 unready，forces 分配保留 */
  reopenRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'GAME_OVER') return;
    room.status = 'ROOM_OPEN';
    room.gameId = undefined;
    for (const p of room.players.values()) {
      if (p.state !== 'spectating') p.state = 'unready';
    }
    this.emit({ type: 'ROOM_UPDATE', roomId: room.id, room: this.toRoomData(room) });
  }

  disband(hostUserId: number, roomId: string): void {
    const room = this.mustGet(roomId);
    if (room.hostId !== hostUserId) throw new RoomError('NOT_HOST', '仅房主可执行此操作');
    this.emit({ type: 'ROOM_DISBANDED', roomId: room.id, reason: 'host_disband' });
    this.rooms.delete(room.id);
  }

  private toRoomPlayer(room: Room, userId: number): RoomData['players'][number] {
    const p = room.players.get(userId)!;
    const stats = this.opts.statsOf?.(userId) ?? { score: 0, wins: 0, matches: 0 };
    return {
      id: p.id,
      username: p.username,
      flag: p.flag,
      hasSkin: p.hasSkin,
      state: p.state,
      online: p.online,
      joinedAt: p.joinedAt,
      score: stats.score,
      wins: stats.wins,
      matches: stats.matches,
    };
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
      usePersonalSkin: room.usePersonalSkin,
      mapId: room.mapId,
      mapTitle: room.mapTitle,
      playerNum: room.mapPlayerNum,
      timeSettings: room.timeSettings,
      status: room.status === 'ROOM_OPEN' ? 'waiting' : room.status === 'GAME_OVER' ? 'game_over' : 'in_game',
      players: [...room.players.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((p) => this.toRoomPlayer(room, p.id)),
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
      status: room.status === 'ROOM_OPEN' ? 'waiting' : room.status === 'GAME_OVER' ? 'game_over' : 'in_game',
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
      if (room.status === 'ROOM_OPEN') {
        if (now - room.lastActivityAt > (this.opts.idleMs ?? ROOMS.IDLE_MS)) {
          this.emit({ type: 'ROOM_DISBANDED', roomId: id, reason: 'idle_timeout' });
          this.rooms.delete(id);
        }
      } else if (room.status === 'IN_GAME') {
        // 对局硬上限（P3：僵尸对局治理；参数可配置便于测试加速）
        if (now - (room.gameStartedAt ?? room.createdAt) > (this.opts.gameHardCapMs ?? GAME.GAME_HARD_CAP_MS)) {
          this.emit({ type: 'ROOM_DISBANDED', roomId: id, reason: 'game_timeout' });
          this.rooms.delete(id);
        }
      } else if (room.status === 'GAME_OVER') {
        // 结算展示保留期结束 → 回落 ROOM_OPEN（全员 unready，可再来一局）
        if (now - (room.gameOverAt ?? now) > (this.opts.gameOverRetainMs ?? 5 * 60 * 1000)) {
          this.reopenRoom(id);
        }
      }
    }
  }

  dispose(): void {
    clearInterval(this.sweeper);
    this.rooms.clear();
  }
}
