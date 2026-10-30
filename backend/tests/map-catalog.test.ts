import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MapCatalog } from '../src/maps/catalog.js';
import { pveMapJson } from './pve-fixtures.js';

let dir: string;
let catalog: MapCatalog;

function write(name: string, map: unknown): void {
  writeFileSync(path.join(dir, name), JSON.stringify(map), 'utf8');
}

describe('MapCatalog（mtime 缓存 + 懒加载）', () => {
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dl-catalog-'));
    write('a.json', pveMapJson({ title: 'A' }));
    write('bad.json', { title: '坏图' });
    catalog = new MapCatalog({ quiet: true });
    catalog.loadFromDir(dir);
  });

  afterAll(() => {
    catalog.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('首次加载只收录合法地图', () => {
    expect(catalog.list().map((m) => m.id)).toEqual(['a']);
    expect(catalog.get('a')?.title).toBe('A');
    expect(catalog.get('../a')).toBeNull();
  });

  it('新增/修改/删除文件后 refresh 反映变化', () => {
    write('b.json', pveMapJson({ title: 'B' }));
    expect(catalog.refresh()).toBe(2);
    expect(catalog.list().map((m) => m.id).sort()).toEqual(['a', 'b']);

    write('a.json', pveMapJson({ title: 'A2' }));
    catalog.refresh();
    expect(catalog.list('A2').map((m) => m.id)).toEqual(['a']);

    unlinkSync(path.join(dir, 'b.json'));
    expect(catalog.refresh()).toBe(1);
    expect(catalog.list().map((m) => m.id)).toEqual(['a']);
  });

  it('ensureLoaded 对不存在的目录返回 0', () => {
    const empty = new MapCatalog({ quiet: true });
    empty.setDir(path.join(dir, 'missing'));
    expect(empty.ensureLoaded()).toBe(0);
    empty.dispose();
  });
});
