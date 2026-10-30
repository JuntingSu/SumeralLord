// 地形贴图 URL 派生（backend/static/terrain）：与旗帜同规格 192×216、尖顶六边形 R=100 居中。
// 虚空（VOID）为完全透明地形，不提供贴图 —— 返回 null，渲染层直接跳过该格。
import { TERRAIN } from '@dl/shared';

const TERRAIN_TEXTURES: Record<number, string> = {
  [TERRAIN.PLAIN]: 'plain',
  [TERRAIN.CITY]: 'city',
  [TERRAIN.OCEAN]: 'ocean',
  [TERRAIN.MOUNTAIN]: 'mountain',
};

/** 需要预加载的地形码（虚空无贴图） */
export const TERRAIN_TEXTURE_KEYS: number[] = Object.keys(TERRAIN_TEXTURES).map(Number);

export function terrainImgUrl(terrain: number): string | null {
  const name = TERRAIN_TEXTURES[terrain];
  return name ? `/static/terrain/terrain_${name}.png` : null;
}
