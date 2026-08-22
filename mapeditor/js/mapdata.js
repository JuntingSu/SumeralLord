/**
 * mapdata.js — 地图数据模型操作（对齐 MapFullData；battlefield 一维，index 0 = 左下）
 */
const MapData = (() => {
  const { TERRAIN, TILE_OWNER, DEFAULT_STRENGTH } = MapConst;

  const pad = (n, l = 2) => String(n).padStart(l, '0');

  /** "YYYY-MM-DD HH:mm:ss.fffffff"（7 位小数秒，与官方地图一致） */
  function nowTimestamp() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}0000`;
  }

  function newEmptyTile() {
    return [TERRAIN.PLAIN, TILE_OWNER.EMPTY, 0];
  }

  /** 随机地图 id：map_ + 8 位随机小写字母数字（保存文件名 map_xxx.json） */
  function randomId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const arr = crypto.getRandomValues(new Uint8Array(8));
      for (const b of arr) s += chars[b % chars.length];
    } else {
      for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
    }
    return 'map_' + s;
  }

  /** 当前登录用户名（主程序 localStorage 的 dl_user；未登录/非浏览器环境返回 ''） */
  function loggedInUsername() {
    try {
      if (typeof localStorage === 'undefined') return '';
      const u = JSON.parse(localStorage.getItem('dl_user') || 'null');
      return u && typeof u.username === 'string' ? u.username : '';
    } catch { return ''; }
  }

  /** 作者默认值：登录用户名；未登录回退 'Unknown' */
  function defaultAuthor() {
    return loggedInUsername() || 'Unknown';
  }

  /** 新建默认地图：全平原无主 + 每势力一座出生据点（环形分布） */
  function createDefaultMap(row, column, playerNum) {
    const map = {
      version: 1,
      title: '新地图',
      description: '',
      author: 'Unknown',
      timestamp: nowTimestamp(),
      row,
      column,
      random_spawn: false,
      cylindrical_map: false,
      fog_mode: false,
      online_time_settings: { total_time: 600, round_time: 60, time_bonus: 0 },
      tags: [],
      player_num: playerNum,
      player_list: [],
      battlefield: [],
    };
    for (let i = 0; i < playerNum; i++) {
      map.player_list.push({ name: `玩家${i + 1}`, team: i + 1, computer: 255, seat: i + 1, flag: i + 1 });
    }
    const total = row * column;
    for (let i = 0; i < total; i++) map.battlefield.push(newEmptyTile());
    const cities = defaultCityPositions(row, column, playerNum);
    for (let i = 0; i < playerNum; i++) {
      const [r, c] = cities[i];
      map.battlefield[r * column + c] = [TERRAIN.CITY, i + 1, DEFAULT_STRENGTH];
    }
    return map;
  }

  function defaultCityPositions(row, column, n) {
    const r0 = Math.floor(row / 2);
    const c0 = Math.floor(column / 2);
    const radius = Math.max(1, Math.min(Math.floor(row / 2), Math.floor(column / 2)) - 1);
    if (n === 1) return [[r0, c0]];
    const out = [];
    for (let i = 0; i < n; i++) {
      const angle = (2 * Math.PI * i) / n - Math.PI / 2;
      let r = Math.round(r0 + Math.sin(angle) * radius);
      let c = Math.round(c0 + Math.cos(angle) * radius);
      r = Math.max(1, Math.min(row - 2, r));
      c = Math.max(1, Math.min(column - 2, c));
      out.push([r, c]);
    }
    return out;
  }

  /** battlefield → 二维 grid[r][c]（grid[0] = 底行，与 index 0 左下一致） */
  function toGrid(map) {
    const grid = [];
    for (let r = 0; r < map.row; r++) {
      grid.push(map.battlefield.slice(r * map.column, (r + 1) * map.column));
    }
    return grid;
  }

  function fromGrid(grid, row, column) {
    const flat = [];
    for (let r = 0; r < row; r++) for (let c = 0; c < column; c++) flat.push(grid[r][c]);
    return flat;
  }

  /** 四边扩缩行列。delta {top,bottom,left,right}，正=增，负=减（受 1..64 限制） */
  function resizeMap(map, delta) {
    let { top = 0, bottom = 0, left = 0, right = 0 } = delta;
    let grid = toGrid(map);
    const rowCap = 64;
    const colCap = 64;
    while (bottom > 0 && grid.length < rowCap) { grid.unshift(Array.from({ length: map.column }, () => newEmptyTile())); bottom--; }
    while (bottom < 0 && grid.length > 1) { grid.shift(); bottom++; }
    while (top > 0 && grid.length < rowCap) { grid.push(Array.from({ length: map.column }, () => newEmptyTile())); top--; }
    while (top < 0 && grid.length > 1) { grid.pop(); top++; }
    while (left > 0 && grid[0].length < colCap) { grid.forEach((row) => row.unshift(newEmptyTile())); left--; }
    while (left < 0 && grid[0].length > 1) { grid.forEach((row) => row.shift()); left++; }
    while (right > 0 && grid[0].length < colCap) { grid.forEach((row) => row.push(newEmptyTile())); right--; }
    while (right < 0 && grid[0].length > 1) { grid.forEach((row) => row.pop()); right++; }
    map.row = grid.length;
    map.column = grid[0].length;
    map.battlefield = fromGrid(grid, map.row, map.column);
  }

  /** 删除势力：战场中该 seat 格归无主清兵；更高 seat 整体 -1；player_list 同步 */
  function removePlayer(map, seat) {
    const idx = map.player_list.findIndex((p) => p.seat === seat);
    if (idx < 0) return;
    map.player_list.splice(idx, 1);
    for (let i = 0; i < map.battlefield.length; i++) {
      const t = map.battlefield[i];
      if (t[1] === seat) {
        t[1] = TILE_OWNER.EMPTY;
        t[2] = 0;
      } else if (t[1] > seat && t[1] <= 127) {
        t[1] -= 1;
      }
    }
    for (const p of map.player_list) if (p.seat > seat) p.seat -= 1;
    map.player_num = map.player_list.length;
  }

  /** 新增势力：分配最小可用 seat 与最小可用 flag */
  function addPlayer(map) {
    const seats = new Set(map.player_list.map((p) => p.seat));
    let seat = 1;
    while (seats.has(seat)) seat++;
    const flags = new Set(map.player_list.map((p) => p.flag));
    let flag = 1;
    while (flags.has(flag)) flag++;
    map.player_list.push({ name: `玩家${seat}`, team: seat, computer: 255, seat, flag });
    map.player_num = map.player_list.length;
    return map.player_list[map.player_list.length - 1];
  }

  /**
   * 调整势力座次：把 seat=fromSeat 的势力移到 toSeat，中间势力顺移，
   * 战场归属同步重映射（seat 即归属标识）。toSeat 越界自动夹紧到 1..n。
   */
  function movePlayerSeat(map, fromSeat, toSeat) {
    const n = map.player_list.length;
    if (n < 2) return;
    toSeat = Math.max(1, Math.min(n, toSeat));
    if (fromSeat === toSeat) return;
    const moved = map.player_list.find((p) => p.seat === fromSeat);
    if (!moved) return;
    const dir = fromSeat < toSeat ? 1 : -1; // +1 座次上移，-1 座次下移
    for (const p of map.player_list) {
      if (p.seat === fromSeat) continue;
      if (dir === 1 && p.seat > fromSeat && p.seat <= toSeat) p.seat -= 1;
      else if (dir === -1 && p.seat < fromSeat && p.seat >= toSeat) p.seat += 1;
    }
    moved.seat = toSeat;
    for (let i = 0; i < map.battlefield.length; i++) {
      const o = map.battlefield[i][1];
      if (o < 1 || o > 127) continue;
      let ns = o;
      if (o === fromSeat) ns = toSeat;
      else if (dir === 1 && o > fromSeat && o <= toSeat) ns = o - 1;
      else if (dir === -1 && o < fromSeat && o >= toSeat) ns = o + 1;
      if (ns !== o) map.battlefield[i][1] = ns;
    }
    return map;
  }

  /** 序列化（剔除 id 字段——地图文件内不含 id，id 由文件名派生） */
  function serialize(map) {
    const copy = JSON.parse(JSON.stringify(map));
    delete copy.id;
    return copy;
  }

  return {
    nowTimestamp, newEmptyTile, createDefaultMap, resizeMap,
    removePlayer, addPlayer, movePlayerSeat, serialize,
    toGrid, fromGrid, randomId, loggedInUsername, defaultAuthor,
  };
})();
