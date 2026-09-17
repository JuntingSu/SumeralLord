import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './db/schema.js';
import type { TicketService } from './auth/ticket.js';
import type { BotSessionService } from './ws/botSession.js';
import type { AiBotManager } from './ai-bot/manager.js';
import type { RoomManager } from './room/manager.js';
import type { MapCatalog } from './maps/catalog.js';
import type { GameManager } from './game/manager.js';
import type { AuthTokenPayload } from './auth/jwt.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: BetterSQLite3Database<typeof schema>;
    tickets: TicketService;
    botSessions: BotSessionService;
    aiBots: AiBotManager;
    rooms: RoomManager;
    maps: MapCatalog;
    games: GameManager;
    /** 正式地图目录（maps，条件达标的玩家保存直入，无需审查） */
    mapsDir: string;
    /** 地图编辑器保存目录（maps-uncensored 审查队列，审查后移入 maps） */
    mapsUncensoredDir: string;
    /** 个人皮肤目录（static/skin；usr_{id}.png / usr_{id}_hollow.png） */
    skinDir: string;
  }

  interface FastifyRequest {
    user?: AuthTokenPayload;
  }
}

export {};
