import type { FastifyReply, FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  ERROR_CODES,
  ChangeMapBodySchema,
  CreateRoomBodySchema,
  ForceRemoveBodySchema,
  JoinRoomBodySchema,
  KickBodySchema,
  ReadyBodySchema,
  RoomSettingsPatchSchema,
  SelectForceBodySchema,
  TransferHostBodySchema,
} from '@dl/shared';
import type { CreateRoomResult, JoinRoomResult, SeatAssignment } from '@dl/shared';
import { users } from '../db/schema.js';
import { RoomError, type RoomUser } from '../room/manager.js';
import { authPreHandler } from '../auth/guard.js';
import { config } from '../config.js';
import { ok, fail } from '../utils/respond.js';

const HTTP_BY_CODE: Record<string, number> = {
  ROOM_NOT_FOUND: 404,
  PASSWORD_WRONG: 403,
  ROOM_FULL: 400,
  SPECTATOR_LIMIT: 400,
  SPECTATE_NOT_ALLOWED: 403,
  GAME_IN_PROGRESS: 409,
  NOT_HOST: 403,
  NOT_IN_ROOM: 400,
  ALREADY_IN_ROOM: 409,
  FORCE_TAKEN: 409,
  FORCE_NOT_SELECTED: 403,
  INVALID_PARAMS: 400,
};

function sendRoomError(reply: FastifyReply, err: unknown): unknown {
  if (err instanceof RoomError) {
    return fail(reply, HTTP_BY_CODE[err.code] ?? 400, err.code, err.message);
  }
  throw err;
}

export const roomRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', authPreHandler);

  /** JWT 身份 + DB 中的旗帜 → 房间玩家档案 */
  function roomUserOf(request: { user?: { userId: number; username: string } }): RoomUser {
    const auth = request.user;
    if (!auth) throw new RoomError('AUTH_FAILED', '未认证');
    const row = app.db.select().from(users).where(eq(users.id, auth.userId)).get();
    return { id: auth.userId, username: auth.username, flag: row?.defaultFlag ?? 1 };
  }

  function parseBody<T>(
    schema: { safeParse: (input: unknown) => { success: boolean; data?: T; error?: { issues: { message: string }[] } } },
    body: unknown,
  ): T {
    const parsed = schema.safeParse(body);
    if (!parsed.success || parsed.data === undefined) {
      throw new RoomError('INVALID_PARAMS', parsed.error?.issues[0]?.message ?? '参数非法');
    }
    return parsed.data;
  }

  app.get('/api/rooms', async (request, reply) => {
    const query = request.query as { status?: 'waiting' | 'in_game' | 'game_over' };
    return ok(reply, app.rooms.listItems(query.status));
  });

  /** 我所在的房间（服务器为准；localStorage 丢失/换设备时恢复状态用） */
  app.get('/api/rooms/mine', async (request, reply) => {
    const user = roomUserOf(request);
    const room = app.rooms.findRoomOfPlayer(user.id);
    return ok(reply, room ? app.rooms.toRoomData(room) : null);
  });

  app.post('/api/rooms', async (request, reply) => {
    try {
      const body = parseBody(CreateRoomBodySchema, request.body);
      const user = roomUserOf(request);
      const map = app.maps.get(body.mapId);
      if (!map) return fail(reply, 400, ERROR_CODES.MAP_NOT_FOUND, '地图不存在');
      if (app.rooms.findRoomOfPlayer(user.id)) {
        return fail(reply, 409, ERROR_CODES.ALREADY_IN_ROOM, '你已在其他房间中，请先退出');
      }
      const room = app.rooms.create(user, body, map);
      return ok(reply, { roomId: room.id, room } satisfies CreateRoomResult);
    } catch (err) {
      return sendRoomError(reply, err);
    }
  });

  app.get('/api/rooms/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      return ok(reply, app.rooms.toRoomData(app.rooms.mustGet(id)));
    } catch (err) {
      return sendRoomError(reply, err);
    }
  });

  app.post('/api/rooms/:id/join', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = parseBody(JoinRoomBodySchema, request.body ?? {});
      const user = roomUserOf(request);
      const existing = app.rooms.findRoomOfPlayer(user.id);
      if (existing && existing.id !== id) {
        return fail(reply, 409, ERROR_CODES.ALREADY_IN_ROOM, '你已在其他房间中，请先退出');
      }
      const room = app.rooms.join(user, id, body);
      return ok(reply, { room } satisfies JoinRoomResult);
    } catch (err) {
      return sendRoomError(reply, err);
    }
  });

  app.post('/api/rooms/:id/ready', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = parseBody(ReadyBodySchema, request.body);
      app.rooms.setReady(roomUserOf(request).id, id, body.ready);
      return ok(reply, undefined, body.ready ? '已准备' : '已取消准备');
    } catch (err) {
      return sendRoomError(reply, err);
    }
  });

  app.post('/api/rooms/:id/select-force', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = parseBody(SelectForceBodySchema, request.body);
      const room = app.rooms.selectForce(roomUserOf(request).id, id, body.seat);
      return ok(reply, room);
    } catch (err) {
      return sendRoomError(reply, err);
    }
  });

  app.post('/api/rooms/:id/force-remove', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = parseBody(ForceRemoveBodySchema, request.body);
      const room = app.rooms.kickForce(roomUserOf(request).id, id, body.seat);
      return ok(reply, room);
    } catch (err) {
      return sendRoomError(reply, err);
    }
  });

  app.post('/api/rooms/:id/start', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const user = roomUserOf(request);
      const roomData = app.rooms.toRoomData(app.rooms.mustGet(id));
      const map = app.maps.get(roomData.mapId);
      if (!map) return fail(reply, 400, ERROR_CODES.MAP_NOT_FOUND, '地图不存在');

      // M4 备忘：isAI = 开启 AI 接管且无玩家扮演；未接管且无玩家的势力开局时由前端删兵
      const seatAssignments: SeatAssignment[] = roomData.forces.map((f) => ({
        seat: f.seat,
        playerId: f.playerId,
        isAI: roomData.aiTakeover && f.playerId === null,
      }));

      const { game, startMsg } = app.games.create({
        roomId: id,
        map,
        seatAssignments,
        aiTakeover: roomData.aiTakeover,
        randomSpawn: roomData.randomSpawn,
        timeSettings: roomData.timeSettings,
        reducerVersion: config.reducerVersion,
      });
      // startGame 校验房主/全员准备，成功后 emit GAME_START（网关广播给房间所有人）
      app.rooms.startGame(user.id, id, {
        gameId: game.id,
        seatAssignments: startMsg.seatAssignments,
        spawnAssignments: startMsg.spawnAssignments,
        seed: game.seed,
        reducerVersion: config.reducerVersion,
        map,
        timeSettings: roomData.timeSettings,
      });
      return ok(reply, { gameId: game.id });
    } catch (err) {
      return sendRoomError(reply, err);
    }
  });

  app.post('/api/rooms/:id/leave', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      app.rooms.leave(roomUserOf(request).id, id);
      return ok(reply, undefined, '已退出房间');
    } catch (err) {
      return sendRoomError(reply, err);
    }
  });

  app.post('/api/rooms/:id/disband', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      app.rooms.disband(roomUserOf(request).id, id);
      return ok(reply, undefined, '房间已解散');
    } catch (err) {
      return sendRoomError(reply, err);
    }
  });

  app.post('/api/rooms/:id/kick', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = parseBody(KickBodySchema, request.body);
      const room = app.rooms.kick(roomUserOf(request).id, id, body.playerId);
      return ok(reply, room);
    } catch (err) {
      return sendRoomError(reply, err);
    }
  });

  app.post('/api/rooms/:id/transfer-host', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = parseBody(TransferHostBodySchema, request.body);
      const room = app.rooms.transferHost(roomUserOf(request).id, id, body.toPlayerId);
      return ok(reply, room);
    } catch (err) {
      return sendRoomError(reply, err);
    }
  });

  app.post('/api/rooms/:id/change-map', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = parseBody(ChangeMapBodySchema, request.body);
      const map = app.maps.get(body.mapId);
      if (!map) return fail(reply, 400, ERROR_CODES.MAP_NOT_FOUND, '地图不存在');
      const room = app.rooms.changeMap(roomUserOf(request).id, id, map);
      return ok(reply, room);
    } catch (err) {
      return sendRoomError(reply, err);
    }
  });

  app.patch('/api/rooms/:id/settings', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = parseBody(RoomSettingsPatchSchema, request.body);
      const room = app.rooms.updateSettings(roomUserOf(request).id, id, body);
      return ok(reply, room);
    } catch (err) {
      return sendRoomError(reply, err);
    }
  });
};
