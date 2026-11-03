// 地图码（旧版地图编辑器 base64+zlib 格式）→ 本游戏 MapFullData。
// 移植自 mapeditor/js/mapcode.js；仅用于 PVE 房间导入，不改地图编辑器。
import type { BattlefieldTile, MapFullData } from '@dl/shared';

const TERRAIN_MAP: Record<number, number> = { 0: 5, 1: 0, 2: 1, 3: 4, 4: 3 };

interface LegacyPlayer {
  name: string;
  team: number;
  computer: number;
  seat: number;
  flag: number;
}

interface LegacyMap {
  version: number;
  title: string;
  description: string;
  author: string;
  timestamp: string;
  row: number;
  column: number;
  random_spawn: boolean;
  cylindrical_map: boolean;
  fog_mode: boolean;
  online_time_settings: { total_time: number; round_time: number; time_bonus: number };
  player_num: number;
  player_list: LegacyPlayer[];
  battlefield: BattlefieldTile[];
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(String(b64 || '').replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** zlib 解压（'deflate' = RFC1950，对应 Python zlib.compress） */
async function inflateZlib(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器不支持地图码解压');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 与 b64coder.ByteReader 一致的二进制读取器（n>4 用 BigInt） */
class ByteReader {
  pos = 0;
  constructor(private readonly data: Uint8Array) {}

  readstr(): string {
    const d = this.data;
    let length = d[this.pos];
    if (length >= 128) {
      this.pos += 1;
      if (d[this.pos] === 2) length = 256;
    }
    const bytes = d.subarray(this.pos + 1, this.pos + 1 + length);
    this.pos += length + 1;
    return new TextDecoder('utf-8').decode(bytes);
  }

  readint(n: number): number | bigint {
    if (n <= 4) {
      let v = 0;
      for (let i = 0; i < n; i++) v |= this.data[this.pos + i] << (8 * i);
      this.pos += n;
      return v >>> 0;
    }
    let v = 0n;
    for (let i = 0; i < n; i++) v |= BigInt(this.data[this.pos + i]) << BigInt(8 * i);
    this.pos += n;
    return v;
  }

  skip(n: number): void {
    this.pos += n;
  }
}

function num(v: number | bigint): number {
  return typeof v === 'bigint' ? Number(v) : v;
}

/** 时间戳（自公元 1-01-01 起的小秒数）→ "YYYY-MM-DD HH:mm:ss.ffffffX" */
function timestickToDate(input: number | bigint): string {
  const ts = BigInt(input);
  const us = ts / 10n;
  const tick = ts % 10n;
  const wholeSec = us / 1000000n;
  const micro = us % 1000000n;
  const d = new Date(-62135596800000 + Number(wholeSec * 1000n));
  const pad = (n: number, l = 2): string => String(n).padStart(l, '0');
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(Number(micro), 6)}${tick}`;
}

/** 解压后的二进制 → 旧版 Map 对象 */
function parseLegacy(bytes: Uint8Array): LegacyMap {
  if (bytes.length < 32) throw new Error('地图码数据过短');
  const r = new ByteReader(bytes);
  const version = num(r.readint(4));
  const title = r.readstr();
  const description = r.readstr();
  const author = r.readstr();
  const timestamp = timestickToDate(r.readint(8));
  const player_num = num(r.readint(4));
  const column = num(r.readint(4));
  const row = num(r.readint(4));
  if (player_num > 127 || row > 1000 || column > 1000) throw new Error('地图码数据损坏：规模参数异常');
  r.skip(4);
  const cylindrical_map = r.readint(1) === 1;
  const random_spawn = r.readint(1) === 1;
  r.skip(1);
  r.readint(1); // star_3
  r.readint(1); // star_2
  r.readint(1); // star
  r.skip(4);
  const area = num(r.readint(4));
  if (area > 1_000_000 || r.pos + area * 4 > bytes.length) throw new Error('地图码数据损坏：地块数量异常');
  const battlefield: BattlefieldTile[] = [];
  for (let i = 0; i < area; i++) {
    battlefield.push([num(r.readint(1)), num(r.readint(1)), num(r.readint(1))]);
    r.skip(1);
  }
  r.skip(24);
  const fog_mode = r.readint(1) === 1;
  const round_time = num(r.readint(4));
  const total_time = num(r.readint(4));
  r.skip(4);
  const player_list: LegacyPlayer[] = [];
  for (let j = 0; j < player_num; j++) {
    const seat = num(r.readint(1));
    const teamBits = num(r.readint(4));
    const team = Math.max(1, 32 - Math.clz32(teamBits));
    const name = r.readstr();
    const computer = num(r.readint(4));
    const flag = num(r.readint(4));
    player_list.push({ name, team, computer, seat, flag });
  }
  return {
    version,
    title,
    description,
    author,
    timestamp,
    row,
    column,
    random_spawn,
    cylindrical_map,
    fog_mode,
    online_time_settings: { total_time, round_time, time_bonus: 0 },
    player_num,
    player_list,
    battlefield,
  };
}

/** 旧版 Map → 本游戏 JSON 地图（删 star、加空 tags、地形映射、flag 按座次从 1 重编号） */
function adaptLegacy(legacy: LegacyMap): MapFullData {
  const bySeat = legacy.player_list.slice().sort((a, b) => a.seat - b.seat);
  const flagBySeat = new Map(bySeat.map((p, i) => [p.seat, i + 1]));
  return {
    id: '',
    version: 1,
    title: legacy.title,
    description: legacy.description,
    author: legacy.author,
    timestamp: legacy.timestamp,
    row: legacy.row,
    column: legacy.column,
    random_spawn: legacy.random_spawn,
    cylindrical_map: legacy.cylindrical_map,
    fog_mode: legacy.fog_mode,
    online_time_settings: legacy.online_time_settings,
    tags: [],
    player_num: legacy.player_num,
    player_list: legacy.player_list.map((p) => ({
      name: p.name,
      team: p.team,
      computer: p.computer,
      seat: p.seat,
      flag: flagBySeat.get(p.seat) ?? p.flag,
    })),
    battlefield: legacy.battlefield.map(([t, o, s]) => [TERRAIN_MAP[t] ?? t, o, s]),
  };
}

export type MapCodeResult = { ok: true; map: MapFullData } | { ok: false; error: string };

/** 地图码（base64 字符串）→ 本游戏 JSON 地图 */
export async function decodeMapCode(b64: string): Promise<MapCodeResult> {
  if (!b64 || typeof b64 !== 'string') return { ok: false, error: '地图码不能为空' };
  let legacy: LegacyMap;
  try {
    legacy = parseLegacy(await inflateZlib(b64ToBytes(b64)));
  } catch (err) {
    return { ok: false, error: `地图码解析失败：${err instanceof Error ? err.message : String(err)}` };
  }
  const map = adaptLegacy(legacy);
  if (map.battlefield.length !== map.row * map.column) {
    return { ok: false, error: '地图码数据损坏：地块数量与行列不符' };
  }
  if (map.player_num !== map.player_list.length) {
    return { ok: false, error: '地图码数据损坏：玩家数量不符' };
  }
  return { ok: true, map };
}
