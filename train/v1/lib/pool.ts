// pool.ts — 训练/验收图池（设计方案 §7：轮转取图，每个拟合批次内 100 张各出现一次）
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { MapFullData } from '@dl/shared';

export class MapPool {
  private readonly maps: MapFullData[];

  constructor(dir: string) {
    if (!existsSync(dir)) throw new Error(`图池目录不存在: ${dir}`);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    if (files.length === 0) throw new Error(`图池目录为空: ${dir}`);
    this.maps = files.map((f) => {
      const map = JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as MapFullData;
      // id 由文件名派生（与 backend 地图加载语义一致）
      map.id = path.basename(f, '.json');
      return map;
    });
  }

  get size(): number {
    return this.maps.length;
  }

  /** 轮转取图：第 i 局用 maps[i % size]（保证每 100 局批次内各出现一次） */
  rotate(gameIndex: number): MapFullData {
    return this.maps[gameIndex % this.maps.length];
  }

  all(): MapFullData[] {
    return [...this.maps];
  }
}

/** 验收图池：train/eval-maps/（用户放置；空则返回 null） */
export function loadEvalMaps(dir: string): MapPool | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return null;
  return new MapPool(dir);
}
