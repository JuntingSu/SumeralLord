import type { FastifyReply, FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import {
  ERROR_CODES,
  ChangeMapBodySchema,
  CreateRoomBodySchema,
  ForceAiBodySchema,
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
import { hasSkin } from '../skin.js';
import { RoomError, type RoomUser } from '../room/manager.js';
import { shuffleAssignments } from '../game/manager.js';
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
  FORCE_AI_LOCKED: 409,
  FORCE_OCCUPIED: 400,
  AI_TAKEOVER_OFF: 400,
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
    return {
      id: auth.userId,
      username: auth.username,
      flag: row?.defaultFlag ?? 1,
      hasSkin: hasSkin(app.skinDir, auth.userId),
    };
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

  app.post('/api/rooms/:id/force-ai', async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const body = parseBody(ForceAiBodySchema, request.body);
      const room = app.rooms.assignForceAiLevel(roomUserOf(request).id, id, body.seat, body.aiLevel);
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

      // isAI = 房主指定 AI 难度（AI 专属）或开启 AI 接管且无玩家扮演；未接管且无玩家的势力开局时由前端删兵。
      // 指定 AI 难度的势力带 computer 覆盖（缺省用地图 player_list[].computer，由 reducer initState 落地）
      let seatAssignments: SeatAssignment[] = roomData.forces.map((f) => ({
        seat: f.seat,
        playerId: f.playerId,
        isAI: f.aiLevel !== null || (roomData.aiTakeover && f.playerId === null),
        ...(f.aiLevel !== null ? { computer: f.aiLevel } : {}),
      }));
      // 随机出生：在已选势力（有玩家扮演）集合内随机重排玩家-势力分配，未选势力/AI 位不参与。
      // 重排结果为最终分配，随 GAME_START 的 seatAssignments 下发；出生点恒等、跟随势力不动。
      if (roomData.randomSpawn) {
        seatAssignments = shuffleAssignments(seatAssignments);
      }

      // 使用个人皮肤：开局把「有玩家扮演且已上传皮肤」的势力旗帜替换为该玩家的皮肤。
      // 皮肤用负数 flag 编码（-playerId → /static/skin/usr_{playerId}.png），由前端按 flag 派生 URL；
      // AI / 无玩家 / 未上传皮肤的势力保持地图原旗帜。只改副本，不动地图目录缓存。
      // 必须在 randomSpawn 重排之后执行：旗帜跟随玩家最终落到的 seat，而非房间内的原始选择。
      let gameMap = map;
      if (roomData.usePersonalSkin) {
        const skinPlayerOfSeat = new Map<number, number>();
        for (const a of seatAssignments) {
          if (a.playerId !== null && hasSkin(app.skinDir, a.playerId)) skinPlayerOfSeat.set(a.seat, a.playerId);
        }
        if (skinPlayerOfSeat.size > 0) {
          gameMap = {
            ...map,
            player_list: map.player_list.map((p) =>
              skinPlayerOfSeat.has(p.seat) ? { ...p, flag: -skinPlayerOfSeat.get(p.seat)! } : p,
            ),
          };
        }
      }

      const { game, startMsg } = app.games.create({
        roomId: id,
        map: gameMap,
        seatAssignments,
        aiTakeover: roomData.aiTakeover,
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
        map: gameMap,
        timeSettings: roomData.timeSettings,
      });
      // 对局正式启动：含 AI 席位的对局拉起 ai-bot 子进程（生命周期由 AiBotManager 维护）
      // wsUrl 必须指向实际监听端口（测试/部署可能非 config.port）
      const addr = app.server.address();
      const wsPort = typeof addr === 'object' && addr ? addr.port : config.port;
      app.aiBots.spawn(game, wsPort);
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
