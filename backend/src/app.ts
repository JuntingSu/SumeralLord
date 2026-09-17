import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { openDb } from './db/client.js';
import { TicketService } from './auth/ticket.js';
import { BotSessionService } from './ws/botSession.js';
import { AiBotManager } from './ai-bot/manager.js';
import { MapCatalog } from './maps/catalog.js';
import { config } from './config.js';
import { RoomManager } from './room/manager.js';
import { GameManager } from './game/manager.js';
import { WsGateway } from './ws/gateway.js';
import { users } from './db/schema.js';
import { eq } from 'drizzle-orm';
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
  /** AI 子进程管理配置（测试可注入 enabled:false / bootDir / onOutput） */
  aiBotOpts?: import('./ai-bot/manager.js').AiBotManagerOptions;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });
  const { db, sqlite } = openDb(opts.dbPath);
  const tickets = new TicketService(opts.ticketTtlMs);
  const botSessions = new BotSessionService();
  const maps = new MapCatalog();
  const games = new GameManager(undefined, db);
  const aiBots = new AiBotManager(botSessions, opts.aiBotOpts);
  // 房间状态事件 → WS 网关广播（网关在下方创建后开始生效）
  let gatewayRef: WsGateway | null = null;
  const rooms = new RoomManager({
    ...opts.roomOpts,
    onEvent: (event) => gatewayRef?.publish(event),
    // 房间玩家列表战绩（积分/胜场/对局数）：序列化时实时读库，保证对局结算后即时刷新
    statsOf: (userId) => {
      const row = db.select().from(users).where(eq(users.id, userId)).get();
      return row ? { score: row.score, wins: row.wins, matches: row.matches } : { score: 0, wins: 0, matches: 0 };
    },
  });
  app.decorate('db', db);
  app.decorate('tickets', tickets);
  app.decorate('botSessions', botSessions);
  app.decorate('aiBots', aiBots);
  app.decorate('rooms', rooms);
  app.decorate('maps', maps);
  app.decorate('games', games);

  await app.register(cors, { origin: true });

  const staticRoot = opts.staticRoot ?? path.join(__dirname, '../static');
  app.decorate('mapsDir', path.join(staticRoot, 'maps'));
  app.decorate('mapsUncensoredDir', path.join(staticRoot, 'maps-uncensored'));
  app.decorate('skinDir', path.join(staticRoot, 'skin'));
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

  gatewayRef = new WsGateway(app, rooms, games, tickets, botSessions, aiBots, app.log);

  app.addHook('onClose', async () => {
    gatewayRef?.close();
    aiBots.dispose();
    botSessions.dispose();
    tickets.dispose();
    rooms.dispose();
    games.dispose();
    maps.dispose();
    sqlite.close();
  });

  return app;
}
