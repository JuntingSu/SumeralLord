// rng.ts — 局面哈希种子的确定性 PRNG（同局面同随机；保证 MCTS 树内候选一致）
/** mulberry32：种子化 PRNG（返回 [0,1)） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
