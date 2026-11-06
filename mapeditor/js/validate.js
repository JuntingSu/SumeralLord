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
        if (MapConst.NO_SOLDIER_TERRAIN.has(t) && (o !== TILE_OWNER.EMPTY || s !== 0)) {
          soldierOnBroken++;
        }
        if (o === TILE_OWNER.EMPTY && s !== 0) soldierOnEmpty++;
      });
    }
    if (terrain2 > 0) issues.push({ level: 'warn', text: `发现 ${terrain2} 个废弃地形编码 2` });
    if (soldierOnBroken > 0) issues.push({ level: 'warn', text: `${soldierOnBroken} 个山地/虚空格存在兵力（应无兵）` });
    if (soldierOnEmpty > 0) issues.push({ level: 'warn', text: `${soldierOnEmpty} 个无主格存在兵力（应 0）` });

    // 战役触发器：完整坐标/势力/引用校验由 shared validateMapData 负责；这里拦截明显结构错误
    if (m.triggers !== undefined) {
      if (!Array.isArray(m.triggers)) {
        issues.push({ level: 'error', text: 'triggers 必须为数组' });
      } else if (m.triggers.length > 0) {
        if (m.trigger_schema_version !== 2) {
          issues.push({ level: 'error', text: '含触发器的地图必须使用 trigger_schema_version = 2' });
        }
        const ids = new Set();
        const pathCtx = {
          total: m.row * m.column,
          seats: new Set((m.player_list || []).map((p) => p.seat)),
          ids: new Set(m.triggers.map((t) => (t && t.id) || '')),
          texts: new Set(),
        };
        for (const t of m.triggers) {
          if (!t || !Array.isArray(t.effects)) continue;
          for (const e of t.effects) {
            if (e && (e.op === 'show_text' || e.op === 'hide_text') && e.text_id) {
              pathCtx.texts.add(String(e.text_id));
            }
          }
        }
        m.triggers.forEach((t, i) => {
          if (!t || typeof t !== 'object') {
            issues.push({ level: 'error', text: `触发器 ${i + 1}：必须为对象` });
            return;
          }
          if (typeof t.id !== 'string' || t.id.length === 0) {
            issues.push({ level: 'error', text: `触发器 ${i + 1}：id 必须为非空字符串` });
          } else if (ids.has(t.id)) {
            issues.push({ level: 'error', text: `触发器 ${i + 1}：id=${t.id} 重复` });
          } else {
            ids.add(t.id);
          }
          if (!t.when || typeof t.when !== 'object') {
            issues.push({ level: 'error', text: `触发器 ${i + 1}：缺少 when` });
          } else {
            checkStateConditions(t.when, `触发器 ${i + 1}`, pathCtx, issues);
          }
          if (Array.isArray(t.effects)) {
            t.effects.forEach((e) => {
              if (e && e.op === 'show_text' && typeof e.text === 'string') {
                if (!StatePaths.validateText(e.text, pathCtx)) {
                  issues.push({ level: 'error', text: `触发器 ${i + 1}：文本包含未知的 gamestate 变量` });
                }
              }
            });
          }
          if (!Array.isArray(t.effects) || t.effects.length === 0) {
            issues.push({ level: 'error', text: `触发器 ${i + 1}：effects 须为非空数组` });
          }
          if (t.delay !== undefined) {
            const d = t.delay;
            if (
              !d ||
              !Number.isInteger(d.amount) ||
              d.amount <= 0 ||
              (d.unit !== 'intent' && d.unit !== 'turn' && d.unit !== 'round')
            ) {
              issues.push({ level: 'error', text: `触发器 ${i + 1}：delay 非法` });
            }
          }
        });
        issues.push({ level: 'warn', text: `该地图包含 ${m.triggers.length} 个触发器；仅战役模式会执行` });
      }
    }

    return issues;
  }

  function checkStateConditions(c, label, ctx, issues) {
    if (!c || typeof c !== 'object') return;
    if ((c.op === 'and' || c.op === 'or') && Array.isArray(c.items)) {
      c.items.forEach((x) => checkStateConditions(x, label, ctx, issues));
      return;
    }
    if (c.op === 'not') {
      checkStateConditions(c.item, label, ctx, issues);
      return;
    }
    if (c.op === 'state_assert') {
      if (typeof c.path !== 'string' || !StatePaths.validatePath(c.path, ctx)) {
        issues.push({ level: 'error', text: `${label}：未知的 gamestate 变量 ${c.path}` });
      } else if (c.cmp !== 'changed') {
        if (c.value_ref !== undefined) {
          if (typeof c.value_ref !== 'string' || !StatePaths.validatePath(c.value_ref, ctx)) {
            issues.push({ level: 'error', text: `${label}：预期值引用的 gamestate 变量非法` });
          } else if (c.cmp !== '=') {
            const actual = StatePaths.parse(c.path);
            const ref = StatePaths.parse(c.value_ref);
            if (!actual || actual.def.kind !== 'int' || !ref || ref.def.kind !== 'int') {
              issues.push({ level: 'error', text: `${label}：只有整数变量支持大小比较` });
            }
          }
        } else if (!StatePaths.validateValue(c.path, c.value, ctx)) {
          issues.push({ level: 'error', text: `${label}：预期值与 gamestate 变量类型不匹配` });
        }
      }
    }
  }

  return { validate };
})();
