import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from './db/schema.js';
import type { TicketService } from './auth/ticket.js';
import type { BotSessionService } from './ws/botSession.js';
import type { AiBotManager } from './ai-bot/manager.js';
import type { RoomManager } from './room/manager.js';
import type { MapCatalog } from './maps/catalog.js';
import type { GameManager } from './game/manager.js';
import type { AuthTokenPayload } from './auth/jwt.js';
import type { UserMapStore } from './maps/userMaps.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: BetterSQLite3Database<typeof schema>;
    tickets: TicketService;
    botSessions: BotSessionService;
    aiBots: AiBotManager;
    rooms: RoomManager;
    maps: MapCatalog;
    /** PVE 地图目录（懒加载；backend/static/pve_maps） */
    pveMaps: MapCatalog;
    games: GameManager;
    /** 正式地图目录（maps，条件达标的玩家保存直入，无需审查） */
    mapsDir: string;
    /** 地图编辑器保存目录（maps-uncensored 审查队列，审查后移入 maps） */
    mapsUncensoredDir: string;
    /** PVE 地图目录路径 */
    pveMapsDir: string;
    /** 演示回放目录（static/demo） */
    demoDir: string;
    /** PVE 普通 AI 权重文件路径 */
    pveWeightsPath: string;
    /** PVE 存档单账号大小上限（字节） */
    pveSaveMaxBytes: number;
    /** PVE 地图目录自动重扫间隔（毫秒） */
    pveMapsReloadMs: number;
    /** 个人皮肤目录（static/skin；usr_{id}.png） */
    skinDir: string;
    /** 个人作品地图目录（static/user-maps） */
    userMapsDir: string;
    /** 个人作品/社区地图索引与文件存储 */
    userMaps: UserMapStore;
  }

  interface FastifyRequest {
    user?: AuthTokenPayload;
  }
}

export {};
