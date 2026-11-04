/**
 * scripteditor.js — 触发器可视化脚本编辑器
 *
 * 结构：
 *   - 右栏「触发器」标签：新建（id + class）、列表（id / class / 编辑 / 删除）
 *   - 左栏「脚本」模式：一次编辑一条 trigger。E 型容器上臂吸附条件、下臂吸附效果。
 *   - and / or / not 为 C 型嵌套容器，仅它们能包含条件；and/or 内条件横向并列。
 *   - 组件参数为文本框：点击后可手输，或点棋盘地块 / 势力列表 / 触发器列表自动填充；
 *     点击非法位置或其他组件会取消拾取。
 *   - 拖动 ⠿/标题吸附到合法容器；右键删除组件，容器内的子组件会变成游离组件。
 *   - 提交时按 E 型容器内容生成 TriggerDef（缺参不允许提交）。
 */
const ScriptEditor = (() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const PHASES = ['PREPARE', 'ACTION', 'ADD_POINT', 'END'];
  const PHASE_LABELS = { PREPARE: '准备阶段', ACTION: '行动阶段', ADD_POINT: '加点阶段', END: '结束阶段' };
  const POSITION_LABELS = {
    top: '上',
    bottom: '下',
    left: '左',
    right: '右',
    'top-left': '左上',
    'top-right': '右上',
    'bottom-left': '左下',
    'bottom-right': '右下',
  };
  const TERRAINS = [0, 1, 3, 4, 5];
  /** 地形参数也接受中文名（虚空/平原/海洋/山地/据点） */
  const TERRAIN_ALIASES = { 虚空: 5, 平原: 0, 海洋: 3, 山地: 4, 据点: 1 };
  const AI_LEVELS = [1, 2, 3, 255];
  const SCREEN_POSITIONS = ['top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
  /** 有限合法值集合：用复选框面板选择 */
  const ENUM_TYPES = new Set(['force', 'seat', 'trigger', 'phase', 'terrain', 'ai', 'bool', 'position', 'seatList']);
  /** 可从棋盘/列表拾取的参数 */
  const PICK_TYPES = new Set(['force', 'trigger', 'terrain']);

  /** 参数定义：type 决定拾取方式与校验 */
  const P = (key, type, label, opts = {}) => ({
    key,
    type,
    label,
    optional: !!opts.optional,
    patch: !!opts.patch,
    spawn: !!opts.spawn,
    min: opts.min,
    max: opts.max,
  });

  const CATALOG = {
    condition: [
      { op: 'and', group: true, label: '全部满足' },
      { op: 'or', group: true, label: '任一满足' },
      { op: 'not', group: true, single: true, label: '不满足' },
      {
        op: 'tile_owner_appeared', classes: ['action'], label: '地块被占领',
        text: '地块 {tile} 被 {force} 占领',
        params: [P('tile', 'tile', '地块'), P('force', 'force', '势力')],
      },
      {
        op: 'tile_emptied', classes: ['action'], label: '地块变为无主',
        text: '地块 {tile} 变为无主',
        params: [P('tile', 'tile', '地块')],
      },
      {
        op: 'tile_owner_changed', classes: ['action'], label: '地块归属变化',
        text: '地块 {tile} 归属由 {from} 变为 {to}',
        params: [P('tile', 'tile', '地块'), P('from', 'force', '原势力', { optional: true }), P('to', 'force', '新势力')],
      },
      {
        op: 'force_gone', classes: ['action'], label: '势力消失',
        text: '势力 {force} 消失',
        params: [P('force', 'force', '势力')],
      },
      {
        op: 'tile_soldier_owner_not', classes: ['action', 'world'], label: '地块守军不属于势力',
        text: '地块 {tile} 的兵不属于 {force}',
        params: [P('tile', 'tile', '地块'), P('force', 'force', '势力')],
      },
      {
        op: 'phase_start', classes: ['world'], label: '阶段开始',
        text: '势力 {force} 的 {phase} 阶段开始，回合 {turn}',
        params: [P('force', 'force', '势力'), P('phase', 'phase', '阶段'), P('turn', 'int', '回合', { optional: true, min: 1 })],
      },
      {
        op: 'phase_end', classes: ['world'], label: '阶段结束',
        text: '势力 {force} 的 {phase} 阶段结束，回合 {turn}',
        params: [P('force', 'force', '势力'), P('phase', 'phase', '阶段'), P('turn', 'int', '回合', { optional: true, min: 1 })],
      },
      {
        op: 'turn_start', classes: ['world'], label: '回合开始',
        text: '第 {turn} 回合开始',
        params: [P('turn', 'int', '回合', { min: 1 })],
      },
      {
        op: 'trigger_fired', classes: ['action', 'world'], label: '触发器已触发',
        text: '触发器 {trigger_id} 已触发',
        params: [P('trigger_id', 'trigger', '触发器')],
      },
      {
        op: 'trigger_done', classes: ['action', 'world'], label: '触发器已结束',
        text: '触发器 {trigger_id} 已结束',
        params: [P('trigger_id', 'trigger', '触发器')],
      },
    ],
    effect: [
      {
        op: 'spawn_soldier', label: '生成兵',
        text: '在地块 {tile} 为 {force} 生成 {strength} 兵（链接 {linked} / 移动 {movement} / 计次 {counter}）',
        params: [
          P('tile', 'tile', '地块'),
          P('force', 'force', '势力', { spawn: true }),
          P('strength', 'int', '兵力', { min: 1 }),
          P('linked', 'bool', '链接', { optional: true }),
          P('movement', 'bool', '移动', { optional: true }),
          P('counter', 'int', '计次', { optional: true, min: 0 }),
        ],
      },
      {
        op: 'update_soldier', label: '修改兵',
        text: '修改地块 {tile} 的兵（兵力 {strength} / 归属 {owner} / 链接 {linked} / 移动 {movement} / 计次 {counter}）',
        params: [
          P('tile', 'tile', '地块'),
          P('strength', 'int', '兵力', { optional: true, patch: true, min: 0 }),
          P('owner', 'seat', '归属', { optional: true, patch: true }),
          P('linked', 'bool', '链接', { optional: true, patch: true }),
          P('movement', 'bool', '移动', { optional: true, patch: true }),
          P('counter', 'int', '计次', { optional: true, patch: true, min: 0 }),
        ],
      },
      {
        op: 'remove_soldier', label: '移除兵',
        text: '移除地块 {tile} 的兵',
        params: [P('tile', 'tile', '地块')],
      },
      {
        op: 'set_terrain', label: '修改地形',
        text: '把地块 {tile} 的地形改为 {terrain}',
        params: [P('tile', 'tile', '地块'), P('terrain', 'terrain', '地形')],
      },
      {
        op: 'update_force', label: '修改势力',
        text: '修改势力 {force}（名称 {name} / 旗帜 {flag} / 队伍 {team} / 点数 {points} / 难度 {computer}）',
        params: [
          P('force', 'force', '势力'),
          P('name', 'text', '名称', { optional: true, patch: true }),
          P('flag', 'int', '旗帜', { optional: true, patch: true }),
          P('team', 'int', '队伍', { optional: true, patch: true }),
          P('points', 'int', '点数', { optional: true, patch: true, min: 0 }),
          P('computer', 'ai', '难度', { optional: true, patch: true }),
        ],
      },
      {
        op: 'clear_force', label: '清空势力',
        text: '清空势力 {force}',
        params: [P('force', 'force', '势力')],
      },
      {
        op: 'transfer_control', label: '转移控制权',
        text: '把控制权交给 {to_force}，AI 难度 {ai_level}',
        params: [P('to_force', 'force', '势力'), P('ai_level', 'ai', 'AI 难度')],
      },
      {
        op: 'set_turn_order', label: '设置行动顺序',
        text: '设置行动顺序为 {order}',
        params: [P('order', 'seatList', '座次顺序')],
      },
      {
        op: 'set_fog', label: '设置迷雾',
        text: '设置迷雾：开启 {enabled} / 显示 {reveal} / 隐藏 {hide}',
        params: [
          P('enabled', 'bool', '开启', { optional: true }),
          P('reveal', 'tileList', '显示地块', { optional: true }),
          P('hide', 'tileList', '隐藏地块', { optional: true }),
        ],
      },
      {
        op: 'show_text', label: '显示文本',
        text: '显示文本 {text_id}：{text}（屏幕方位 {position} / 绑定地块 {tile}）',
        params: [
          P('text_id', 'text', '文本 id'),
          P('text', 'text', '文本内容'),
          P('position', 'position', '屏幕方位', { optional: true }),
          P('tile', 'tile', '绑定地块', { optional: true }),
        ],
      },
      {
        op: 'hide_text', label: '隐藏文本',
        text: '隐藏文本 {text_id}',
        params: [P('text_id', 'text', '文本 id')],
      },
      {
        op: 'insert_move_intent', label: '插入移动意图',
        text: '让 {force} 把地块 {from} 的兵移动到 {to}',
        params: [P('force', 'force', '势力'), P('from', 'tile', '起点'), P('to', 'tile', '终点')],
      },
      {
        op: 'insert_attack_intent', label: '插入进攻意图',
        text: '让 {force} 从地块 {from} 进攻 {to}',
        params: [P('force', 'force', '势力'), P('from', 'tile', '起点'), P('to', 'tile', '终点')],
      },
      {
        op: 'insert_add_point_intent', label: '插入加点意图',
        text: '让 {force} 在地块 {coordinate} 加点 {amount}',
        params: [P('force', 'force', '势力'), P('coordinate', 'tile', '地块'), P('amount', 'int', '点数', { min: 1 })],
      },
      {
        op: 'end_game', label: '结束游戏',
        text: '游戏结束，获胜队伍 {winning_team}',
        params: [P('winning_team', 'int', '获胜队伍')],
      },
    ],
  };

  const state = {
    /** 当前编辑 { id, cls, isNew, src? } */
    editing: null,
    /** 组件类别选择（默认条件） */
    kind: 'condition',
    cond: [],
    eff: [],
    free: [],
    pick: null,
    pop: null,
    dragUid: null,
  };

  // 目录项补上类别，供 DSL 回填 / 校验区分条件与效果
  for (const kind of ['condition', 'effect']) {
    for (const def of CATALOG[kind]) def.kind = kind;
  }

  let uidSeq = 1;
  const nextUid = () => uidSeq++;

  function defOf(kind, op) {
    return (CATALOG[kind] || []).find((d) => d.op === op) || null;
  }
  function defOfOp(op) {
    return defOf('condition', op) || defOf('effect', op);
  }

  // ==================== 提示 ====================
  function toast(message, kind = 'ok') {
    const hint = $('trg-hint');
    if (hint) {
      hint.textContent = message;
      hint.classList.toggle('err', kind === 'error');
    }
    window.MapEditorActions?.statusMsg?.(message, kind);
  }
  function defaultHint() {
    if (!state.editing) return '';
    return `正在编辑「${state.editing.id}」（${state.editing.cls}）：拖动 ⠿/标题调整或嵌套，右键删除组件。`;
  }
  function setHint(message, isError = false) {
    const hint = $('trg-hint');
    if (!hint) return;
    hint.textContent = message;
    hint.classList.toggle('err', isError);
  }

  // ==================== 模型 ====================
  function newNode(op, kind) {
    const def = defOf(kind, op);
    return { uid: nextUid(), kind, op, params: {}, children: [] };
  }

  /** DSL → 编辑节点 */
  function dslToNode(obj) {
    const def = defOfOp(obj.op);
    if (!def) return newNode('and', 'condition');
    if (def.group) {
      const node = { uid: nextUid(), kind: 'condition', op: obj.op, params: {}, children: [] };
      if (obj.op === 'not') {
        if (obj.item) node.children = [dslToNode(obj.item)];
      } else {
        node.children = (obj.items || []).map(dslToNode);
      }
      return node;
    }
    const node = { uid: nextUid(), kind: def.kind, op: obj.op, params: {}, children: [] };
    for (const p of def.params) {
      let v;
      if (p.patch) v = obj.patch ? obj.patch[p.key] : undefined;
      else if (obj.op === 'show_text' && p.key === 'position') {
        v = obj.placement && obj.placement.kind === 'screen' ? obj.placement.position : undefined;
      } else if (obj.op === 'show_text' && p.key === 'tile' && p.optional) {
        v = obj.placement && obj.placement.kind === 'tile' ? obj.placement.tile : undefined;
      } else {
        v = obj[p.key];
      }
      if (Array.isArray(v)) v = v.join(', ');
      node.params[p.key] = v === undefined || v === null ? '' : String(v);
    }
    return node;
  }

  function walk(list, fn) {
    for (let i = 0; i < list.length; i++) {
      if (fn(list[i], list, i)) return true;
      if (list[i].children && list[i].children.length && walk(list[i].children, fn)) return true;
    }
    return false;
  }
  function findEntry(uid) {
    let found = null;
    for (const list of [state.cond, state.eff, state.free]) {
      walk(list, (node, l, i) => {
        if (node.uid === uid) {
          found = { node, list: l, index: i };
          return true;
        }
        return false;
      });
      if (found) break;
    }
    return found;
  }
  function isAncestor(uid, node) {
    if (!node || node.uid === uid) return false;
    let hit = false;
    walk([node], (n) => {
      if (n.uid === uid) { hit = true; return true; }
      return false;
    });
    return hit;
  }

  // ==================== 参数校验 / 序列化 ====================
  function ctxOf(map) {
    const ids = new Set((map.triggers || []).map((t) => t.id));
    if (state.editing) ids.add(state.editing.id);
    return {
      total: map.row * map.column,
      seats: new Set(map.player_list.map((p) => p.seat)),
      seatCount: map.player_list.length,
      ids,
    };
  }

  function convertParam(param, raw, ctx) {
    const v = raw.trim();
    switch (param.type) {
      case 'tile': {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0 || n >= ctx.total) throw new Error(`「${param.label}」需为 0..${ctx.total - 1} 的地块序号`);
        return n;
      }
      case 'force': {
        if (v === 'player') return 'player';
        if (param.spawn && v === 'next_after_player') return 'next_after_player';
        const n = Number(v);
        if (!Number.isInteger(n) || !ctx.seats.has(n)) throw new Error(`「${param.label}」需为现有势力座次或 player`);
        return n;
      }
      case 'seat': {
        const n = Number(v);
        if (!Number.isInteger(n) || !ctx.seats.has(n)) throw new Error(`「${param.label}」需为现有势力座次`);
        return n;
      }
      case 'trigger': {
        if (!ctx.ids.has(v)) throw new Error(`触发器「${v}」不存在`);
        return v;
      }
      case 'int': {
        const n = Number(v);
        if (!Number.isInteger(n)) throw new Error(`「${param.label}」需为整数`);
        if (param.min !== undefined && n < param.min) throw new Error(`「${param.label}」不能小于 ${param.min}`);
        if (param.max !== undefined && n > param.max) throw new Error(`「${param.label}」不能大于 ${param.max}`);
        return n;
      }
      case 'bool': {
        if (v === 'true' || v === '1') return true;
        if (v === 'false' || v === '0') return false;
        throw new Error(`「${param.label}」需为 true/false`);
      }
      case 'phase':
        if (!PHASES.includes(v)) throw new Error(`「${param.label}」需为 ${PHASES.join('/')}`);
        return v;
      case 'terrain': {
        const n = /^[0-9]+$/.test(v) ? Number(v) : TERRAIN_ALIASES[v];
        if (!TERRAINS.includes(n)) throw new Error(`「${param.label}」需为 0/1/3/4/5 或 虚空/平原/海洋/山地/据点`);
        return n;
      }
      case 'ai': {
        const n = Number(v);
        if (!AI_LEVELS.includes(n)) throw new Error(`「${param.label}」需为 1/2/3/255`);
        return n;
      }
      case 'position':
        if (!SCREEN_POSITIONS.includes(v)) throw new Error(`「${param.label}」需为 ${SCREEN_POSITIONS.join('/')}`);
        return v;
      case 'tileList': {
        const arr = v.split(/[,，\s]+/).filter(Boolean).map(Number);
        if (!arr.length || arr.some((n) => !Number.isInteger(n) || n < 0 || n >= ctx.total)) {
          throw new Error(`「${param.label}」需为逗号分隔的地块序号`);
        }
        return arr;
      }
      case 'seatList': {
        const arr = v.split(/[,，\s]+/).filter(Boolean).map(Number);
        if (
          arr.length !== ctx.seatCount ||
          arr.some((n) => !ctx.seats.has(n)) ||
          new Set(arr).size !== arr.length
        ) {
          throw new Error(`「${param.label}」需包含全部 ${ctx.seatCount} 个势力座次且不重复`);
        }
        return arr;
      }
      default:
        return v;
    }
  }

  function buildLeaf(node, ctx) {
    const def = defOfOp(node.op);
    if (!def || def.group) throw new Error('效果位置只能放效果组件');
    const out = { op: node.op };
    const patch = {};
    let patchCount = 0;
    for (const p of def.params) {
      const raw = (node.params[p.key] || '').trim();
      if (!raw) {
        if (p.optional) continue;
        throw new Error(`请填写「${p.label}」`);
      }
      if (p.patch) {
        patch[p.key] = convertParam(p, raw, ctx);
        patchCount++;
        continue;
      }
      if (node.op === 'show_text' && (p.key === 'position' || p.key === 'tile')) continue; // placement 单独处理
      out[p.key] = convertParam(p, raw, ctx);
    }
    if (node.op === 'update_soldier' || node.op === 'update_force') {
      if (patchCount === 0) throw new Error('「修改」类效果至少填写一个修改项');
      out.patch = patch;
    }
    if (node.op === 'show_text') {
      const tileRaw = (node.params.tile || '').trim();
      const posRaw = (node.params.position || '').trim();
      const tileParam = def.params.find((p) => p.key === 'tile');
      const posParam = def.params.find((p) => p.key === 'position');
      if (tileRaw) out.placement = { kind: 'tile', tile: convertParam(tileParam, tileRaw, ctx) };
      else if (posRaw) out.placement = { kind: 'screen', position: convertParam(posParam, posRaw, ctx) };
    }
    return out;
  }

  function buildCondition(node, ctx) {
    if (node.kind !== 'condition') throw new Error('条件区只能放条件组件');
    const def = defOfOp(node.op);
    if (!def) throw new Error('未知条件组件');
    if (def.group) {
      if (node.op === 'not') {
        if (node.children.length !== 1) throw new Error('「不满足」需要且只能包含 1 个条件');
        return { op: 'not', item: buildCondition(node.children[0], ctx) };
      }
      if (!node.children.length) throw new Error(`「${def.label}」至少需要 1 个条件`);
      return { op: node.op, items: node.children.map((c) => buildCondition(c, ctx)) };
    }
    return buildLeaf(node, ctx);
  }

  function buildTrigger() {
    if (!state.editing) throw new Error('没有正在编辑的触发器');
    const map = Editor.getState().map;
    if (!map) throw new Error('没有地图');
    const ctx = ctxOf(map);
    if (!state.cond.length) throw new Error('请至少添加一个条件');
    if (!state.eff.length) throw new Error('请至少添加一个效果');
    const cond = state.cond.map((n) => buildCondition(n, ctx));
    const when = cond.length === 1 ? cond[0] : { op: 'and', items: cond };
    const effects = state.eff.map((n) => buildLeaf(n, ctx));
    const base = state.editing.src ? JSON.parse(JSON.stringify(state.editing.src)) : {};
    return { ...base, id: state.editing.id, class: state.editing.cls, when, effects };
  }

  // ==================== 渲染：右栏触发器列表 ====================
  function triggerRow(id, cls, badge) {
    const row = document.createElement('div');
    row.className = 'trg-item';
    row.dataset.triggerId = id;
    if (state.editing && state.editing.id === id) row.classList.add('editing');
    row.innerHTML = `
      <span class="trg-item-id" title="${esc(id)}">${esc(id)}</span>
      <span class="trg-item-class ${esc(cls)}">${esc(cls)}</span>
      ${badge ? `<span class="trg-item-badge">${esc(badge)}</span>` : ''}
      <button type="button" data-act="edit">编辑</button>
      <button type="button" data-act="del">删除</button>
    `;
    return row;
  }

  function renderManager() {
    const map = Editor.getState().map;
    const list = $('trigger-list');
    if (!list) return;
    list.innerHTML = '';
    if (!map) return;
    const triggers = Array.isArray(map.triggers) ? map.triggers : [];
    if (state.editing && state.editing.isNew) {
      list.appendChild(triggerRow(state.editing.id, state.editing.cls, '编辑中'));
    }
    for (const t of triggers) list.appendChild(triggerRow(t.id, t.class));
    if (!triggers.length && !(state.editing && state.editing.isNew)) {
      const none = document.createElement('p');
      none.className = 'hint';
      none.textContent = '还没有触发器。填写 id、选择 class 后点「新建」。';
      list.appendChild(none);
    }
  }

  // ==================== 渲染：脚本编辑区 ====================
  function renderOpOptions() {
    const sel = $('trg-op');
    if (!sel) return;
    const kind = state.kind;
    const defs = (CATALOG[kind] || []).filter((d) => {
      if (kind !== 'condition' || d.group) return true;
      return !d.classes || d.classes.includes(state.editing?.cls);
    });
    const prev = sel.value;
    sel.innerHTML = '';
    for (const d of defs) {
      const opt = document.createElement('option');
      opt.value = d.op;
      opt.textContent = d.label;
      sel.appendChild(opt);
    }
    if (defs.some((d) => d.op === prev)) sel.value = prev;
  }

  // ---------- 参数控件 ----------
  function renderParamField(node, param) {
    if (param.type === 'int') return renderNumberInput(node, param);
    if (ENUM_TYPES.has(param.type)) return renderEnumControl(node, param);
    return renderTextInput(node, param);
  }

  function renderTextInput(node, param) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'trg-param';
    input.dataset.uid = String(node.uid);
    input.dataset.key = param.key;
    input.dataset.type = param.type;
    input.value = node.params[param.key] || '';
    input.placeholder = param.label + (param.optional ? '(可选)' : '');
    input.title = param.optional ? '可留空' : '必填';
    if (param.type === 'tile') {
      input.classList.add('pickable');
      input.title = `${param.label}：可手输，或点击后点棋盘拾取`;
    }
    input.addEventListener('input', () => {
      node.params[param.key] = input.value;
      cancelPick();
    });
    input.addEventListener('focus', () => {
      if (param.type === 'tile') setPick(node, param, input);
      else cancelPick();
    });
    return input;
  }

  function renderNumberInput(node, param) {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'trg-param';
    input.dataset.uid = String(node.uid);
    input.dataset.key = param.key;
    input.dataset.type = param.type;
    input.value = node.params[param.key] || '';
    input.placeholder = param.label + (param.optional ? '(可选)' : '');
    input.title = param.optional ? '可留空' : '必填';
    if (param.min !== undefined) input.min = String(param.min);
    if (param.max !== undefined) input.max = String(param.max);
    input.step = '1';
    input.addEventListener('input', () => {
      node.params[param.key] = input.value;
      cancelPick();
    });
    input.addEventListener('focus', () => cancelPick());
    return input;
  }

  function renderEnumControl(node, param) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'trg-param trg-select';
    btn.dataset.uid = String(node.uid);
    btn.dataset.key = param.key;
    btn.dataset.type = param.type;
    const val = document.createElement('span');
    val.className = 'trg-val';
    val.textContent = displayValue(param, node.params[param.key]);
    const caret = document.createElement('span');
    caret.className = 'trg-caret';
    caret.textContent = '▾';
    btn.append(val, caret);
    btn.title = `${param.label}：点击展开所有合法值${PICK_TYPES.has(param.type) ? '；也可直接点棋盘/列表拾取' : ''}`;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (PICK_TYPES.has(param.type)) setPick(node, param, btn);
      else cancelPick();
      openParamPop(node, param, btn);
    });
    return btn;
  }

  function isMultiParam(param) {
    return param.type === 'seatList';
  }

  /** 参数值 → 控件显示文字 */
  function displayValue(param, raw) {
    const v = String(raw ?? '').trim();
    if (v === '') return '选择';
    switch (param.type) {
      case 'force':
        if (v === 'player') return '玩家';
        if (v === 'next_after_player') return '下一势力';
        return `P${v}`;
      case 'seat':
        return `P${v}`;
      case 'terrain': {
        const n = /^[0-9]+$/.test(v) ? Number(v) : TERRAIN_ALIASES[v];
        return MapConst.TERRAIN_LABELS[n] ?? v;
      }
      case 'phase':
        return PHASE_LABELS[v] ?? v;
      case 'ai':
        return MapConst.AI_LABELS[Number(v)] ?? v;
      case 'bool':
        return v === 'true' ? '是' : v === 'false' ? '否' : v;
      case 'position':
        return POSITION_LABELS[v] ?? v;
      default:
        return v;
    }
  }

  /** 当前值（多选返回数组；地形把中文名归一为数字串） */
  function currentValues(node, param) {
    const raw = String(node.params[param.key] ?? '').trim();
    if (!raw) return [];
    if (isMultiParam(param)) return raw.split(/[,，\s]+/).filter(Boolean);
    if (param.type === 'terrain') return [/^[0-9]+$/.test(raw) ? raw : String(TERRAIN_ALIASES[raw] ?? raw)];
    return [raw];
  }

  /** 某参数的全部合法值 */
  function optionList(node, param) {
    const map = Editor.getState().map;
    const seats = map ? [...map.player_list].sort((a, b) => a.seat - b.seat) : [];
    switch (param.type) {
      case 'force': {
        const out = seats.map((p) => ({ value: String(p.seat), label: `P${p.seat} ${p.name || ''}`.trim() }));
        out.push({ value: 'player', label: '当前玩家（player）' });
        if (param.spawn) out.push({ value: 'next_after_player', label: '行动顺序下一势力' });
        return out;
      }
      case 'trigger':
        return (map?.triggers || []).map((t) => ({ value: t.id, label: t.id }));
      case 'phase':
        return PHASES.map((v) => ({ value: v, label: PHASE_LABELS[v] }));
      case 'terrain':
        return ['5', '0', '3', '4', '1'].map((v) => ({ value: v, label: MapConst.TERRAIN_LABELS[Number(v)] }));
      case 'ai': {
        const vals = node.op === 'transfer_control' ? [1, 2, 255] : AI_LEVELS;
        return vals.map((v) => ({ value: String(v), label: MapConst.AI_LABELS[v] || String(v) }));
      }
      case 'bool':
        return [
          { value: 'true', label: '是' },
          { value: 'false', label: '否' },
        ];
      case 'position':
        return Object.keys(POSITION_LABELS).map((v) => ({ value: v, label: POSITION_LABELS[v] }));
      case 'seatList':
        return seats.map((p) => ({ value: String(p.seat), label: `P${p.seat} ${p.name || ''}`.trim() }));
      case 'seat':
        return seats.map((p) => ({ value: String(p.seat), label: `P${p.seat} ${p.name || ''}`.trim() }));
      default:
        return [];
    }
  }

  function updateControlLabel(control, param, value) {
    const val = control.querySelector('.trg-val');
    if (val) val.textContent = displayValue(param, value);
  }

  function closeParamPop() {
    const pop = $('trg-param-pop');
    if (pop) {
      pop.hidden = true;
      pop.innerHTML = '';
    }
    state.pop = null;
  }

  /** 打开参数选项面板：展示该参数的全部合法值复选框 */
  function openParamPop(node, param, control) {
    closeParamPop();
    const pop = $('trg-param-pop');
    if (!pop) return;
    pop.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'trg-pop-title';
    title.textContent = param.label + (isMultiParam(param) ? '（可多选）' : '');
    pop.appendChild(title);

    const opts = optionList(node, param);
    const current = currentValues(node, param);
    if (!opts.length) {
      const none = document.createElement('div');
      none.className = 'trg-pop-none';
      none.textContent = '没有可选值';
      pop.appendChild(none);
    }
    const refreshChecks = () => {
      const cur = currentValues(node, param);
      pop.querySelectorAll('input[type="checkbox"][data-opt]').forEach((cb) => {
        cb.checked = cur.includes(cb.dataset.opt);
      });
    };
    for (const opt of opts) {
      const label = document.createElement('label');
      label.className = 'trg-opt';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.opt = opt.value;
      cb.checked = current.includes(opt.value);
      const span = document.createElement('span');
      span.textContent = opt.label;
      label.append(cb, span);
      cb.addEventListener('change', () => {
        if (isMultiParam(param)) {
          const set = new Set(currentValues(node, param));
          if (cb.checked) set.add(opt.value);
          else set.delete(opt.value);
          const arr = [...set].sort((a, b) => Number(a) - Number(b));
          node.params[param.key] = arr.join(', ');
          updateControlLabel(control, param, node.params[param.key]);
          refreshChecks();
        } else {
          // 单选：勾选即生效，不允许把唯一选项取消掉
          if (!cb.checked) {
            cb.checked = true;
            return;
          }
          node.params[param.key] = opt.value;
          updateControlLabel(control, param, opt.value);
          cancelPick();
          closeParamPop();
        }
      });
      pop.appendChild(label);
    }
    if (param.optional && !isMultiParam(param)) {
      const label = document.createElement('label');
      label.className = 'trg-opt';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.opt = '';
      cb.checked = current.length === 0;
      const span = document.createElement('span');
      span.textContent = '不设置（留空）';
      label.append(cb, span);
      cb.addEventListener('change', () => {
        if (!cb.checked) {
          cb.checked = true;
          return;
        }
        node.params[param.key] = '';
        updateControlLabel(control, param, '');
        cancelPick();
        closeParamPop();
      });
      pop.appendChild(label);
    }

    pop.hidden = false;
    const r = control.getBoundingClientRect();
    const left = Math.max(4, Math.min(window.innerWidth - pop.offsetWidth - 8, r.left));
    const top = Math.max(4, Math.min(window.innerHeight - pop.offsetHeight - 8, r.bottom + 4));
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    state.pop = { node, param, control };
  }

  function renderNode(node) {
    const def = defOfOp(node.op);
    const el = document.createElement('div');
    el.className = 'trg-comp';
    el.dataset.uid = String(node.uid);

    if (def.group) {
      el.classList.add('trg-group');
      const head = document.createElement('div');
      head.className = 'trg-head';
      head.draggable = true;
      head.title = '拖动以移动/嵌套';
      head.textContent = `⠿ ${def.label}`;
      const children = document.createElement('div');
      children.className = 'trg-children' + (node.children.length ? '' : ' empty');
      children.dataset.drop = 'group';
      children.dataset.groupUid = String(node.uid);
      node.children.forEach((child) => children.appendChild(renderNode(child)));
      el.appendChild(head);
      el.appendChild(children);
    } else {
      const grip = document.createElement('span');
      grip.className = 'trg-grip';
      grip.draggable = true;
      grip.title = '拖动以移动/嵌套';
      grip.textContent = '⠿';
      el.appendChild(grip);
      const parts = def.text.split(/\{(\w+)\}/g);
      parts.forEach((part, i) => {
        if (i % 2 === 0) {
          if (part) el.appendChild(document.createTextNode(part));
        } else {
          const param = def.params.find((p) => p.key === part);
          if (param) el.appendChild(renderParamField(node, param));
        }
      });
    }

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      deleteNode(node.uid);
    });
    return el;
  }

  function renderEditor() {
    closeParamPop();
    const empty = $('trg-empty');
    const ed = $('trg-editor');
    if (!empty || !ed) return;
    if (!state.editing) {
      empty.hidden = false;
      ed.hidden = true;
      state.pick = null;
      return;
    }
    empty.hidden = true;
    ed.hidden = false;
    const cls = state.editing.cls;
    const title = $('trg-editing');
    if (title) title.textContent = `正在编辑：${state.editing.id}（${cls}）`;
    $('trg-kind').value = state.kind;
    renderOpOptions();

    const condRow = $('trg-cond-row');
    condRow.innerHTML = '';
    state.cond.forEach((n) => condRow.appendChild(renderNode(n)));

    const effRow = $('trg-eff-row');
    effRow.innerHTML = '';
    state.eff.forEach((n) => effRow.appendChild(renderNode(n)));

    const freeRow = $('trg-free-row');
    freeRow.innerHTML = '';
    state.free.forEach((n) => freeRow.appendChild(renderNode(n)));
    $('trg-free').hidden = state.free.length === 0;

    if (!state.pick) setHint(defaultHint());
  }

  // ==================== 右栏触发器操作 ====================
  function createDraft() {
    const map = Editor.getState().map;
    if (!map) return toast('没有地图，无法创建触发器', 'error');
    const id = ($('trg-new-id').value || '').trim();
    const cls = $('trg-new-class').value;
    if (!id) return toast('请填写触发器 id', 'error');
    if (id.length > 64) return toast('触发器 id 不能超过 64 个字符', 'error');
    if ((map.triggers || []).some((t) => t.id === id)) return toast(`触发器 id「${id}」已存在`, 'error');
    if (state.editing && state.editing.isNew && state.editing.id === id) return;
    startEdit({ id, cls, isNew: true });
    $('trg-new-id').value = '';
  }

  function startEdit(trigger) {
    if (document.body.classList.contains('mobile')) {
      return toast('窄屏暂不支持脚本编辑，请使用桌面端', 'error');
    }
    state.editing = trigger;
    state.cond = trigger.when ? [dslToNode(trigger.when)] : [];
    state.eff = (trigger.effects || []).map(dslToNode);
    state.free = [];
    state.pick = null;
    state.kind = 'condition';
    Editor.setTool('script');
    renderManager();
    renderEditor();
  }

  function editTrigger(id) {
    const map = Editor.getState().map;
    const t = map && (map.triggers || []).find((x) => x.id === id);
    if (!t) return toast(`触发器「${id}」不存在`, 'error');
    startEdit({
      id: t.id,
      cls: t.class,
      isNew: false,
      src: JSON.parse(JSON.stringify(t)),
      when: t.when,
      effects: t.effects,
    });
  }

  function deleteTrigger(id) {
    const map = Editor.getState().map;
    if (!map) return;
    if (!window.confirm(`删除触发器「${id}」？`)) return;
    if (state.editing && state.editing.id === id) closeEditor();
    Editor.commit((m) => {
      m.triggers = (m.triggers || []).filter((t) => t.id !== id);
    });
    renderManager();
  }

  function closeEditor() {
    state.editing = null;
    state.cond = [];
    state.eff = [];
    state.free = [];
    cancelPick();
    closeParamPop();
    renderManager();
    renderEditor();
  }

  // ==================== 组件编辑 ====================
  function deleteNode(uid) {
    const entry = findEntry(uid);
    if (!entry) return;
    entry.list.splice(entry.index, 1);
    if (entry.node.children && entry.node.children.length) {
      state.free.push(...entry.node.children);
    }
    cancelPick();
    renderEditor();
  }

  function addComponent() {
    if (!state.editing) return;
    const op = $('trg-op').value;
    const def = defOf(state.kind, op);
    if (!def) return;
    const node = newNode(op, state.kind);
    if (state.kind === 'condition') state.cond.push(node);
    else state.eff.push(node);
    renderEditor();
  }

  function setPick(node, param, anchor) {
    cancelPick();
    state.pick = { node, key: param.key, type: param.type, param, anchor, label: param.label };
    anchor.classList.add('picking');
    const where =
      param.type === 'tile'
        ? '棋盘地块'
        : param.type === 'terrain'
          ? '棋盘地块（取其地形）'
          : param.type === 'force'
            ? '右侧「势力」列表中的势力'
            : '右侧「触发器」列表中的触发器';
    setHint(`点击${where}填充「${param.label}」；也可以直接从选项中选择，点其他位置取消。`);
  }

  function cancelPick() {
    if (state.pick?.anchor) state.pick.anchor.classList.remove('picking');
    state.pick = null;
    if (state.editing) setHint(defaultHint());
  }

  function fillPick(value) {
    const pick = state.pick;
    if (!pick) return;
    const str = String(value);
    pick.node.params[pick.key] = str;
    if (pick.anchor && pick.anchor.isConnected) {
      if (pick.anchor.tagName === 'INPUT') pick.anchor.value = str;
      else updateControlLabel(pick.anchor, pick.param, str);
      pick.anchor.classList.add('picking');
    }
    // 拾取状态保留：继续点击合法目标可反复修改，点其他位置才取消
    setHint(`已填入「${pick.label}」：${displayValue(pick.param, str)}；可继续点击修改，点其他位置取消。`);
  }

  function handleBoardClick(index) {
    const pick = state.pick;
    if (!pick) return false;
    if (pick.type !== 'tile' && pick.type !== 'terrain') {
      cancelPick();
      return true;
    }
    const map = Editor.getState().map;
    if (!map || index < 0 || index >= map.row * map.column) {
      cancelPick();
      return true;
    }
    if (pick.type === 'terrain') {
      fillPick(map.battlefield[index][0]);
    } else {
      fillPick(index);
    }
    return true;
  }

  // ==================== 拖拽 / 吸附 ====================
  let dragNode = null;

  function canDrop(target, node) {
    if (!target || !node) return false;
    const kind = target.dataset.drop;
    if (kind === 'cond') return node.kind === 'condition';
    if (kind === 'eff') return node.kind === 'effect';
    if (kind === 'free') return true;
    if (kind === 'group') {
      if (node.kind !== 'condition') return false;
      const group = findEntry(Number(target.dataset.groupUid))?.node;
      if (!group) return false;
      if (group.uid === node.uid || isAncestor(node.uid, group)) return false;
      if (group.op === 'not' && group.children.length > 0 && group.children[0].uid !== node.uid) return false;
      return true;
    }
    return false;
  }

  function dropIndex(container, clientX, clientY, uid, vertical) {
    const kids = [...container.children].filter(
      (el) => el.classList.contains('trg-comp') && el.dataset.uid !== String(uid),
    );
    let idx = 0;
    for (const el of kids) {
      const r = el.getBoundingClientRect();
      const mid = vertical ? r.top + r.height / 2 : r.left + r.width / 2;
      const pos = vertical ? clientY : clientX;
      if (pos > mid) idx++;
    }
    return idx;
  }

  function handleDrop(e) {
    const target = e.target.closest('[data-drop]');
    if (!target || !dragNode) return;
    if (!canDrop(target, dragNode)) return;
    e.preventDefault();

    const entry = findEntry(dragNode.uid);
    if (!entry) return;
    const kind = target.dataset.drop;
    const vertical =
      target.id === 'trg-cond-row' ||
      target.id === 'trg-eff-row' ||
      target.classList.contains('trg-children');
    const idx = dropIndex(target, e.clientX, e.clientY, dragNode.uid, vertical);
    entry.list.splice(entry.index, 1);

    if (kind === 'cond') state.cond.splice(Math.min(idx, state.cond.length), 0, dragNode);
    else if (kind === 'eff') state.eff.splice(Math.min(idx, state.eff.length), 0, dragNode);
    else if (kind === 'free') state.free.splice(Math.min(idx, state.free.length), 0, dragNode);
    else if (kind === 'group') {
      const group = findEntry(Number(target.dataset.groupUid))?.node;
      if (group) group.children.splice(Math.min(idx, group.children.length), 0, dragNode);
    }
    dragNode = null;
    state.dragUid = null;
    clearDropHighlight();
    renderEditor();
  }

  let highlightEl = null;
  function clearDropHighlight() {
    if (highlightEl) highlightEl.classList.remove('drop-ok');
    highlightEl = null;
  }
  function highlightDrop(el) {
    if (highlightEl === el) return;
    clearDropHighlight();
    highlightEl = el;
    if (el) el.classList.add('drop-ok');
  }

  // ==================== 提交 ====================
  function submit() {
    let trigger;
    try {
      trigger = buildTrigger();
    } catch (e) {
      setHint(e.message, true);
      toast(e.message, 'error');
      return;
    }
    const editing = state.editing;
    const map = Editor.getState().map;
    if (editing.isNew && (map.triggers || []).some((t) => t.id === editing.id)) {
      const msg = `触发器 id「${editing.id}」已存在`;
      setHint(msg, true);
      return toast(msg, 'error');
    }
    closeEditor();
    Editor.commit((m) => {
      m.triggers = Array.isArray(m.triggers) ? m.triggers.slice() : [];
      if (editing.isNew) m.triggers.push(trigger);
      else {
        const i = m.triggers.findIndex((t) => t.id === editing.id);
        if (i >= 0) m.triggers[i] = trigger;
        else m.triggers.push(trigger);
      }
      m.trigger_schema_version = 1;
    });
    toast(`已提交触发器「${editing.id}」`);
  }

  // ==================== 事件绑定 ====================
  function bind() {
    $('btn-trg-create')?.addEventListener('click', createDraft);
    $('btn-trg-add')?.addEventListener('click', addComponent);
    $('btn-trg-submit')?.addEventListener('click', submit);
    $('btn-trg-cancel')?.addEventListener('click', () => closeEditor());
    $('trg-kind')?.addEventListener('change', () => {
      state.kind = $('trg-kind').value;
      renderOpOptions();
    });

    // 触发器列表：拾取 trigger_id 优先，其次是编辑/删除
    $('trigger-list')?.addEventListener('click', (e) => {
      const item = e.target.closest('.trg-item');
      if (state.pick) {
        if (state.pick.type === 'trigger' && item) {
          e.preventDefault();
          e.stopPropagation();
          fillPick(item.dataset.triggerId);
          closeParamPop();
        } else {
          cancelPick();
        }
        return;
      }
      if (!item) return;
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'edit') editTrigger(item.dataset.triggerId);
      else if (act === 'del') deleteTrigger(item.dataset.triggerId);
    });

    // 势力列表：拾取 force 座次（捕获阶段，优先于势力面板自身交互）
    $('player-list')?.addEventListener(
      'click',
      (e) => {
        if (!state.pick) return;
        const row = e.target.closest('.prow');
        if (state.pick.type === 'force' && row && row.dataset.seat !== undefined) {
          e.preventDefault();
          e.stopPropagation();
          fillPick(row.dataset.seat);
          closeParamPop();
        } else {
          cancelPick();
        }
      },
      true,
    );

    // 点击其他位置取消拾取（参数控件自身 / 选项面板 / 两个可拾取列表 / 棋盘由 mousedown 处理）
    document.addEventListener('click', (e) => {
      if (!state.pick) return;
      if (e.target === state.pick.anchor) return;
      if (state.pick.anchor && e.target.closest('.trg-select') === state.pick.anchor) return;
      if (e.target.closest('#trg-param-pop')) return;
      if (e.target.closest('#player-list') || e.target.closest('#trigger-list') || e.target.closest('#board')) return;
      cancelPick();
    });

    // 点击选项面板外关闭面板
    document.addEventListener('click', (e) => {
      if (!state.pop) return;
      if (e.target.closest('#trg-param-pop')) return;
      if (e.target.closest('.trg-select') === state.pop.control) return;
      closeParamPop();
    });

    // Esc 优先关闭选项面板，不打断当前工具
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.pop) {
        closeParamPop();
        e.stopPropagation();
      }
    }, true);

    // 拖拽
    const root = $('trg-editor');
    root?.addEventListener('dragstart', (e) => {
      const handle = e.target.closest('.trg-grip, .trg-head');
      if (!handle) return;
      const comp = handle.closest('.trg-comp');
      if (!comp) return;
      const entry = findEntry(Number(comp.dataset.uid));
      if (!entry) return;
      dragNode = entry.node;
      state.dragUid = entry.node.uid;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(entry.node.uid));
      try { e.dataTransfer.setDragImage(comp, 12, 12); } catch { /* 部分环境不支持 */ }
    });
    root?.addEventListener('dragend', () => {
      dragNode = null;
      state.dragUid = null;
      clearDropHighlight();
    });
    root?.addEventListener('dragover', (e) => {
      const target = e.target.closest('[data-drop]');
      if (!target || !dragNode || !canDrop(target, dragNode)) {
        clearDropHighlight();
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      highlightDrop(target);
    });
    root?.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget || !root.contains(e.relatedTarget)) clearDropHighlight();
    });
    root?.addEventListener('drop', handleDrop);
  }

  // ==================== 地图变化联动 ====================
  function onMapUI() {
    const map = Editor.getState().map;
    if (state.editing && !state.editing.isNew) {
      const exists = map && (map.triggers || []).some((t) => t.id === state.editing.id);
      if (!exists) {
        state.editing = null;
        state.cond = [];
        state.eff = [];
        state.free = [];
        state.pick = null;
      }
    }
    renderManager();
    renderEditor();
  }

  bind();
  renderManager();
  renderEditor();
  Editor.onUI(onMapUI);

  return { handleBoardClick, refresh: onMapUI };
})();
