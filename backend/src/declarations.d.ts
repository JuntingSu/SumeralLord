import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './db/schema.js';
import type { TicketService } from './auth/ticket.js';
import type { RoomManager } from './room/manager.js';
import type { MapCatalog } from './maps/catalog.js';
import type { GameManager } from './game/manager.js';
import type { AuthTokenPayload } from './auth/jwt.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: BetterSQLite3Database<typeof schema>;
    tickets: TicketService;
    rooms: RoomManager;
    maps: MapCatalog;
    games: GameManager;
    /** 地图编辑器保存目录（maps-uncensored 审查队列，审查后移入 maps） */
    mapsUncensoredDir: string;
  }

  interface FastifyRequest {
    user?: AuthTokenPayload;
  }
}

export {};
