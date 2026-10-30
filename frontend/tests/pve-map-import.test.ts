import { describe, expect, it } from 'vitest';
import { decodeMapCode } from '../src/lib/mapcode';
import { normalizeImportedMap, parseMapJsonText } from '../src/lib/mapJson';

// mapeditor/scripts/selftest.mjs 的真实示例码（双子 9×9，3 势力）
const SAMPLE =
  'eNp1kTsKwkAQhndmQtTKMwheQGuPoIWVgpdRsFGMD7SzsRBEwVIIIngLSys3vgqPoDO7ia/owpfJPzsvdkAp5epeRy/7mdumEQy9oDvTLe/gTw/+Qre3uj0OfP/YnfMtVUplrG13xfU+SZyYCnkdZMoM1V8gAxFExhfZf+CXfuYDMWgt4mcMuOwjG4fAOh2ra/MdBSpp4bhYDKbCuITpZed1vuqg7YViXeX8mPkfQLYmcm+UWeSfIPZe72eyzBor61IFpsovLSsA8UDuzt8zazQyL/LCkmQf7nG0OjUHcnNl3wPX5Ehr';

describe('地图码导入', () => {
  it('示例码可解码并适配为本游戏地图', async () => {
    const res = await decodeMapCode(SAMPLE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.map.title).toBe('双子');
    expect(res.map.row).toBe(9);
    expect(res.map.column).toBe(9);
    expect(res.map.player_num).toBe(3);
    expect(res.map.player_list.map((p) => p.flag)).toEqual([1, 2, 3]);
    expect(res.map.tags).toEqual([]);
  });

  it('非法地图码返回错误', async () => {
    const res = await decodeMapCode('not-a-map-code');
    expect(res.ok).toBe(false);
  });
});

describe('本地地图导入校验', () => {
  it('接受合法地图并分配本地 id', async () => {
    const decoded = await decodeMapCode(SAMPLE);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const res = normalizeImportedMap(decoded.map, 'code');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.map.id.length).toBeGreaterThan(0);
  });

  it('拒绝 1 势力与超过 255×255 的地图', async () => {
    const decoded = await decodeMapCode(SAMPLE);
    if (!decoded.ok) return;
    const solo = {
      ...decoded.map,
      player_num: 1,
      player_list: decoded.map.player_list.slice(0, 1),
    };
    expect(normalizeImportedMap(solo).ok).toBe(false);

    const wide = {
      ...decoded.map,
      row: 256,
      column: 1,
      battlefield: Array.from({ length: 256 }, () => [0, 128, 0] as [number, number, number]),
      player_num: 2,
      player_list: decoded.map.player_list.slice(0, 2),
    };
    expect(normalizeImportedMap(wide).ok).toBe(false);
  });

  it('JSON 文本允许 // 注释', async () => {
    const decoded = await decodeMapCode(SAMPLE);
    if (!decoded.ok) return;
    const text = `// 注释\n${JSON.stringify(decoded.map)}`;
    const res = parseMapJsonText(text, 'json');
    expect(res.ok).toBe(true);
  });
});
