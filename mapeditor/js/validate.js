/**
 * validate.js — 地图校验（对齐 backend/src/maps/catalog.ts 的 validateMapData + maps.test.ts 软性规则）
 * 返回 [{level: 'error'|'warn', text}]；error 会让保存/加载被后端拒绝，warn 为建议项。
 */
const MapValidate = (() => {
  const { TERRAIN, TILE_OWNER } = MapConst;

  function validate(map) {
    const issues = [];
    if (!map || typeof map !== 'object') {
      issues.push({ level: 'error', text: '地图数据为空' });
      return issues;
    }
    const m = map;

    // 顶层
    if (typeof m.title !== 'string') issues.push({ level: 'error', text: 'title 必须为字符串' });
    if (typeof m.row !== 'number' || !Number.isInteger(m.row) || m.row < 1) issues.push({ level: 'error', text: 'row 必须为正整数' });
    if (typeof m.column !== 'number' || !Number.isInteger(m.column) || m.column < 1) issues.push({ level: 'error', text: 'column 必须为正整数' });
    if (typeof m.player_num !== 'number' || !Number.isInteger(m.player_num)) issues.push({ level: 'error', text: 'player_num 必须为整数' });
    if (!Array.isArray(m.player_list) || m.player_list.length === 0) {
      issues.push({ level: 'error', text: 'player_list 必须为非空数组' });
    }
    if (!Array.isArray(m.battlefield)) {
      issues.push({ level: 'error', text: 'battlefield 必须为数组' });
    } else if (m.row > 0 && m.column > 0) {
      const expect = m.row * m.column;
      if (m.battlefield.length !== expect) {
        issues.push({ level: 'error', text: `battlefield 长度 ${m.battlefield.length} ≠ row×column ${expect}` });
      }
    }

    // 玩家
    const seats = new Set();
    if (Array.isArray(m.player_list)) {
      if (m.player_num !== m.player_list.length) {
        issues.push({ level: 'error', text: `player_num(${m.player_num}) ≠ player_list 长度(${m.player_list.length})` });
      }
      m.player_list.forEach((p, i) => {
        if (!p || typeof p.name !== 'string') issues.push({ level: 'error', text: `玩家 ${i + 1}：name 必须为字符串` });
        for (const k of ['team', 'computer', 'seat', 'flag']) {
          if (typeof p[k] !== 'number' || !Number.isInteger(p[k])) issues.push({ level: 'error', text: `玩家 ${i + 1}：${k} 必须为整数` });
        }
        if (p && typeof p.seat === 'number') {
          if (p.seat < 1 || p.seat > 127) issues.push({ level: 'error', text: `玩家 ${i + 1}：seat 须在 1..127` });
          else if (seats.has(p.seat)) issues.push({ level: 'error', text: `玩家 ${i + 1}：seat=${p.seat} 重复` });
          else seats.add(p.seat);
        }
      });
    }

    // 地块
    const terrainOk = new Set([TERRAIN.PLAIN, TERRAIN.CITY, TERRAIN.OCEAN, TERRAIN.MOUNTAIN, TERRAIN.VOID]);
    const ownerOk = (o) => o === TILE_OWNER.EMPTY || o === TILE_OWNER.BLOCKER || o === TILE_OWNER.WILD || (o >= 1 && o <= 127);
    let terrain2 = 0;
    let soldierOnBroken = 0;
    let soldierOnEmpty = 0;
    const births = new Map(); // seat -> count
    if (Array.isArray(m.battlefield)) {
      m.battlefield.forEach((tile, i) => {
        if (!Array.isArray(tile) || tile.length !== 3) {
          issues.push({ level: 'error', text: `地块 ${i}：必须为 [地形,归属,兵力] 三元组` });
          return;
        }
        const [t, o, s] = tile;
        const bad = !Number.isInteger(t) || !Number.isInteger(o) || !Number.isInteger(s);
        if (bad) issues.push({ level: 'error', text: `地块 ${i}：地形/归属/兵力必须为整数` });
        if (!terrainOk.has(t)) {
          if (t === 2) terrain2++;
          issues.push({ level: 'error', text: `地块 ${i}：地形值 ${t} 非法（合法 0/1/3/4/5，编码 2 已废弃）` });
        }
        if (!ownerOk(o)) issues.push({ level: 'error', text: `地块 ${i}：归属值 ${o} 非法（合法 128/0/255 或 1..127）` });
        if (s < 0) issues.push({ level: 'error', text: `地块 ${i}：兵力 ${s} 不能为负` });
        // 软性
        if (t === TERRAIN.CITY && o >= 1 && o <= 127 && s > 0) {
          births.set(o, (births.get(o) || 0) + 1);
        }
        if (MapConst.NO_SOLDIER_TERRAIN.has(t) && (o !== TILE_OWNER.EMPTY || s !== 0)) {
          soldierOnBroken++;
        }
        if (o === TILE_OWNER.EMPTY && s !== 0) soldierOnEmpty++;
      });
    }
    if (terrain2 > 0) issues.push({ level: 'warn', text: `发现 ${terrain2} 个废弃地形编码 2` });
    if (soldierOnBroken > 0) issues.push({ level: 'warn', text: `${soldierOnBroken} 个山地/虚空格存在兵力（应无兵）` });
    if (soldierOnEmpty > 0) issues.push({ level: 'warn', text: `${soldierOnEmpty} 个无主格存在兵力（应 0）` });

    // 出生点
    if (Array.isArray(m.player_list)) {
      for (const p of m.player_list) {
        if (!p || typeof p.seat !== 'number') continue;
        const n = births.get(p.seat) || 0;
        if (n === 0) issues.push({ level: 'warn', text: `势力「${p.name || p.seat}」(seat=${p.seat}) 没有出生据点` });
        else if (n > 1) issues.push({ level: 'warn', text: `势力「${p.name || p.seat}」(seat=${p.seat}) 有 ${n} 座出生据点（建议恰好 1 座）` });
      }
    }

    return issues;
  }

  return { validate };
})();
