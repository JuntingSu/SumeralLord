/**
 * mapcode.js — 从地图码（旧版地图编辑器 base64 格式）导入地图
 *
 * 地图码 = base64(zlib(二进制))，二进制结构与 mapeditor-release/mapeditor/b64coder.py 一致：
 *   version(4) title(串) desc(串) author(串) timestamp(8) player_num(4) row(4) column(4)
 *   skip(4) cylindrical(1) random_spawn(1) skip(1) star_3(1) star_2(1) star(1) skip(4)
 *   area(4) 每格 [terrain(1) owner(1) strength(1) skip(1)] skip(24)
 *   fog(1) round_time(4) total_time(4) skip(4) 每玩家 [seat(1) team(4) name(串) computer(4) flag(4)]
 *
 * 适配为本游戏 JSON 地图：删 star_mode、新增空 tags、旧地形码映射
 * （0虚空/1平原/2据点/3山地/4海洋 → 0平原/1据点/3海洋/4山地/5虚空）、
 * 玩家 flag 按座次从 1 起重编号（本地 flag_1..flag_30）。
 *
 * 依赖浏览器全局 API：atob / TextDecoder / DecompressionStream / Blob / Response（Node ≥ 18 亦可用）。
 */
const MapCode = (() => {
  /** 旧地形码 → 本游戏地形码（0虚空/1平原/2据点/3山地/4海洋 → 0平原/1据点/3海洋/4山地/5虚空） */
  const TERRAIN_MAP = { 0: 5, 1: 0, 2: 1, 3: 4, 4: 3 };

  function b64ToBytes(b64) {
    const bin = atob(String(b64 || '').replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  /** zlib 解压（'deflate' = RFC1950 zlib 封装，对应 Python zlib.compress） */
  async function inflateZlib(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** 与 b64coder.ByteReader 一致的二进制读取器（n>4 用 BigInt，避免 32 位位运算溢出） */
  class ByteReader {
    constructor(data) {
      this.data = data;
      this.pos = 0;
    }
    readstr() {
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
    readint(n) {
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
    skip(n) {
      this.pos += n;
    }
  }

  /** 时间戳（自公元 1-01-01 起的小秒数，10^-7 秒）→ "YYYY-MM-DD HH:mm:ss.ffffffX"（与旧 utils.date 一致） */
  function timestickToDate(ts) {
    const us = ts / 10n;
    const tick = ts % 10n;
    const wholeSec = us / 1000000n;
    const micro = us % 1000000n;
    const d = new Date(-62135596800000 + Number(wholeSec * 1000n));
    const pad = (n, l = 2) => String(n).padStart(l, '0');
    return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(micro, 6)}${tick}`;
  }

  /** 解压后的二进制 → 旧版 Map 对象（b64coder.decode_map 的 JS 移植）；畸形数据抛错防超大分配 */
  function parseLegacy(bytes) {
    if (bytes.length < 32) throw new Error('地图码数据过短');
    const r = new ByteReader(bytes);
    const version = r.readint(4);
    const title = r.readstr();
    const description = r.readstr();
    const author = r.readstr();
    const timestamp = timestickToDate(r.readint(8));
    const player_num = r.readint(4);
    const row = r.readint(4);
    const column = r.readint(4);
    if (player_num > 127 || row > 1000 || column > 1000) {
      throw new Error('地图码数据损坏：规模参数异常');
    }
    r.skip(4);
    const cylindrical_map = r.readint(1) === 1;
    const random_spawn = r.readint(1) === 1;
    r.skip(1);
    const star_3 = r.readint(1);
    const star_2 = r.readint(1);
    const star = r.readint(1) === 1;
    r.skip(4);
    const area = r.readint(4);
    if (area > 1_000_000 || r.pos + area * 4 > bytes.length) {
      throw new Error('地图码数据损坏：地块数量异常');
    }
    const battlefield = [];
    for (let i = 0; i < area; i++) {
      battlefield.push([r.readint(1), r.readint(1), r.readint(1)]);
      r.skip(1);
    }
    r.skip(24);
    const fog_mode = r.readint(1) === 1;
    const round_time = r.readint(4);
    const total_time = r.readint(4);
    r.skip(4);
    const player_list = [];
    for (let j = 0; j < player_num; j++) {
      const seat = r.readint(1);
      const teamBits = r.readint(4);
      const team = Math.max(1, 32 - Math.clz32(teamBits)); // 位掩码 → 队号（bit_length）
      const name = r.readstr();
      const computer = r.readint(4);
      const flag = r.readint(4);
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
      star_mode: { star, triple_star_turn: star_3, double_star_turn: star_2 },
      online_time_settings: { total_time, round_time, time_bonus: 0 },
      player_num,
      player_list,
      battlefield,
    };
  }

  /** 旧版 Map → 本游戏 JSON 地图（删 star、加空 tags、地形映射、flag 按座次从 1 重编号） */
  function adaptLegacy(legacy) {
    const bySeat = legacy.player_list.slice().sort((a, b) => a.seat - b.seat);
    const flagBySeat = new Map(bySeat.map((p, i) => [p.seat, i + 1]));
    return {
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
        flag: flagBySeat.get(p.seat),
      })),
      battlefield: legacy.battlefield.map(([t, o, s]) => [TERRAIN_MAP[t] ?? t, o, s]),
    };
  }

  /** 地图码（base64 字符串）→ 本游戏 JSON 地图；成功 { ok:true, map }，失败 { ok:false, error } */
  async function decodeMapCode(b64) {
    if (!b64 || typeof b64 !== 'string') return { ok: false, error: '地图码不能为空' };
    let legacy;
    try {
      legacy = parseLegacy(await inflateZlib(b64ToBytes(b64)));
    } catch (err) {
      return { ok: false, error: `地图码解析失败：${err && err.message ? err.message : err}` };
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

  return { decodeMapCode };
})();
