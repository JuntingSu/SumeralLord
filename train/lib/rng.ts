// 种子化 PRNG（训练管线专用；与 shared 确定性哲学一致：零 Math.random，同 seed 同序列）
import { fnv1a } from '@dl/shared';

/** xorshift32：初值 = FNV-1a(seed)，非零兜底（与 shared ai.ts createRng 同思路） */
export function createRng(seed: string): () => number {
  let x = parseInt(fnv1a(seed), 16) >>> 0;
  if (x === 0) x = 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
}

/** [0, n) 均匀整数（n 为正） */
export function randInt(rng: () => number, n: number): number {
  return rng() % n;
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[randInt(rng, arr.length)];
}

export function shuffle<T>(rng: () => number, arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
