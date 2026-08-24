import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { openDb } from './db/client.js';
import { TicketService } from './auth/ticket.js';
import { MapCatalog } from './maps/catalog.js';
import { config } from './config.js';
import { RoomManager } from './room/manager.js';
import { GameManager } from './game/manager.js';
import { WsGateway } from './ws/gateway.js';
import { authRoutes } from './api/auth.js';
import { roomRoutes } from './api/rooms.js';
import { mapRoutes } from './api/maps.js';
import { gameRoutes } from './api/game.js';
import { userRoutes } from './api/users.js';
import { leaderboardRoutes } from './api/leaderboard.js';
import { ok } from './utils/respond.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface BuildAppOptions {
  dbPath?: string;
  logger?: boolean;
  ticketTtlMs?: number;
  staticRoot?: string;
  authRate?: { registerPerMin?: number; loginPerMin?: number };
  roomOpts?: { idleMs?: number; sweepIntervalMs?: number; gameHardCapMs?: number; gameOverRetainMs?: number };
  mapsReloadMs?: number;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });
  const { db, sqlite } = openDb(opts.dbPath);
  const tickets = new TicketService(opts.ticketTtlMs);
  const maps = new MapCatalog();
  const games = new GameManager(undefined, db);
  // 房间状态事件 → WS 网关广播（网关在下方创建后开始生效）
  let gatewayRef: WsGateway | null = null;
  const rooms = new RoomManager({
    ...opts.roomOpts,
    onEvent: (event) => gatewayRef?.publish(event),
  });
  app.decorate('db', db);
  app.decorate('tickets', tickets);
  app.decorate('rooms', rooms);
  app.decorate('maps', maps);
  app.decorate('games', games);

  await app.register(cors, { origin: true });

  const staticRoot = opts.staticRoot ?? path.join(__dirname, '../static');
  app.decorate('mapsUncensoredDir', path.join(staticRoot, 'maps-uncensored'));
  if (existsSync(staticRoot)) {
    await app.register(fastifyStatic, { root: staticRoot, prefix: '/static/' });
    maps.loadFromDir(path.join(staticRoot, 'maps'));
    maps.startAutoReload(opts.mapsReloadMs ?? config.mapsReloadMs);
  }

  // 独立地图编辑器（repo 根目录 mapeditor/）：作为主程序子页面托管，
  // 使编辑器与主程序同源（同端口），可从大厅直接进入。
  // 二次注册需 decorateReply:false，避免 sendFile 装饰器重复声明。
  const mapeditorRoot = path.join(__dirname, '../../mapeditor');
  if (existsSync(mapeditorRoot)) {
    await app.register(fastifyStatic, { root: mapeditorRoot, prefix: '/mapeditor/', decorateReply: false });
  }

  app.get('/api/health', async (_request, reply) => ok(reply, { status: 'ok' }));

  await app.register(authRoutes, {
    registerPerMin: opts.authRate?.registerPerMin,
    loginPerMin: opts.authRate?.loginPerMin,
  });
  await app.register(roomRoutes);
  await app.register(mapRoutes);
  await app.register(gameRoutes);
  await app.register(userRoutes);
  await app.register(leaderboardRoutes);

  gatewayRef = new WsGateway(app, rooms, games, tickets, app.log);

  app.addHook('onClose', async () => {
    gatewayRef?.close();
    tickets.dispose();
    rooms.dispose();
    games.dispose();
    maps.dispose();
    sqlite.close();
  });

  return app;
}
