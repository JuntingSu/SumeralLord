// 个人作品/社区地图存储：文件在 static/user-maps/<id>.json，元数据与发布/点赞索引在 SQLite。
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq, like, or, sql, type SQL } from 'drizzle-orm';
import { stripJsonComments, validateMapData } from '@dl/shared';
import type { ErrorCode, MapFullData, MapPreview, UserMapListResult, UserMapMeta, UserMapSort } from '@dl/shared';
import type { Db } from '../db/client.js';
import { userMapLikes, userMaps } from '../db/schema.js';
import type { UserMapRow } from '../db/schema.js';

export const USER_MAP_MAX = 200;
const MAX_MAP_BYTES = 16 * 1024 * 1024;
const MAX_TAGS = 20;
const MAX_TAG_LEN = 32;

export class UserMapError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UserMapError';
  }
}

export interface UserMapStoreOptions {
  db: Db;
  dir: string;
  maxPerUser?: number;
}

export interface ListOptions {
  search?: string;
  sort?: UserMapSort;
  page?: number;
  pageSize?: number;
}

export interface LikeResult {
  likes: number;
  liked: boolean;
}

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const v = t.trim();
    if (!v || v.length > MAX_TAG_LEN || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function metaOf(row: UserMapRow): UserMapMeta {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    description: row.description,
    playerNum: row.playerNum,
    row: row.row,
    column: row.column,
    tags: normalizeTags(JSON.parse(row.tags || '[]') as unknown),
    hasTriggers: !!row.hasTriggers,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
    published: !!row.published,
    likes: row.likes,
    publishedAt: row.publishedAt ?? null,
  };
}

function clampPageOptions(opts: ListOptions): { page: number; pageSize: number } {
  const page = Number.isFinite(opts.page) ? Math.max(1, Math.floor(opts.page!)) : 1;
  const pageSize = Number.isFinite(opts.pageSize)
    ? Math.min(60, Math.max(1, Math.floor(opts.pageSize!)))
    : 12;
  return { page, pageSize };
}

function orderFor(sort: UserMapSort | undefined): SQL {
  switch (sort) {
    case 'oldest':
      return sql`updated_at ASC, id ASC`;
    case 'title_asc':
      return sql`title COLLATE NOCASE ASC, id ASC`;
    case 'title_desc':
      return sql`title COLLATE NOCASE DESC, id ASC`;
    case 'author_asc':
      return sql`author COLLATE NOCASE ASC, title COLLATE NOCASE ASC`;
    case 'author_desc':
      return sql`author COLLATE NOCASE DESC, title COLLATE NOCASE ASC`;
    case 'popular':
      return sql`likes DESC, updated_at DESC, id ASC`;
    case 'recent':
    default:
      return sql`updated_at DESC, id ASC`;
  }
}

export class UserMapStore {
  readonly dir: string;
  private readonly db: Db;
  private readonly maxPerUser: number;

  constructor(opts: UserMapStoreOptions) {
    this.db = opts.db;
    this.dir = opts.dir;
    this.maxPerUser = opts.maxPerUser ?? USER_MAP_MAX;
    mkdirSync(this.dir, { recursive: true });
  }

  private fileOf(id: string): string {
    if (!/^um_[a-zA-Z0-9]+$/.test(id)) {
      throw new UserMapError(400, 'INVALID_PARAMS', '作品 id 非法');
    }
    return path.join(this.dir, `${id}.json`);
  }

  private countOf(userId: number): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(userMaps)
      .where(eq(userMaps.userId, userId))
      .get();
    return row?.n ?? 0;
  }

  private rowOf(id: string): UserMapRow | undefined {
    return this.db.select().from(userMaps).where(eq(userMaps.id, id)).get();
  }

  private updateFromMap(
    row: UserMapRow,
    map: MapFullData,
    author: string,
    now: number,
  ): void {
    const tags = normalizeTags(map.tags);
    this.db
      .update(userMaps)
      .set({
        title: String(map.title ?? '').slice(0, 200) || '未命名地图',
        author,
        description: String(map.description ?? '').slice(0, 2000),
        tags: JSON.stringify(tags),
        playerNum: map.player_num,
        row: map.row,
        column: map.column,
        hasTriggers: Array.isArray(map.triggers) && map.triggers.length > 0 ? 1 : 0,
        updatedAt: now,
      })
      .where(eq(userMaps.id, row.id))
      .run();
  }

  private writeMap(row: UserMapRow, map: MapFullData, author: string, now: number): void {
    const body: MapFullData = { ...map, author };
    const json = JSON.stringify(body, null, 2);
    if (Buffer.byteLength(json, 'utf8') > MAX_MAP_BYTES) {
      throw new UserMapError(413, 'MAP_TOO_LARGE', '地图文件过大');
    }
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.fileOf(row.id), json, 'utf8');
    this.updateFromMap(row, body, author, now);
  }

  create(userId: number, username: string, map: unknown): UserMapMeta {
    if (!validateMapData(map)) {
      throw new UserMapError(400, 'INVALID_PARAMS', '地图数据结构非法');
    }
    if (this.countOf(userId) >= this.maxPerUser) {
      throw new UserMapError(409, 'USER_MAP_LIMIT', `个人作品上限为 ${this.maxPerUser} 张`);
    }
    const full = map as MapFullData;
    let id = '';
    do {
      id = `um_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    } while (this.rowOf(id));
    const now = Date.now();
    const tags = normalizeTags(full.tags);
    const row: UserMapRow = {
      id,
      userId,
      fileName: `${id}.json`,
      title: String(full.title ?? '').slice(0, 200) || '未命名地图',
      author: username,
      description: String(full.description ?? '').slice(0, 2000),
      tags: JSON.stringify(tags),
      playerNum: full.player_num,
      row: full.row,
      column: full.column,
      hasTriggers: Array.isArray(full.triggers) && full.triggers.length > 0 ? 1 : 0,
      published: 0,
      publishedAt: null,
      likes: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(userMaps).values(row).run();
    try {
      this.writeMap(row, full, username, now);
    } catch (err) {
      this.db.delete(userMaps).where(eq(userMaps.id, id)).run();
      throw err;
    }
    return metaOf(this.rowOf(id)!);
  }

  update(userId: number, id: string, username: string, map: unknown): UserMapMeta {
    const row = this.rowOf(id);
    if (!row) throw new UserMapError(404, 'MAP_NOT_FOUND', '作品不存在');
    if (row.userId !== userId) throw new UserMapError(403, 'FORBIDDEN', '无权修改该作品');
    if (!validateMapData(map)) {
      throw new UserMapError(400, 'INVALID_PARAMS', '地图数据结构非法');
    }
    this.writeMap(row, map as MapFullData, username, Date.now());
    return metaOf(this.rowOf(id)!);
  }

  publish(userId: number, id: string): UserMapMeta {
    const row = this.rowOf(id);
    if (!row) throw new UserMapError(404, 'MAP_NOT_FOUND', '作品不存在');
    if (row.userId !== userId) throw new UserMapError(403, 'FORBIDDEN', '无权发布该作品');
    const now = Date.now();
    this.db
      .update(userMaps)
      .set({ published: 1, publishedAt: row.publishedAt ?? now })
      .where(eq(userMaps.id, id))
      .run();
    return metaOf(this.rowOf(id)!);
  }

  /** 读取完整地图；ownerId 提供时校验所有权，publishedOnly 用于社区读取 */
  get(
    id: string,
    opts: { ownerId?: number; publishedOnly?: boolean } = {},
  ): MapFullData | null {
    const row = this.rowOf(id);
    if (!row) return null;
    if (opts.ownerId !== undefined && row.userId !== opts.ownerId) return null;
    if (opts.publishedOnly && !row.published) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(stripJsonComments(readFileSync(this.fileOf(id), 'utf8')));
    } catch {
      return null;
    }
    if (!validateMapData(raw)) return null;
    return { ...(raw as MapFullData), id };
  }

  preview(
    id: string,
    opts: { ownerId?: number; publishedOnly?: boolean } = {},
  ): MapPreview | null {
    const map = this.get(id, opts);
    if (!map) return null;
    return { row: map.row, column: map.column, battlefield: map.battlefield };
  }

  meta(id: string, opts: { ownerId?: number } = {}): UserMapMeta | null {
    const row = this.rowOf(id);
    if (!row) return null;
    if (opts.ownerId !== undefined && row.userId !== opts.ownerId) return null;
    return metaOf(row);
  }

  listMine(userId: number, opts: ListOptions = {}): UserMapListResult {
    return this.list({ ...opts, ownerId: userId });
  }

  listCommunity(opts: ListOptions = {}): UserMapListResult {
    return this.list({ ...opts, publishedOnly: true });
  }

  private list(
    opts: ListOptions & { ownerId?: number; publishedOnly?: boolean },
  ): UserMapListResult {
    const { page, pageSize } = clampPageOptions(opts);
    const search = (opts.search ?? '').trim();
    const clauses = [];
    if (opts.ownerId !== undefined) clauses.push(eq(userMaps.userId, opts.ownerId));
    if (opts.publishedOnly) clauses.push(eq(userMaps.published, 1));
    if (search) {
      const pattern = `%${search}%`;
      clauses.push(
        or(
          like(userMaps.title, pattern),
          like(userMaps.tags, pattern),
          like(userMaps.author, pattern),
        )!,
      );
    }
    const where = clauses.length ? and(...clauses) : undefined;
    const totalRow = this.db
      .select({ n: sql<number>`count(*)` })
      .from(userMaps)
      .where(where)
      .get();
    const rows = this.db
      .select()
      .from(userMaps)
      .where(where)
      .orderBy(orderFor(opts.sort))
      .limit(pageSize)
      .offset((page - 1) * pageSize)
      .all();
    return { mapList: rows.map(metaOf), total: totalRow?.n ?? 0, page, pageSize };
  }

  like(userId: number, id: string): LikeResult {
    const row = this.rowOf(id);
    if (!row) throw new UserMapError(404, 'MAP_NOT_FOUND', '地图不存在');
    if (!row.published) throw new UserMapError(404, 'MAP_NOT_FOUND', '地图未发布');
    const inserted = this.db
      .insert(userMapLikes)
      .values({ mapId: id, userId, createdAt: Date.now() })
      .onConflictDoNothing()
      .run();
    if (inserted.changes > 0) {
      this.db
        .update(userMaps)
        .set({ likes: sql`${userMaps.likes} + 1` })
        .where(eq(userMaps.id, id))
        .run();
    }
    return this.likeStatus(userId, id)!;
  }

  likeStatus(userId: number | undefined, id: string): LikeResult | null {
    const row = this.rowOf(id);
    if (!row) return null;
    const liked =
      userId === undefined
        ? false
        : !!this.db
            .select({ mapId: userMapLikes.mapId })
            .from(userMapLikes)
            .where(and(eq(userMapLikes.mapId, id), eq(userMapLikes.userId, userId)))
            .get();
    return { likes: row.likes, liked };
  }
}
