// pool.test.ts — 对手池管理：抽取 / 接受 / 裁剪
import { describe, expect, it } from 'vitest';
import { POOL_MAX, acceptVersion, drawOpponents, type PoolState } from '../lib/pool.js';

describe('对手池', () => {
  it('抽取：独立随机、允许相同（自对弈可打自己）', () => {
    const state: PoolState = { pool: ['v1', 'v2', 'v3'], current: 'v3' };
    const rng = () => 0;
    expect(drawOpponents(state, rng)).toEqual(['v1', 'v1']);
    const rng2 = () => 0.99;
    expect(drawOpponents(state, rng2)).toEqual(['v3', 'v3']);
  });

  it('接受：新版本加入池尾并成为 current', () => {
    const state: PoolState = { pool: ['v0'], current: 'v0' };
    acceptVersion(state, 'v1');
    expect(state.pool).toEqual(['v0', 'v1']);
    expect(state.current).toBe('v1');
    // 重复接受不产生重复项
    acceptVersion(state, 'v1');
    expect(state.pool).toEqual(['v0', 'v1']);
  });

  it('裁剪：超过 POOL_MAX 保留最近版本', () => {
    const state: PoolState = { pool: [], current: 'v0' };
    for (let i = 0; i < POOL_MAX + 5; i++) acceptVersion(state, `v${i}`);
    expect(state.pool.length).toBe(POOL_MAX);
    expect(state.pool[state.pool.length - 1]).toBe(`v${POOL_MAX + 4}`);
    expect(state.current).toBe(`v${POOL_MAX + 4}`);
  });

  it('空池兜底 v0', () => {
    expect(drawOpponents({ pool: [], current: '' }, () => 0)).toEqual(['v0', 'v0']);
  });
});
