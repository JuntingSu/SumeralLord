// 战役触发器：战争迷雾覆盖（revealed / hidden / enabled）。
import { describe, expect, it } from 'vitest';
import { computeFog } from '../src/game/fog';

describe('computeFog overrides', () => {
  it('applies reveal and hide when fog is on', () => {
    const { levels } = computeFog(3, 3, false, [], true, new Set(), { revealed: [4], hidden: [0] });
    expect(levels[4]).toBe('visible');
    expect(levels[0]).toBe('hidden');
  });

  it('enabled=false forces all visible', () => {
    const { levels } = computeFog(2, 2, false, [], true, new Set(), {
      enabled: false,
      revealed: [],
      hidden: [0],
    });
    expect(levels.every((l) => l === 'visible')).toBe(true);
  });

  it('enabled=true forces fog on even when the config is off', () => {
    const { levels } = computeFog(2, 2, false, [], false, new Set(), {
      enabled: true,
      revealed: [1],
      hidden: [],
    });
    expect(levels[1]).toBe('visible');
    expect(levels[0]).toBe('hidden');
  });

  it('revealed wins over hidden on the same tile', () => {
    const { levels } = computeFog(2, 2, false, [], true, new Set(), {
      revealed: [0],
      hidden: [0],
    });
    expect(levels[0]).toBe('visible');
  });
});
