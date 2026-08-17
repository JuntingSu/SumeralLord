import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './db/schema.js';
import type { TicketService } from './auth/ticket.js';
import type { RoomManager } from './room/manager.js';
import type { MapCatalog } from './maps/catalog.js';
import type { AuthTokenPayload } from './auth/jwt.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: BetterSQLite3Database<typeof schema>;
    tickets: TicketService;
    rooms: RoomManager;
    maps: MapCatalog;
  }

  interface FastifyRequest {
    user?: AuthTokenPayload;
  }
}

export {};
