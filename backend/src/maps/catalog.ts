import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { stripJsonComments, validateMapData } from '@dl/shared';
import type { MapFullData, MapMeta } from '@dl/shared';

export { validateMapData } from '@dl/shared';

interface CachedFile {
  mtimeMs: number;
  size: number;
  /** null = 文件存在但结构非法/解析失败（缓存以免每次刷新重复解析） */
  meta: MapMeta | null;
}

export interface MapCatalogOptions {
  /** 静默逐文件告警，改为刷新结束时输出一条汇总（PVE 上千张图时使用） */
  quiet?: boolean;
}

/**
 * 地图目录：只缓存元数据（小字段），完整地图数据按需从磁盘读取。
 * 支持 3000 张量级：内存占用可忽略；目录变更通过定时 refresh 反映，无需重启。
 * id 由文件名派生。
 *
 * refresh 带 mtime+size 缓存：首次解析全部文件，之后只 stat，未变化的文件直接复用元数据；
 * 新增/修改/删除文件仍能反映。PVE 目录可懒加载（ensureLoaded），避免启动/测试解析上千张图。
 */
export class MapCatalog {
  private dir = '';
  private meta = new Map<string, MapMeta>();
  private cache = new Map<string, CachedFile>();
  private loaded = false;
  private lastSkipped = -1;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: MapCatalogOptions = {}) {}

  /** 设置目录（目录变化时清空缓存，等待下次加载） */
  setDir(dir: string): void {
    if (this.dir === dir) return;
    this.dir = dir;
    this.meta.clear();
    this.cache.clear();
    this.loaded = false;
  }

  /** 主动加载（常规 maps 目录在启动时使用） */
  loadFromDir(dir: string): number {
    this.setDir(dir);
    this.loaded = true;
    return this.refresh();
  }

  /** 懒加载：首次访问时扫描；可选启动自动重扫（PVE 目录使用） */
  ensureLoaded(reloadMs?: number): number {
    if (!this.loaded) {
      this.loaded = true;
      this.refresh();
    }
    if (reloadMs !== undefined && this.timer === null) this.startAutoReload(reloadMs);
    return this.meta.size;
  }

  /** 重扫目录重建元数据缓存（整体替换，删除的文件也会从缓存消失）。 */
  refresh(): number {
    const next = new Map<string, MapMeta>();
    const nextCache = new Map<string, CachedFile>();
    let files: string[] = [];
    try {
      files = readdirSync(this.dir).filter((f) => f.endsWith('.json')).sort();
    } catch {
      this.meta.clear();
      this.cache.clear();
      return 0;
    }
    let skipped = 0;
    for (const file of files) {
      const full = path.join(this.dir, file);
      let stat: ReturnType<typeof statSync>;
      try {
        stat = statSync(full);
      } catch {
        skipped += 1;
        continue;
      }
      const cached = this.cache.get(file);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        if (cached.meta) next.set(path.basename(file, '.json'), cached.meta);
        else skipped += 1;
        nextCache.set(file, cached);
        continue;
      }
      try {
        const raw: unknown = JSON.parse(stripJsonComments(readFileSync(full, 'utf8')));
        if (!validateMapData(raw)) {
          skipped += 1;
          if (!this.opts.quiet) console.warn(`[maps] ${file} 结构非法，已跳过`);
          nextCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, meta: null });
          continue;
        }
        const m = raw as MapFullData;
        const id = path.basename(file, '.json');
        const meta: MapMeta = {
          id,
          title: m.title,
          author: m.author,
          description: m.description,
          playerNum: m.player_num,
          row: m.row,
          column: m.column,
          tags: m.tags,
        };
        next.set(id, meta);
        nextCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
      } catch (err) {
        skipped += 1;
        if (!this.opts.quiet) console.warn(`[maps] ${file} 解析失败:`, err);
        nextCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, meta: null });
      }
    }
    this.meta = next;
    this.cache = nextCache;
    if (this.opts.quiet && skipped > 0 && skipped !== this.lastSkipped) {
      console.warn(`[maps] ${this.dir}: ${next.size} 张有效，${skipped} 张跳过`);
    }
    this.lastSkipped = skipped;
    return this.meta.size;
  }

  list(search?: string): MapMeta[] {
    const all = [...this.meta.values()];
    if (!search) return all;
    const q = search.toLowerCase();
    return all.filter((m) =>
      [m.title, m.author, m.description, ...(m.tags ?? [])].some((t) => t.toLowerCase().includes(q)),
    );
  }

  /** 完整地图按需从磁盘读取，不缓存；缺失/损坏返回 null。id 白名单防路径穿越。 */
  get(id: string): MapFullData | null {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
    try {
      const raw: unknown = JSON.parse(stripJsonComments(readFileSync(path.join(this.dir, `${id}.json`), 'utf8')));
      if (!validateMapData(raw)) return null;
      const map = raw as MapFullData;
      map.id = id;
      return map;
    } catch {
      return null;
    }
  }

  /** 周期重扫目录，使新增/删除的地图无需重启即可反映（防重入）。 */
  startAutoReload(intervalMs: number): void {
    this.stopAutoReload();
    this.timer = setInterval(() => {
      try {
        this.refresh();
      } catch (err) {
        console.warn('[maps] 自动重载失败:', err);
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  stopAutoReload(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.stopAutoReload();
    this.meta.clear();
    this.cache.clear();
  }
}
