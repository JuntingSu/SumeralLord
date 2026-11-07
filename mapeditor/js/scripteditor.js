/**
 * scripteditor.js — 触发器可视化脚本编辑器
 *
 * 结构：
 *   - 右栏「触发器」标签：新建（id）、列表（id / 编辑 / 删除）
 *   - 左栏「脚本」模式：一次编辑一条 trigger。E 型容器上臂吸附条件、下臂吸附效果。
 *   - 不再区分 action/world：动作类与回合类条件可放进同一条 trigger 自由组合。
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
    center: '中',
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
  const SCREEN_POSITIONS = ['top', 'center', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
  /** 用枚举选项面板选择的类型（any/unchanged/flipped 作为额外选项由参数开关控制） */
  const ENUM_TYPES = new Set([
    'force', 'seat', 'owner', 'team', 'trigger', 'phase', 'terrain',
    'difficulty', 'bool', 'position', 'seatList', 'compare', 'valueMode',
    'varValueMode', 'operator',
  ]);
  /** 可从棋盘/列表拾取的参数 */
  const PICK_TYPES = new Set(['force', 'trigger', 'terrain']);

  /**
   * 参数声明（v2：不存在“空缺”参数，有默认值的在新建组件时预填）：
   *   def       新建组件时预填的值
   *   any       允许 any（无约束）
   *   unchanged 允许 unchanged（不修改）
   *   auto      允许 auto（引擎按上下文计算）
   *   flipped   允许 flipped（相对当前取反）
   *   patch     属于「修改」类效果的 patch 组
   *   maxLen    文本长度上限
   *   values    枚举类型的值域子集
   */
  const P = (key, type, label, opts = {}) => ({
    key,
    type,
    label,
    def: opts.def,
    any: !!opts.any,
    unchanged: !!opts.unchanged,
    auto: !!opts.auto,
    flipped: !!opts.flipped,
    patch: !!opts.patch,
    spawn: !!opts.spawn,
    min: opts.min,
    max: opts.max,
    maxLen: opts.maxLen,
    values: opts.values,
    placeholder: opts.placeholder,
  });

  const CATALOG = {
    condition: [
      { op: 'and', group: true, label: '全部满足' },
      { op: 'or', group: true, label: '任一满足' },
      { op: 'not', group: true, single: true, label: '不满足' },
      {
        op: 'tile_owner_changed', label: '地块归属变化',
        text: '地块 {tile} 归属由 {from} 变为 {to}',
        params: [
          P('tile', 'tile', '地块', { any: true }),
          P('from', 'owner', '原归属', { def: 'any' }),
          P('to', 'owner', '新归属'),
        ],
      },
      {
        op: 'force_gone', label: '势力消失',
        text: '势力 {force} 消失',
        params: [P('force', 'force', '势力', { any: true, def: 'any' })],
      },
      {
        op: 'state_assert', label: '断言',
        text: '断言 {path} {cmp} {value_mode} {value} {value_ref}',
        params: [
          P('path', 'statePath', '变量'),
          P('cmp', 'compare', '比较', { def: '=' }),
          P('value_mode', 'valueMode', '预期值来源', { def: 'literal' }),
          P('value', 'stateValue', '预期值'),
          P('value_ref', 'statePath', '预期值变量'),
        ],
      },
      {
        op: 'phase_start', label: '阶段开始',
        text: '势力 {force} 的 {phase} 阶段开始，回合 {turn}',
        params: [
          P('force', 'force', '势力', { any: true, def: 'any' }),
          P('phase', 'phase', '阶段', { any: true, def: 'any' }),
          P('turn', 'int', '回合', { any: true, def: 'any', min: 1 }),
        ],
      },
      {
        op: 'phase_end', label: '阶段结束',
        text: '势力 {force} 的 {phase} 阶段结束，回合 {turn}',
        params: [
          P('force', 'force', '势力', { any: true, def: 'any' }),
          P('phase', 'phase', '阶段', { any: true, def: 'any' }),
          P('turn', 'int', '回合', { any: true, def: 'any', min: 1 }),
        ],
      },
      {
        op: 'turn_start', label: '回合开始',
        text: '第 {turn} 回合开始',
        params: [P('turn', 'int', '回合', { any: true, def: 'any', min: 1 })],
      },
      {
        op: 'trigger_fired', label: '触发器连锁',
        text: '连锁自触发器 {trigger_id}',
        params: [P('trigger_id', 'trigger', '触发器', { any: true, def: 'any' })],
      },
    ],
    effect: [
      {
        op: 'spawn_soldier', label: '生成兵',
        text: '在地块 {tile} 为 {force} 生成 {strength} 兵（移动 {movement}）',
        params: [
          P('tile', 'tile', '地块'),
          P('force', 'force', '势力', { spawn: true }),
          P('strength', 'int', '兵力', { min: 1 }),
          P('movement', 'bool', '移动', { def: 'false' }),
        ],
      },
      {
        op: 'update_soldier', label: '修改兵',
        text: '修改地块 {tile} 的兵（兵力 {strength} / 归属 {owner} / 移动 {movement}）',
        params: [
          P('tile', 'tile', '地块'),
          P('strength', 'int', '兵力', { patch: true, unchanged: true, def: 'unchanged', min: 0 }),
          P('owner', 'seat', '归属', { patch: true, unchanged: true, def: 'unchanged' }),
          P('movement', 'bool', '移动', { patch: true, unchanged: true, def: 'unchanged' }),
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
        text: '修改势力 {force}（名称 {name} / 旗帜 {flag} / 队伍 {team} / 加点 {points} / 难度 {computer}）',
        params: [
          P('force', 'force', '势力'),
          P('name', 'text', '名称', { patch: true, unchanged: true, def: 'unchanged', maxLen: 64 }),
          P('flag', 'flag', '旗帜', { patch: true, unchanged: true, def: 'unchanged' }),
          P('team', 'team', '队伍', { patch: true, unchanged: true, def: 'unchanged' }),
          P('points', 'int', '加点', { patch: true, unchanged: true, def: 'unchanged', min: 0 }),
          P('computer', 'difficulty', '难度', { patch: true, unchanged: true, def: 'unchanged' }),
        ],
      },
      {
        op: 'clear_force', label: '清除势力',
        text: '清除势力 {force}',
        params: [P('force', 'force', '势力')],
      },
      {
        op: 'transfer_control', label: '转移控制权',
        text: '把玩家势力控制权交给新建 AI，AI 难度 {ai_level}',
        params: [P('ai_level', 'difficulty', 'AI 难度', { values: [1, 2, 255] })],
      },
      {
        op: 'set_turn_order', label: '设置行动顺序',
        text: '设置行动顺序为 {order}',
        params: [P('order', 'orderEditor', '座次顺序')],
      },
      {
        op: 'set_fog', label: '设置迷雾',
        text: '设置迷雾：开启 {enabled} / 显示 {reveal} / 隐藏 {hide}',
        params: [
          P('enabled', 'bool', '开启', { flipped: true, unchanged: true, def: 'unchanged' }),
          P('reveal', 'tileList', '显示地块', { def: '' }),
          P('hide', 'tileList', '隐藏地块', { def: '' }),
        ],
      },
      {
        op: 'show_text', label: '显示文本',
        text: '文本ID：{text_id}，内容：{text}（位置 {placement}）',
        params: [
          P('text_id', 'textId', '文本ID', { maxLen: 64, placeholder: '指定文本 id 或点触发器拾取' }),
          P('text', 'textEditor', '内容', { maxLen: 4000 }),
          P('placement', 'placement', '位置', { def: 'screen:top-right' }),
        ],
      },
      {
        op: 'show_choice_text', label: '显示选项文本',
        text: '文本ID：{text_id}，内容：{text}（位置 {placement}）',
        params: [
          P('text_id', 'textId', '文本ID', { maxLen: 64, placeholder: '指定文本 id 或点触发器拾取' }),
          P('text', 'textEditor', '内容', { maxLen: 4000 }),
          P('placement', 'placement', '位置', { def: 'screen:top-right' }),
        ],
      },
      {
        op: 'hide_text', label: '隐藏文本',
        text: '隐藏 {text_id}',
        params: [P('text_id', 'textId', '文本ID', { maxLen: 64, placeholder: '指定文本 id 或点触发器拾取' })],
      },
      {
        op: 'declare', label: '设置数字变量',
        text: '设置数字变量 ID {var_id} 值 {init} {init_mode} {init_ref}',
        params: [
          P('var_id', 'text', 'ID', { maxLen: 64, placeholder: '变量 id' }),
          P('init', 'int', '值'),
          P('init_mode', 'varValueMode', '输入方式', { def: 'literal' }),
          P('init_ref', 'statePath', '变量'),
        ],
      },
      {
        op: 'change', label: '修改数字变量',
        text: '修改数字变量 ID {var_id} {operator} {param} {param_mode} {param_ref}',
        params: [
          P('var_id', 'varId', 'ID', { maxLen: 64, placeholder: '变量 id 或点触发器拾取' }),
          P('operator', 'operator', '运算符', { def: '+' }),
          P('param', 'int', '值'),
          P('param_mode', 'varValueMode', '输入方式', { def: 'literal' }),
          P('param_ref', 'statePath', '变量'),
        ],
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
        params: [P('winning_team', 'team', '获胜队伍')],
      },
    ],
  };

  const state = {
    /** 当前编辑 { id, isNew, src? } */
    editing: null,
    /** 组件类别选择（默认条件） */
    kind: 'condition',
    cond: [],
    eff: [],
    free: [],
    pick: null,
    pickZones: [],
    pop: null,
    dragUid: null,
    /** 触发器文件夹（仅编辑器管理用，不写入地图 JSON） */
    folders: [],
    /** folderId → trigger id 列表（文件夹内顺序） */
    folderTriggers: {},
    folderMapId: null,
    dragTriggerId: null,
  };

  // 目录项补上类别，供 DSL 回填 / 校验区分条件与效果
  for (const kind of ['condition', 'effect']) {
    for (const def of CATALOG[kind]) def.kind = kind;
  }

  let uidSeq = 1;
  const nextUid = () => uidSeq++;

  /** 组件编号（cid）：同一触发器内唯一，供条件/效果参数引用 */
  let cidSeq = 1;
  let usedCids = new Set();
  function resetCidSeq() {
    cidSeq = 1;
    usedCids = new Set();
  }
  function registerCid(cid) {
    if (typeof cid === 'string' && cid) usedCids.add(cid);
  }
  function nextCid() {
    let cid = '';
    do {
      cid = `c${cidSeq}`;
      cidSeq++;
    } while (usedCids.has(cid));
    usedCids.add(cid);
    return cid;
  }
  function collectRawCids(raw) {
    if (!raw || typeof raw !== 'object') return;
    registerCid(raw.cid);
    if (raw.op === 'and' || raw.op === 'or') {
      (raw.items || []).forEach(collectRawCids);
    } else if (raw.op === 'not') {
      collectRawCids(raw.item);
    }
  }

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
    return `正在编辑「${state.editing.id}」：拖动 ⠿/标题调整或嵌套，右键删除组件。`;
  }
  function setHint(message, isError = false) {
    const hint = $('trg-hint');
    if (!hint) return;
    hint.textContent = message;
    hint.classList.toggle('err', isError);
  }

  // ==================== 模型 ====================
  /** 新建节点：所有参数按声明预填默认值（没有默认值的保持空，提交时拦截） */
  function newNode(op, kind) {
    const def = defOf(kind, op);
    const node = { uid: nextUid(), cid: nextCid(), kind, op, params: {}, children: [] };
    if (def) {
      for (const p of def.params || []) node.params[p.key] = p.def ?? '';
    }
    if (
      (op === 'show_text' || op === 'show_choice_text') &&
      !node.params.text_id
    ) {
      node.params.text_id = nextTextId();
    }
    // 记录进入编辑时的文本 id；提交时用于识别改名并同步引用
    if (op === 'show_text' || op === 'show_choice_text') {
      node.textIdOrigin = String(node.params.text_id ?? '');
    }
    if (op === 'show_choice_text') node.choiceOptions = [''];
    if (op === 'set_turn_order' && !node.params.order) {
      const map = Editor.getState().map;
      const seats = (map?.player_list || []).map((p) => p.seat).sort((a, b) => a - b);
      node.params.order = seats.join(', ');
    }
    return node;
  }

  /** 编号：小于 100 补两位，否则三位 */
  function padSeq(n) {
    return n >= 100 ? String(n) : String(n).padStart(2, '0');
  }

  function nextTriggerId() {
    const map = Editor.getState().map;
    const used = new Set((map?.triggers || []).map((t) => t.id));
    if (state.editing?.isNew) used.add(state.editing.id);
    let n = (map?.triggers?.length ?? 0) + 1;
    let id = '';
    do {
      id = `trigger_${padSeq(n)}`;
      n++;
    } while (used.has(id));
    return id;
  }

  function collectTextIds() {
    const out = new Set();
    const map = Editor.getState().map;
    for (const t of map?.triggers || []) {
      for (const e of t.effects || []) {
        if (
          e &&
          (e.op === 'show_text' || e.op === 'show_choice_text' || e.op === 'hide_text') &&
          e.text_id
        ) {
          out.add(String(e.text_id));
        }
      }
    }
    const walk = (list) => {
      for (const n of list) {
        if (
          (n.op === 'show_text' || n.op === 'show_choice_text' || n.op === 'hide_text') &&
          n.params?.text_id
        ) {
          out.add(String(n.params.text_id));
        }
        if (n.children) walk(n.children);
      }
    };
    walk(state.cond);
    walk(state.eff);
    walk(state.free);
    return out;
  }

  /** 已声明的数字变量 id（declare 效果） */
  function collectVarIds() {
    const out = new Set();
    const map = Editor.getState().map;
    const editingId = state.editing?.id;
    for (const t of map?.triggers || []) {
      if (editingId && t.id === editingId) continue; // 当前编辑中的触发器以编辑区为准
      for (const e of t.effects || []) {
        if (e && e.op === 'declare' && e.var_id) out.add(String(e.var_id));
      }
    }
    const walk = (list) => {
      for (const n of list) {
        if (n.op === 'declare' && n.params?.var_id) out.add(String(n.params.var_id));
        if (n.children) walk(n.children);
      }
    };
    walk(state.cond);
    walk(state.eff);
    walk(state.free);
    return out;
  }

  function nextTextId() {
    const used = collectTextIds();
    let n = 1;
    let id = '';
    do {
      id = `text_${padSeq(n)}`;
      n++;
    } while (used.has(id));
    return id;
  }

  /** 查找某个 text_id 已有的显示文本定义（排除当前组件自身） */
  function findTextDefinition(textId, excludeNode) {
    const id = String(textId ?? '').trim();
    if (!id) return null;
    // 组件原本就使用这个 id：它本身就是一个定义，保持内容可编辑
    if (excludeNode && String(excludeNode.textIdOrigin ?? '').trim() === id) return null;
    const map = Editor.getState().map;
    const editingId = state.editing?.id;
    // 其他触发器里已提交的文本定义
    for (const t of map?.triggers || []) {
      if (editingId && t.id === editingId) continue; // 当前编辑中的触发器以编辑区为准
      for (const e of t.effects || []) {
        if (e && e.op === 'show_text' && String(e.text_id ?? '').trim() === id) {
          return {
            text: String(e.text ?? ''),
            placement: encodePlacement(e.placement),
          };
        }
      }
    }
    // 编辑区里其他同 id 的组件
    const candidates = state.eff.filter(
      (n) => n !== excludeNode && n.op === 'show_text' && String(n.params?.text_id ?? '').trim() === id,
    );
    const canonical =
      candidates.find((n) => String(n.textIdOrigin ?? '').trim() === id) || candidates[0];
    if (!canonical) return null;
    return {
      text: String(canonical.params?.text ?? ''),
      placement: String(canonical.params?.placement ?? ''),
    };
  }

  /** 查找某个 text_id 已有的选项文本定义（排除当前组件自身） */
  function findChoiceTextDefinition(textId, excludeNode) {
    const id = String(textId ?? '').trim();
    if (!id) return null;
    // 选项文本组件原本就是该 id 的定义：保留自身内容/选项编辑
    if (
      excludeNode &&
      excludeNode.op === 'show_choice_text' &&
      String(excludeNode.textIdOrigin ?? '').trim() === id
    ) {
      return null;
    }
    // 编辑区里的定义优先（未提交的最新内容）
    const candidates = state.eff.filter(
      (n) => n !== excludeNode && n.op === 'show_choice_text' && String(n.params?.text_id ?? '').trim() === id,
    );
    const canonical =
      candidates.find((n) => String(n.textIdOrigin ?? '').trim() === id) || candidates[0];
    if (canonical) {
      return {
        text: String(canonical.params?.text ?? ''),
        options: (canonical.choiceOptions || []).map((o) => String(o)),
        placement: String(canonical.params?.placement ?? ''),
      };
    }
    const map = Editor.getState().map;
    const editingId = state.editing?.id;
    for (const t of map?.triggers || []) {
      if (editingId && t.id === editingId) continue;
      for (const e of t.effects || []) {
        if (e && e.op === 'show_choice_text' && String(e.text_id ?? '').trim() === id) {
          return {
            text: String(e.text ?? ''),
            options: Array.isArray(e.options) ? e.options.map((o) => String(o)) : [],
            placement: encodePlacement(e.placement),
          };
        }
      }
    }
    return null;
  }

  /** 位置参数编码：screen:top-right / tile:12 */
  function encodePlacement(placement) {
    if (!placement) return '';
    if (placement.kind === 'tile') return `tile:${placement.tile}`;
    return `screen:${placement.position || 'top-right'}`;
  }

  /** DSL → 编辑节点 */
  function dslToNode(obj) {
    const def = defOfOp(obj.op);
    if (!def) return newNode('and', 'condition');
    if (def.group) {
      const node = {
        uid: nextUid(),
        cid: obj.cid || nextCid(),
        kind: 'condition',
        op: obj.op,
        params: {},
        children: [],
      };
      if (obj.op === 'not') {
        if (obj.item) node.children = [dslToNode(obj.item)];
      } else {
        node.children = (obj.items || []).map(dslToNode);
      }
      return node;
    }
    const node = newNode(obj.op, def.kind);
    if (obj.cid) {
      node.cid = obj.cid;
      registerCid(obj.cid);
    }
    for (const p of def.params) {
      let v;
      if (p.patch) v = obj.patch ? obj.patch[p.key] : undefined;
      else if (p.type === 'placement') v = encodePlacement(obj.placement);
      else if (obj.op === 'state_assert' && p.key === 'value' && obj.value === null) v = 'null';
      else if (obj.op === 'state_assert' && p.key === 'cmp') v = obj.cmp ?? '=';
      else if (obj.op === 'state_assert' && p.key === 'value_mode') v = obj.value_ref ? 'gamestate' : 'literal';
      else if (obj.op === 'declare' && p.key === 'init_mode') v = obj.init_ref !== undefined ? 'gamestate' : 'literal';
      else if (obj.op === 'change' && p.key === 'param_mode') v = obj.param_ref !== undefined ? 'gamestate' : 'literal';
      else v = obj[p.key];
      if (Array.isArray(v)) v = v.join(', ');
      // 数据缺项时回落默认值，保证编辑态不出现“空缺”
      node.params[p.key] = v === undefined || v === null || v === ''
        ? (p.type === 'placement' ? (p.def ?? '') : (p.def ?? ''))
        : String(v);
    }
    if (obj.op === 'show_text' || obj.op === 'show_choice_text') {
      node.textIdOrigin = String(node.params.text_id ?? '');
    }
    if (obj.op === 'show_choice_text') {
      node.choiceOptions =
        Array.isArray(obj.options) && obj.options.length ? obj.options.map((o) => String(o)) : [''];
    }
    // 断言路径模板的筛选参数：任意 / 条件列表引用 / 前态值（args）
    if (obj.op === 'state_assert' && obj.args && typeof obj.args === 'object') {
      const templateDef = StatePaths.DEFS.find(
        (d) => d.template === obj.path && d.params.length > 0,
      );
      node.filterArgs = {};
      for (const p of templateDef?.params || []) {
        const arg = obj.args[p];
        if (!arg) continue;
        if (typeof arg === 'object' && arg.any === true) {
          node.filterArgs[p] = { mode: 'any' };
        } else if (typeof arg === 'object' && typeof arg.ref === 'string') {
          node.filterArgs[p] = { mode: 'condition', cid: arg.ref };
        } else if (typeof arg === 'object' && typeof arg.gamestate === 'string') {
          node.filterArgs[p] = {
            mode: 'state',
            path: arg.gamestate,
            at: arg.at === 'before' ? 'before' : 'current',
          };
        } else {
          node.filterArgs[p] = { mode: 'literal', value: String(arg) };
        }
      }
    }
    // 参数引用：条件列表引用 / gamestate 当前值或前态值
    if (obj.refs && typeof obj.refs === 'object') {
      node.refs = {};
      for (const [key, ref] of Object.entries(obj.refs)) {
        if (!ref || typeof ref !== 'object') continue;
        if (obj.op === 'state_assert') {
          const tdef = StatePaths.DEFS.find(
            (d) => d.template === obj.path && d.params.length > 0,
          );
          if (tdef && tdef.params.includes(key)) {
            node.filterArgs = node.filterArgs || {};
            if (typeof ref.gamestate === 'string') {
              node.filterArgs[key] = {
                mode: 'state',
                path: ref.gamestate,
                at: ref.at === 'before' ? 'before' : 'current',
              };
            }
            continue;
          }
        }
        if (typeof ref.ref === 'string') {
          node.refs[key] = { mode: 'condition', cid: ref.ref };
        } else if (typeof ref.gamestate === 'string') {
          node.refs[key] = {
            mode: ref.at === 'before' ? 'before' : 'state',
            path: ref.gamestate,
          };
        }
      }
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
      teams: new Set(map.player_list.map((p) => p.team)),
      seatCount: map.player_list.length,
      ids,
      texts: collectTextIds(),
      vars: collectVarIds(),
    };
  }

  function convertParam(param, raw, ctx) {
    const v = raw.trim();
    const sentinel = () => {
      if (v === 'any' && param.any) return 'any';
      if (v === 'unchanged' && param.unchanged) return 'unchanged';
      if (v === 'auto' && param.auto) return 'auto';
      if (v === 'flipped' && param.flipped) return 'flipped';
      return undefined;
    };
    const intValue = () => {
      const n = Number(v);
      if (!Number.isInteger(n)) throw new Error(`「${param.label}」需为整数`);
      if (param.min !== undefined && n < param.min) throw new Error(`「${param.label}」不能小于 ${param.min}`);
      if (param.max !== undefined && n > param.max) throw new Error(`「${param.label}」不能大于 ${param.max}`);
      return n;
    };
    const s = sentinel();
    if (s !== undefined) return s;
    switch (param.type) {
      case 'tile': {
        const n = intValue();
        if (n < 0 || n >= ctx.total) throw new Error(`「${param.label}」需为 0..${ctx.total - 1} 的地块序号`);
        return n;
      }
      case 'int':
        return intValue();
      case 'flag':
        return intValue();
      case 'text': {
        if (param.maxLen !== undefined && v.length > param.maxLen) {
          throw new Error(`「${param.label}」不能超过 ${param.maxLen} 个字符`);
        }
        return v;
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
      case 'owner': {
        if (v === 'player' || v === 'any' || v === 'null') return v;
        const n = Number(v);
        if (!Number.isInteger(n) || !ctx.seats.has(n)) {
          throw new Error(`「${param.label}」需为现有势力座次、any（任意）或 null（无主/中立）`);
        }
        return n;
      }
      case 'team': {
        const n = Number(v);
        if (!Number.isInteger(n) || !ctx.teams.has(n)) throw new Error(`「${param.label}」需为地图中已有的队伍编号`);
        return n;
      }
      case 'difficulty': {
        const n = Number(v);
        const allowed = param.values || AI_LEVELS;
        if (!allowed.includes(n)) throw new Error(`「${param.label}」需为 ${allowed.join('/')}`);
        return n;
      }
      case 'trigger': {
        if (v === 'any') return 'any';
        if (!ctx.ids.has(v)) throw new Error(`触发器「${v}」不存在`);
        return v;
      }
      case 'bool': {
        if (v === 'true' || v === '1') return true;
        if (v === 'false' || v === '0') return false;
        throw new Error(`「${param.label}」需为 true/false`);
      }
      case 'phase':
        if (v === 'any') return 'any';
        if (!PHASES.includes(v)) throw new Error(`「${param.label}」需为 ${PHASES.join('/')} 或 any`);
        return v;
      case 'terrain': {
        const n = /^[0-9]+$/.test(v) ? Number(v) : TERRAIN_ALIASES[v];
        if (!TERRAINS.includes(n)) throw new Error(`「${param.label}」需为 0/1/3/4/5 或 虚空/平原/海洋/山地/据点`);
        return n;
      }
      case 'compare':
        if (!['=', '!=', '>', '<', '>=', '<=', 'changed'].includes(v)) throw new Error('「比较」需为 = / != / > / < / >= / <= / changed');
        return v;
      case 'position':
        if (!SCREEN_POSITIONS.includes(v)) throw new Error(`「${param.label}」需为 ${SCREEN_POSITIONS.join('/')}`);
        return v;
      case 'placement': {
        const [kind, rest] = v.split(':');
        if (kind === 'tile') {
          const n = Number(rest);
          if (!Number.isInteger(n) || n < 0 || n >= ctx.total) {
            throw new Error(`「${param.label}」的地块需为 0..${ctx.total - 1} 的序号`);
          }
          return { kind: 'tile', tile: n };
        }
        if (kind === 'screen') {
          const pos = rest || 'top-right';
          if (!SCREEN_POSITIONS.includes(pos)) throw new Error(`「${param.label}」的屏幕方位非法`);
          return { kind: 'screen', position: pos };
        }
        throw new Error(`「${param.label}」需为 screen:<方位> 或 tile:<序号>`);
      }
      case 'tileList': {
        const arr = v.split(/[,，\s]+/).filter(Boolean).map(Number);
        if (arr.some((n) => !Number.isInteger(n) || n < 0 || n >= ctx.total)) {
          throw new Error(`「${param.label}」需为逗号分隔的地块序号`);
        }
        return arr;
      }
      case 'seatList':
      case 'orderEditor': {
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

  // ---------- 参数引用：条件筛选列表 / gamestate 当前值·前态值 ----------
  const PARAM_REF_KIND = {
    tile: 'tile',
    force: 'seat',
    owner: 'seat',
    trigger: 'trigger',
    phase: 'phase',
    int: 'int',
    flag: 'int',
    bool: 'bool',
    terrain: 'terrain',
    difficulty: 'difficulty',
    textId: 'text',
    varId: 'var',
    tileList: 'tileList',
    seatList: 'seatList',
    orderEditor: 'seatList',
  };

  function refKindOf(node, param) {
    if (!param) return null;
    if (param.type === 'text') {
      if (node.op === 'update_force' && param.key === 'name') return 'textValue';
      if (param.key === 'var_id') return 'var';
      return null;
    }
    if (
      param.type === 'statePath' ||
      param.type === 'stateValue' ||
      param.type === 'textEditor' ||
      param.type === 'placement' ||
      param.type === 'position' ||
      param.type === 'compare' ||
      param.type === 'valueMode' ||
      param.type === 'varValueMode' ||
      param.type === 'operator'
    ) {
      return null;
    }
    return PARAM_REF_KIND[param.type] || null;
  }

  function refFilterType(kind) {
    if (kind === 'tile' || kind === 'tileList') return 'tile';
    if (kind === 'seat' || kind === 'owner' || kind === 'seatList') return 'seat';
    if (kind === 'trigger') return 'trigger';
    if (kind === 'text') return 'text';
    if (kind === 'var') return 'var';
    return null;
  }

  function isListRefKind(kind) {
    return kind === 'tileList' || kind === 'seatList';
  }

  /** 状态路径类型能否作为该参数的值（与 shared params.ts 保持一致） */
  function refStateKindOk(stateKind, kind) {
    if (kind === 'int') return ['int', 'terrain', 'difficulty', 'seat', 'owner'].includes(stateKind);
    if (kind === 'tile') return stateKind === 'int';
    if (kind === 'terrain') return stateKind === 'terrain' || stateKind === 'int';
    if (kind === 'difficulty') return stateKind === 'difficulty' || stateKind === 'int';
    if (kind === 'seat' || kind === 'owner') {
      return ['seat', 'owner', 'int'].includes(stateKind);
    }
    if (kind === 'bool') return stateKind === 'bool' || stateKind === 'textVisible';
    if (kind === 'text' || kind === 'textValue') {
      return ['text', 'phase', 'intent'].includes(stateKind);
    }
    if (kind === 'phase') return stateKind === 'phase' || stateKind === 'text';
    if (kind === 'trigger') return stateKind === 'text';
    if (kind === 'var') return stateKind === 'int' || stateKind === 'text';
    return false;
  }

  function pathArgFilterType(key) {
    if (key === 'seat') return 'seat';
    if (key === 'tile') return 'tile';
    if (key === 'trigger') return 'trigger';
    if (key === 'text') return 'text';
    if (key === 'var') return 'var';
    return null;
  }

  function pathArgStateKindOk(stateKind, key) {
    if (key === 'seat') return ['seat', 'owner', 'int'].includes(stateKind);
    if (key === 'tile') return stateKind === 'int';
    return stateKind === 'text';
  }

  function collectEditorConditions() {
    const out = [];
    walk(state.cond, (n) => {
      if (n && n.kind === 'condition') out.push(n);
      return false;
    });
    return out;
  }

  /** 编辑器模型下条件会产生哪种筛选列表（不产生/混合类型返回 null） */
  function editorConditionFilterType(node, seen = new Set()) {
    if (!node) return null;
    if (node.uid && seen.has(node.uid)) return null;
    if (node.uid) seen.add(node.uid);
    if (node.op === 'not') return null;
    if (node.op === 'and' || node.op === 'or') {
      const types = [];
      for (const child of node.children || []) {
        const t = editorConditionFilterType(child, seen);
        if (t) types.push(t);
      }
      if (!types.length) return null;
      return types.every((t) => t === types[0]) ? types[0] : null;
    }
    if (node.op === 'state_assert') {
      for (const [key, arg] of Object.entries(node.filterArgs || {})) {
        if (arg.mode === 'any' || arg.mode === 'condition') return pathArgFilterType(key);
      }
      return null;
    }
    const def = defOfOp(node.op);
    for (const [key, ref] of Object.entries(node.refs || {})) {
      if (ref.mode !== 'condition') continue;
      const param = def?.params?.find((p) => p.key === key);
      const kind = refKindOf(node, param);
      return refFilterType(kind);
    }
    return null;
  }

  function conditionCandidates(type) {
    return collectEditorConditions().filter(
      (n) => n.cid && editorConditionFilterType(n) === type,
    );
  }

  /** 把编辑器里的参数引用校验并转成 DSL refs */
  function buildNodeRefs(node, def, ctx) {
    const out = {};
    let listRefs = 0;
    for (const [key, ref] of Object.entries(node.refs || {})) {
      const param = def.params.find((p) => p.key === key);
      const kind = refKindOf(node, param);
      if (!param || !kind) throw new Error(`参数「${key}」不支持引用`);
      if (ref.mode === 'condition') {
        listRefs += 1;
        if (listRefs > 1) throw new Error('每个组件最多引用一个筛选列表');
        const type = refFilterType(kind);
        if (!type) throw new Error(`参数「${param.label}」不能接收筛选列表`);
        const target = conditionCandidates(type).find((n) => n.cid === ref.cid);
        if (!target) {
          throw new Error(`「${param.label}」引用的条件「${ref.cid}」不存在或筛选类型不匹配`);
        }
        out[key] = { ref: ref.cid };
      } else if (ref.mode === 'state' || ref.mode === 'before') {
        if (isListRefKind(kind)) throw new Error(`「${param.label}」需要筛选列表，不能引用单个值`);
        const path = String(ref.path || '').trim();
        const parsed = StatePaths.parse(path);
        if (!path || !parsed || !StatePaths.validatePath(path, ctx)) {
          throw new Error(`「${param.label}」引用的 gamestate 变量非法`);
        }
        if (!refStateKindOk(parsed.def.kind, kind)) {
          throw new Error(`「${param.label}」与 gamestate 变量类型不匹配`);
        }
        out[key] =
          ref.mode === 'before' ? { gamestate: path, at: 'before' } : { gamestate: path };
      }
    }
    return out;
  }

  function buildLeaf(node, ctx) {
    const def = defOfOp(node.op);
    if (!def || def.group) throw new Error('组件不存在');
    const meta = {};
    if (node.cid) meta.cid = String(node.cid);
    const refs = node.op === 'state_assert' ? {} : buildNodeRefs(node, def, ctx);
    if (Object.keys(refs).length) meta.refs = refs;
    const hasRef = (key) => Object.prototype.hasOwnProperty.call(refs, key);
    if (node.op === 'state_assert') {
      const path = String(node.params.path || '').trim();
      const templateDef =
        StatePaths.DEFS.find((d) => d.template === path && d.params.length > 0) || null;
      const parsed = templateDef ? null : StatePaths.parse(path);
      if (!templateDef && !parsed) throw new Error('请选择「变量」');
      const kind = templateDef ? templateDef.kind : parsed.def.kind;
      const nullable = templateDef ? !!templateDef.nullable : !!parsed.def.nullable;
      let args;
      if (templateDef) {
        args = {};
        let filterCount = 0;
        for (const p of templateDef.params) {
          const flow = node.filterArgs?.[p] || {
            mode: 'literal',
            value: defaultPathArg(p, mapStateCtx()),
          };
          if (flow.mode === 'any') {
            filterCount += 1;
            args[p] = { any: true };
            continue;
          }
          if (flow.mode === 'condition') {
            filterCount += 1;
            const type = pathArgFilterType(p);
            const target = conditionCandidates(type).find((n) => n.cid === flow.cid);
            if (!target) throw new Error(`筛选参数「${p}」引用的条件不存在或类型不匹配`);
            args[p] = { ref: flow.cid };
            continue;
          }
          if (flow.mode === 'state') {
            const statePath = String(flow.path || '').trim();
            const stateParsed = statePath ? StatePaths.parse(statePath) : null;
            if (!stateParsed || !StatePaths.validatePath(statePath, ctx)) {
              throw new Error(`筛选参数「${p}」引用的 gamestate 变量非法`);
            }
            if (!pathArgStateKindOk(stateParsed.def.kind, p)) {
              throw new Error(`筛选参数「${p}」与 gamestate 变量类型不匹配`);
            }
            args[p] = {
              gamestate: statePath,
              at: flow.at === 'before' ? 'before' : 'current',
            };
            continue;
          }
          const v = String(flow.value ?? '').trim();
          if (!v) throw new Error(`请填写「${p}」参数`);
          if (p === 'seat') {
            if (v === 'player') args.seat = 'player';
            else {
              const n = Number(v);
              if (!Number.isInteger(n) || !ctx.seats.has(n)) throw new Error('筛选座次非法');
              args.seat = n;
            }
          } else if (p === 'tile') {
            const n = Number(v);
            if (!Number.isInteger(n) || n < 0 || n >= ctx.total) throw new Error('筛选地块非法');
            args.tile = n;
          } else if (p === 'trigger') {
            if (!ctx.ids.has(v)) throw new Error('筛选触发器非法');
            args.trigger = v;
          } else if (p === 'text') {
            if (!(ctx.texts ?? new Set()).has(v)) throw new Error('筛选文本非法');
            args.text = v;
          } else if (p === 'var') {
            if (!(ctx.vars ?? new Set()).has(v)) throw new Error('筛选数字变量非法');
            args.var = v;
          } else {
            args[p] = v;
          }
        }
        if (filterCount > 1) throw new Error('每个断言最多设置一个筛选参数');
      }
      const base = { op: 'state_assert', ...meta, path, ...(args ? { args } : {}) };
      const cmp = String(node.params.cmp || '=').trim() || '=';
      if (!['=', '!=', '>', '<', '>=', '<=', 'changed'].includes(cmp)) throw new Error('「比较」非法');
      // “改变”比较本步骤前后值，不需要预期值
      if (cmp === 'changed') return { ...base, cmp };
      const mode = String(node.params.value_mode || 'literal');
      if (mode === 'gamestate') {
        const ref = String(node.params.value_ref ?? '').trim();
        if (!ref) throw new Error('请选择「预期值变量」');
        if (
          !StatePaths.validatePath(ref, {
            total: ctx.total,
            seats: ctx.seats,
            ids: ctx.ids,
            texts: ctx.texts ?? new Set(),
          })
        ) {
          throw new Error('「预期值变量」非法');
        }
        if (cmp !== '=' && cmp !== '!=') {
          const parsedRef = StatePaths.parse(ref);
          if (kind !== 'int' || !parsedRef || parsedRef.def.kind !== 'int') {
            throw new Error('只有整数变量支持大小比较');
          }
        }
        return { ...base, cmp, value_ref: ref };
      }
      const raw = String(node.params.value ?? '').trim();
      if (raw === '') throw new Error('请填写「预期值」');
      if (raw === 'player' && (kind === 'seat' || kind === 'owner')) {
        if (cmp !== '=' && cmp !== '!=') throw new Error('只有整数变量支持大小比较');
        return { ...base, cmp, value: 'player' };
      }
      if (raw === 'null') {
        if (!(nullable || kind === 'owner')) throw new Error('「预期值」不能为无');
        if (cmp !== '=' && cmp !== '!=') throw new Error('只有整数变量支持大小比较');
        return { ...base, cmp, value: null };
      }
      if (cmp !== '=' && cmp !== '!=' && kind !== 'int') throw new Error('只有整数变量支持大小比较');
      let value;
      switch (kind) {
        case 'int': {
          const n = Number(raw);
          if (!Number.isInteger(n)) throw new Error('「预期值」需为整数');
          value = n;
          break;
        }
        case 'bool':
          value = raw === 'true';
          break;
        case 'text':
          value = raw;
          break;
        case 'phase':
          if (!PHASES.includes(raw)) throw new Error('「预期值」阶段非法');
          value = raw;
          break;
        case 'terrain': {
          const n = Number(raw);
          if (!TERRAINS.includes(n)) throw new Error('「预期值」地形非法');
          value = n;
          break;
        }
        case 'difficulty': {
          const n = Number(raw);
          if (!AI_LEVELS.includes(n)) throw new Error('「预期值」AI 难度非法');
          value = n;
          break;
        }
        case 'seat': {
          const n = Number(raw);
          if (!Number.isInteger(n) || !ctx.seats.has(n)) throw new Error('「预期值」需为现有势力座次');
          value = n;
          break;
        }
        case 'owner': {
          const n = Number(raw);
          if (!(n === 0 || n === 255 || ctx.seats.has(n))) throw new Error('「预期值」归属非法');
          value = n;
          break;
        }
        case 'intent': {
          if (!StatePaths.INTENTS.includes(raw)) throw new Error('「预期值」意图类型非法');
          value = raw;
          break;
        }
        case 'textVisible':
          value = raw === 'true';
          break;
        default:
          value = raw;
      }
      return { ...base, cmp, value };
    }
    if (node.op === 'declare' || node.op === 'change') {
      const varId = String(node.params.var_id || '').trim();
      if (!hasRef('var_id')) {
        if (!varId) throw new Error('请填写「ID」');
        if (varId.length > 64) throw new Error('变量 id 不能超过 64 个字符');
      }
      const pathCtx = {
        total: ctx.total,
        seats: ctx.seats,
        ids: ctx.ids,
        texts: ctx.texts ?? new Set(),
        vars: ctx.vars ?? new Set(),
      };
      const varOut = hasRef('var_id') ? {} : { var_id: varId };
      const modeKey = node.op === 'declare' ? 'init_mode' : 'param_mode';
      const refKey = node.op === 'declare' ? 'init_ref' : 'param_ref';
      const valueKey = node.op === 'declare' ? 'init' : 'param';
      // 新引用机制优先：refs 已提供值时不再写具体值
      if (hasRef(valueKey)) {
        if (node.op === 'declare') return { op: 'declare', ...meta, ...varOut };
        const operator = String(node.params.operator || '+');
        if (!['+', '-', '*', '/', '='].includes(operator)) throw new Error('「运算符」非法');
        if (!hasRef('var_id') && !pathCtx.vars.has(varId)) {
          throw new Error(`数字变量「${varId}」尚未设置`);
        }
        return { op: 'change', ...meta, ...varOut, operator };
      }
      const mode = String(node.params[modeKey] || 'literal');
      if (mode === 'gamestate') {
        const ref = String(node.params[refKey] || '').trim();
        if (!ref) throw new Error('请选择「变量」');
        if (!StatePaths.validatePath(ref, pathCtx)) throw new Error('「变量」非法');
        if (node.op === 'declare') return { op: 'declare', ...meta, ...varOut, init_ref: ref };
        const operator = String(node.params.operator || '+');
        if (!['+', '-', '*', '/', '='].includes(operator)) throw new Error('「运算符」非法');
        if (!hasRef('var_id') && !pathCtx.vars.has(varId)) throw new Error(`数字变量「${varId}」尚未设置`);
        return { op: 'change', ...meta, ...varOut, operator, param_ref: ref };
      }
      const raw = String(node.params[valueKey] ?? '').trim();
      if (raw === '') throw new Error('请填写「值」');
      const n = Number(raw);
      if (!Number.isInteger(n)) throw new Error('「值」需为整数');
      if (node.op === 'declare') return { op: 'declare', ...meta, ...varOut, init: n };
      const operator = String(node.params.operator || '+');
      if (!['+', '-', '*', '/', '='].includes(operator)) throw new Error('「运算符」非法');
      if (!hasRef('var_id') && !pathCtx.vars.has(varId)) throw new Error(`数字变量「${varId}」尚未设置`);
      return { op: 'change', ...meta, ...varOut, operator, param: n };
    }
    if (node.op === 'show_text' || node.op === 'show_choice_text') {
      const textId = String(node.params.text_id || '').trim();
      if (!hasRef('text_id') && !textId) throw new Error('请填写「文本ID」');
      const pPlacement = def.params.find((p) => p.key === 'placement');
      const hasNodeRefs = Object.keys(refs).length > 0;
      // 引用已有选项文本：两种显示文本都统一按“再次显示选项文本”处理
      const choiceRef = hasNodeRefs ? null : findChoiceTextDefinition(textId, node);
      if (choiceRef) {
        if (
          !choiceRef.options.length ||
          choiceRef.options.some((o) => !String(o).trim())
        ) {
          throw new Error('被引用的选项文本还没有有效选项');
        }
        const placementRaw =
          choiceRef.placement || String(node.params.placement || '') || 'screen:top-right';
        return {
          op: 'show_choice_text',
          ...meta,
          text_id: textId,
          text: choiceRef.text,
          placement: convertParam(pPlacement, placementRaw, ctx),
          options: choiceRef.options,
        };
      }
      // 普通显示文本引用已有普通文本
      if (node.op === 'show_text' && !hasNodeRefs) {
        const textRef = findTextDefinition(textId, node);
        if (textRef) {
          const placementRaw =
            textRef.placement || String(node.params.placement || '') || 'screen:top-right';
          return {
            op: 'show_text',
            ...meta,
            text_id: textId,
            text: textRef.text,
            placement: convertParam(pPlacement, placementRaw, ctx),
          };
        }
      }
    }
    const out = { op: node.op, ...meta };
    const patch = {};
    let patchCount = 0;
    for (const p of def.params) {
      const raw = String(node.params[p.key] ?? '').trim();
      // 该参数由引用提供：不写具体值；patch 项保留 unchanged 占位
      if (hasRef(p.key)) {
        if (p.patch) patch[p.key] = 'unchanged';
        continue;
      }
      // 列表参数允许空（空数组 = 不包含任何项）
      if (p.type === 'tileList') {
        out[p.key] = convertParam(p, raw, ctx);
        continue;
      }
      if (raw === '') throw new Error(`请填写「${p.label}」`);
      const val = convertParam(p, raw, ctx);
      if (p.patch) {
        patch[p.key] = val;
        if (raw !== 'unchanged') patchCount++;
      } else {
        out[p.key] = val;
      }
    }
    if (def.params.some((p) => p.patch)) {
      const refPatch = def.params.some((p) => p.patch && hasRef(p.key));
      if (patchCount === 0 && !refPatch) throw new Error('「修改」类效果至少填写一个修改项');
      out.patch = patch;
    }
    if (node.op === 'show_choice_text') {
      const options = (node.choiceOptions || []).map((o) => String(o).trim());
      if (!options.length) throw new Error('请至少添加一个选项');
      if (options.some((o) => o === '')) throw new Error('选项内容不能为空');
      if (options.some((o) => o.length > 4000)) throw new Error('单个选项不能超过 4000 个字符');
      out.options = options;
    }
    return out;
  }

  function buildCondition(node, ctx) {
    if (node.kind !== 'condition') throw new Error('条件区只能放条件组件');
    const def = defOfOp(node.op);
    if (!def) throw new Error('未知条件组件');
    const meta = node.cid ? { cid: String(node.cid) } : {};
    if (def.group) {
      if (node.op === 'not') {
        if (node.children.length !== 1) throw new Error('「不满足」需要且只能包含 1 个条件');
        return { op: 'not', ...meta, item: buildCondition(node.children[0], ctx) };
      }
      if (!node.children.length) throw new Error(`「${def.label}」至少需要 1 个条件`);
      return { op: node.op, ...meta, items: node.children.map((c) => buildCondition(c, ctx)) };
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
    const ed = state.editing;
    const base = ed.src ? JSON.parse(JSON.stringify(ed.src)) : {};
    delete base.class; // 旧地图的 class 字段在重新提交时去掉
    const trigger = { ...base, id: ed.id, when, effects };

    const priority = Number(ed.priority);
    trigger.priority = Number.isInteger(priority) ? priority : 0;

    if (ed.delay) {
      const amount = Number(ed.delay.amount);
      if (!Number.isInteger(amount) || amount <= 0) throw new Error('延迟数量需为正整数');
      if (ed.delay.unit !== 'intent' && ed.delay.unit !== 'turn' && ed.delay.unit !== 'round') {
        throw new Error('延迟单位非法');
      }
      trigger.delay = { amount, unit: ed.delay.unit };
    } else {
      delete trigger.delay;
    }

    // 「可重复使用」= 可跨事务再次触发，但同一事务内仍最多触发一次
    trigger.once = ed.onceMode === 'once';
    trigger.repeatable = false;
    return trigger;
  }

  // ==================== 文本 id 改名：提交时同步引用 ====================

  /** 收集本次提交里 show_text 文本 id 的变化（进入编辑时的 id → 当前 id） */
  function collectTextIdRenames() {
    const renames = new Map();
    for (const n of state.eff) {
      if (n.op !== 'show_text' && n.op !== 'show_choice_text') continue;
      const from = String(n.textIdOrigin ?? '').trim();
      const to = String(n.params?.text_id ?? '').trim();
      if (!from || !to || from === to) continue;
      // 普通文本改到已有 id 视为引用；选项文本总是按改名同步旧引用
      if (n.op === 'show_text' && findTextDefinition(to, n)) continue;
      renames.set(from, to);
    }
    return renames;
  }

  function renameTextToken(text, renames) {
    return String(text).replace(/\{gamestate\.texts\.([^{}]+)\.(visible|option)\}/g, (token, id, field) =>
      renames.has(id) ? `{gamestate.texts.${renames.get(id)}.${field}}` : token,
    );
  }

  function applyTextIdRenamesToCondition(cond, renames) {
    if (!renames.size || !cond || typeof cond !== 'object') return;
    if ((cond.op === 'and' || cond.op === 'or') && Array.isArray(cond.items)) {
      cond.items.forEach((item) => applyTextIdRenamesToCondition(item, renames));
      return;
    }
    if (cond.op === 'not') {
      applyTextIdRenamesToCondition(cond.item, renames);
      return;
    }
    if (cond.op === 'state_assert' && typeof cond.path === 'string') {
      const prefix = 'gamestate.texts.';
      const suffix = cond.path.endsWith('.option') ? '.option' : cond.path.endsWith('.visible') ? '.visible' : '';
      if (suffix) {
        const id = cond.path.slice(prefix.length, -suffix.length);
        if (cond.path.startsWith(prefix) && renames.has(id)) {
          cond.path = `gamestate.texts.${renames.get(id)}${suffix}`;
        }
      }
    }
  }

  function applyTextIdRenamesToEffect(effect, renames) {
    if (!renames.size || !effect) return;
    if (effect.op === 'show_text' || effect.op === 'show_choice_text' || effect.op === 'hide_text') {
      if (typeof effect.text_id === 'string' && renames.has(effect.text_id)) {
        effect.text_id = renames.get(effect.text_id);
      }
    }
    if (effect.op === 'show_text' && typeof effect.text === 'string') {
      effect.text = renameTextToken(effect.text, renames);
    }
    if (effect.op === 'show_choice_text') {
      if (typeof effect.text === 'string') effect.text = renameTextToken(effect.text, renames);
      if (Array.isArray(effect.options)) {
        effect.options = effect.options.map((o) => renameTextToken(o, renames));
      }
    }
  }

  function applyTextIdRenamesToTrigger(trigger, renames) {
    if (!renames.size || !trigger) return;
    applyTextIdRenamesToCondition(trigger.when, renames);
    for (const e of trigger.effects || []) applyTextIdRenamesToEffect(e, renames);
  }

  // ==================== 触发器文件夹（仅编辑器管理用） ====================
  const FOLDER_ICON =
    '<svg class="trg-folder-svg" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M1.8 4.2h4.1l1.4 1.6h7v7.2H1.8z"/></svg>';

  function nextFolderId() {
    let n = state.folders.length + 1;
    const used = new Set(state.folders.map((f) => f.id));
    while (used.has(`folder_${n}`)) n++;
    return `folder_${n}`;
  }

  function uniqueFolderName() {
    const used = new Set(state.folders.map((f) => f.name));
    let n = state.folders.length + 1;
    while (used.has(`文件夹 ${n}`)) n++;
    return `文件夹 ${n}`;
  }

  function createFolder(parentId = null, name = null) {
    const parent = parentId ? state.folders.find((f) => f.id === parentId) : null;
    const effectiveParent = parent ? parent.id : null;
    const folder = {
      id: nextFolderId(),
      name: name || uniqueFolderName(),
      collapsed: false,
      parentId: effectiveParent,
    };
    state.folders.push(folder);
    state.folderTriggers[folder.id] = [];
    if (effectiveParent) expandFolderAncestors(effectiveParent);
    return folder;
  }

  function expandFolderAncestors(folderId) {
    let id = folderId;
    const seen = new Set();
    while (id && !seen.has(id)) {
      seen.add(id);
      const folder = state.folders.find((f) => f.id === id);
      if (!folder) break;
      folder.collapsed = false;
      id = folder.parentId;
    }
  }

  function rootFolderList() {
    return state.folders.filter((f) => !f.parentId);
  }

  function folderPath(folder) {
    const names = [];
    const seen = new Set();
    let current = folder;
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      names.unshift(current.name);
      current = current.parentId
        ? state.folders.find((f) => f.id === current.parentId)
        : null;
    }
    return names.join(' / ');
  }

  /** 从 editor_meta.trigger_tree 还原扁平文件夹模型 */
  function parseFolderMeta(raw, validTriggers) {
    const folders = [];
    const folderTriggers = {};
    const usedIds = new Set();
    const seenTriggers = new Set();
    let seq = 1;
    const freshId = () => {
      let id;
      do {
        id = `folder_${seq++}`;
      } while (usedIds.has(id));
      return id;
    };
    const walk = (nodes, parentId, depth) => {
      if (!Array.isArray(nodes) || depth > 64) return;
      for (const node of nodes) {
        if (!node || typeof node !== 'object' || node.type !== 'folder') continue;
        let id = typeof node.id === 'string' && node.id ? node.id : '';
        if (!id || usedIds.has(id)) id = freshId();
        usedIds.add(id);
        folders.push({
          id,
          name: typeof node.name === 'string' && node.name ? node.name : '文件夹',
          collapsed: node.collapsed === true,
          parentId,
        });
        folderTriggers[id] = [];
        walk(node.children, id, depth + 1);
      }
      for (const node of nodes) {
        if (!node || typeof node !== 'object' || node.type !== 'trigger') continue;
        if (typeof node.id !== 'string' || !node.id) continue;
        if (!validTriggers.has(node.id) || seenTriggers.has(node.id) || parentId === null) continue;
        seenTriggers.add(node.id);
        folderTriggers[parentId].push(node.id);
      }
    };
    walk(raw, null, 0);
    if (!folders.some((f) => !f.parentId)) {
      const id = freshId();
      folders.unshift({ id, name: '文件夹 1', collapsed: false, parentId: null });
      folderTriggers[id] = [];
    }
    return { folders, folderTriggers };
  }

  function loadFolderMeta(map, validTriggers) {
    const meta = map.editor_meta && typeof map.editor_meta === 'object' ? map.editor_meta : null;
    const raw = meta && Array.isArray(meta.trigger_tree) ? meta.trigger_tree : null;
    if (raw) {
      const parsed = parseFolderMeta(raw, validTriggers);
      state.folders = parsed.folders;
      state.folderTriggers = parsed.folderTriggers;
    } else {
      state.folders = [];
      state.folderTriggers = {};
      createFolder(null, '文件夹 1');
    }
  }

  /** 校验父子关系、去重触发器并补齐缺失项 */
  function sanitizeFolders(validTriggers) {
    if (!state.folders.length) createFolder(null, '文件夹 1');
    for (const folder of state.folders) {
      if (!folder.parentId) folder.parentId = null;
    }
    const byId = new Map(state.folders.map((f) => [f.id, f]));
    // 父节点失效 → 提升为一级文件夹
    for (const folder of state.folders) {
      if (folder.parentId && !byId.has(folder.parentId)) folder.parentId = null;
    }
    // 断开环
    for (const folder of state.folders) {
      let parentId = folder.parentId;
      const seen = new Set([folder.id]);
      while (parentId) {
        if (seen.has(parentId)) {
          folder.parentId = null;
          break;
        }
        seen.add(parentId);
        const parent = byId.get(parentId);
        if (!parent) {
          folder.parentId = null;
          break;
        }
        parentId = parent.parentId;
      }
    }
    // 至少保留一个一级文件夹
    if (!state.folders.some((f) => !f.parentId)) {
      const first = state.folders[0];
      if (first) first.parentId = null;
      else createFolder(null, '文件夹 1');
    }
    for (const folder of state.folders) {
      if (!Array.isArray(state.folderTriggers[folder.id])) state.folderTriggers[folder.id] = [];
    }
    // 按树顺序去重、清理无效触发器
    const order = [];
    const walk = (parentId) => {
      for (const folder of state.folders.filter((f) => (f.parentId ?? null) === parentId)) {
        order.push(folder);
        walk(folder.id);
      }
    };
    walk(null);
    const seen = new Set();
    for (const folder of order) {
      const next = [];
      for (const id of state.folderTriggers[folder.id] || []) {
        if (!validTriggers.has(id) || seen.has(id)) continue;
        seen.add(id);
        next.push(id);
      }
      state.folderTriggers[folder.id] = next;
    }
    const root = state.folders.find((f) => !f.parentId);
    for (const id of validTriggers) {
      if (seen.has(id)) continue;
      seen.add(id);
      state.folderTriggers[root.id].push(id);
    }
  }

  function buildEditorTree(parentId = null) {
    return state.folders
      .filter((f) => (f.parentId ?? null) === parentId)
      .map((folder) => ({
        type: 'folder',
        id: folder.id,
        name: folder.name,
        collapsed: !!folder.collapsed,
        children: [
          ...buildEditorTree(folder.id),
          ...(state.folderTriggers[folder.id] || []).map((id) => ({ type: 'trigger', id })),
        ],
      }));
  }

  function syncEditorMetaToMap() {
    const map = Editor.getState().map;
    if (!map) return;
    const base =
      map.editor_meta && typeof map.editor_meta === 'object' ? map.editor_meta : {};
    map.editor_meta = {
      ...base,
      version: 1,
      trigger_tree: buildEditorTree(null),
    };
  }

  /** 保证每个触发器都有文件夹；切换地图时从 editor_meta 还原层级 */
  function ensureFolders(map) {
    const mapId = Editor.getState().id;
    const switched = state.folderMapId !== mapId;
    if (switched) {
      state.folderMapId = mapId;
      // 切换地图时不保留上一张图的编辑草稿/编辑态
      state.editing = null;
      state.cond = [];
      state.eff = [];
      state.free = [];
      state.pick = null;
    }
    const valid = new Set((map.triggers || []).map((t) => t.id));
    if (state.editing?.isNew) valid.add(state.editing.id);
    if (switched) loadFolderMeta(map, valid);
    sanitizeFolders(valid);
    syncEditorMetaToMap();
  }

  function folderOfTrigger(id) {
    for (const folder of state.folders) {
      if ((state.folderTriggers[folder.id] || []).includes(id)) return folder;
    }
    return null;
  }

  function defaultTargetFolder() {
    if (state.editing) {
      const folder = folderOfTrigger(state.editing.id);
      if (folder) return folder.id;
    }
    return state.folders.find((f) => !f.parentId)?.id ?? null;
  }

  function assignTriggerToFolder(triggerId, folderId) {
    for (const folder of state.folders) {
      state.folderTriggers[folder.id] = (state.folderTriggers[folder.id] || []).filter((id) => id !== triggerId);
    }
    const target =
      state.folders.find((f) => f.id === folderId) ||
      state.folders.find((f) => !f.parentId) ||
      state.folders[0];
    if (target) (state.folderTriggers[target.id] ??= []).push(triggerId);
  }

  function removeTriggerFromFolders(triggerId) {
    for (const folder of state.folders) {
      state.folderTriggers[folder.id] = (state.folderTriggers[folder.id] || []).filter((id) => id !== triggerId);
    }
  }

  function renameTriggerInFolders(oldId, newId) {
    for (const folder of state.folders) {
      state.folderTriggers[folder.id] = (state.folderTriggers[folder.id] || []).map((id) =>
        id === oldId ? newId : id,
      );
    }
  }

  /** 按「文件夹顺序 + 文件夹内顺序」重排地图触发器数组 */
  /** 按「子文件夹 → 当前文件夹触发器」深度优先展开 */
  function flattenTriggerIds(parentId = null, out = []) {
    for (const folder of state.folders.filter((f) => (f.parentId ?? null) === parentId)) {
      flattenTriggerIds(folder.id, out);
      for (const id of state.folderTriggers[folder.id] || []) out.push(id);
    }
    return out;
  }

  function orderMapTriggers(m) {
    const order = flattenTriggerIds();
    const byId = new Map((m.triggers || []).map((t) => [t.id, t]));
    const next = [];
    for (const id of order) {
      const trigger = byId.get(id);
      if (!trigger) continue;
      next.push(trigger);
      byId.delete(id);
    }
    for (const trigger of m.triggers || []) {
      if (byId.has(trigger.id)) next.push(trigger);
    }
    m.triggers = next;
  }

  function syncMapTriggerOrder() {
    Editor.commit((m) => orderMapTriggers(m));
  }

  function moveTriggerToFolder(triggerId, folderId) {
    clearTriggerDropIndicators();
    if (!state.folders.some((f) => f.id === folderId)) return;
    for (const folder of state.folders) {
      state.folderTriggers[folder.id] = (state.folderTriggers[folder.id] || []).filter((id) => id !== triggerId);
    }
    (state.folderTriggers[folderId] ??= []).push(triggerId);
    expandFolderAncestors(folderId);
    const inMap = (Editor.getState().map?.triggers || []).some((t) => t.id === triggerId);
    if (inMap) syncMapTriggerOrder();
    renderManager();
  }

  function moveTriggerToTrigger(triggerId, targetFolderId, targetId, before) {
    clearTriggerDropIndicators();
    if (!state.folderTriggers[targetFolderId]) return;
    for (const folder of state.folders) {
      state.folderTriggers[folder.id] = (state.folderTriggers[folder.id] || []).filter((id) => id !== triggerId);
    }
    const list = state.folderTriggers[targetFolderId];
    const index = list.indexOf(targetId);
    const insert = index < 0 ? list.length : index + (before ? 0 : 1);
    list.splice(insert, 0, triggerId);
    const inMap = (Editor.getState().map?.triggers || []).some((t) => t.id === triggerId);
    if (inMap) syncMapTriggerOrder();
    renderManager();
  }

  function deleteFolder(folder) {
    if (state.folders.length <= 1) {
      return toast('至少保留一个触发器文件夹', 'error');
    }
    if (!window.confirm(`删除文件夹「${folder.name}」？其内容会移动到上一级。`)) return;
    const parentId = folder.parentId ?? null;
    // 子文件夹提升到被删文件夹的上一级
    for (const child of state.folders) {
      if (child.parentId === folder.id) child.parentId = parentId;
    }
    const moved = state.folderTriggers[folder.id] || [];
    state.folders = state.folders.filter((f) => f.id !== folder.id);
    delete state.folderTriggers[folder.id];
    // 触发器移到上一级文件夹；一级文件夹被删时移到第一个剩余一级文件夹
    let targetId = parentId;
    if (!targetId) {
      targetId = state.folders.find((f) => !f.parentId)?.id ?? null;
    }
    if (!targetId) {
      const created = createFolder(null, '文件夹 1');
      targetId = created.id;
    }
    for (const id of moved) {
      if (!(state.folderTriggers[targetId] || []).includes(id)) {
        (state.folderTriggers[targetId] ??= []).push(id);
      }
    }
    syncMapTriggerOrder();
    renderManager();
  }

  function startFolderRename(folder, el) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'trg-folder-rename';
    input.value = folder.name;
    el.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save) {
        const name = input.value.trim();
        if (name) folder.name = name;
      }
      renderManager();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    });
    input.addEventListener('blur', () => finish(true));
  }

  function folderRow(folder) {
    const row = document.createElement('div');
    row.className = 'trg-folder';
    row.dataset.folderId = folder.id;
    row.innerHTML = `
      <span class="trg-folder-icon">${FOLDER_ICON}</span>
      <span class="trg-folder-name" title="点击改名">${esc(folder.name)}</span>
      <span class="trg-folder-actions">
        <button type="button" data-act="folder-add" title="新建触发器或子文件夹">＋</button>
        <button type="button" data-act="folder-toggle" title="${folder.collapsed ? '展开' : '折叠'}">${folder.collapsed ? '▸' : '▾'}</button>
      </span>
    `;
    row.querySelector('.trg-folder-name')?.addEventListener('click', (e) => {
      e.stopPropagation();
      startFolderRename(folder, e.currentTarget);
    });
    row.querySelector('[data-act="folder-add"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      const rect = btn.getBoundingClientRect();
      showContextMenu(rect.left, rect.bottom + 4, [
        { label: '新建触发器', action: () => createDraft(folder.id) },
        {
          label: '新建文件夹',
          action: () => {
            createFolder(folder.id);
            renderManager();
          },
        },
      ]);
    });
    row.querySelector('[data-act="folder-toggle"]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      folder.collapsed = !folder.collapsed;
      renderManager();
    });
    row.addEventListener('dragover', (e) => {
      if (!state.dragTriggerId) return;
      e.preventDefault();
      e.stopPropagation();
      row.classList.add('trg-drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('trg-drop-target'));
    row.addEventListener('drop', (e) => {
      if (!state.dragTriggerId) return;
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove('trg-drop-target');
      moveTriggerToFolder(state.dragTriggerId, folder.id);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        { label: '在此新建触发器', action: () => createDraft(folder.id) },
        {
          label: '在此新建子文件夹',
          action: () => {
            createFolder(folder.id);
            renderManager();
          },
        },
        {
          label: folder.collapsed ? '展开文件夹' : '折叠文件夹',
          action: () => {
            folder.collapsed = !folder.collapsed;
            renderManager();
          },
        },
        { separator: true },
        { label: '删除文件夹', action: () => deleteFolder(folder) },
      ]);
    });
    return row;
  }

  // ==================== 渲染：右栏触发器列表 ====================
  function triggerRow(id, badge, priority, isDraft = false) {
    const row = document.createElement('div');
    row.className = 'trg-item';
    row.dataset.triggerId = id;
    row.draggable = true;
    if (state.editing && state.editing.id === id) row.classList.add('editing');
    const p = Number.isInteger(priority) ? priority : 0;
    row.innerHTML = `
      <div class="trg-item-info">
        <span class="trg-item-id" title="${esc(id)}">${esc(id)}</span>
        ${badge ? `<span class="trg-item-badge">${esc(badge)}</span>` : ''}
      </div>
      <div class="trg-item-actions">
        <label class="trg-priority" title="优先级，越大越先执行">优先级<input class="trg-priority-input" type="number" step="1" value="${p}"></label>
        <button type="button" data-act="edit">编辑</button>
        ${isDraft ? '' : '<button type="button" data-act="rename">改名</button>'}
        <button type="button" data-act="del">删除</button>
      </div>
    `;
    row.addEventListener('mousedown', (e) => {
      row.draggable = !e.target.closest('input, button');
    });
    row.addEventListener('mouseup', () => {
      row.draggable = true;
    });
    row.addEventListener('mouseleave', () => {
      row.draggable = true;
    });
    row.addEventListener('dragstart', (e) => {
      state.dragTriggerId = id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      state.dragTriggerId = null;
      row.classList.remove('dragging');
      clearTriggerDropIndicators();
    });
    row.addEventListener('dragover', (e) => {
      if (!state.dragTriggerId || state.dragTriggerId === id) return;
      e.preventDefault();
      e.stopPropagation();
      row.classList.add('trg-drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('trg-drop-target'));
    row.addEventListener('drop', (e) => {
      if (!state.dragTriggerId || state.dragTriggerId === id) return;
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove('trg-drop-target');
      const rect = row.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      const folder = folderOfTrigger(id);
      if (folder) moveTriggerToTrigger(state.dragTriggerId, folder.id, id, before);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showTriggerContextMenu(id, e.clientX, e.clientY);
    });
    return row;
  }

  function clearTriggerDropIndicators() {
    document.querySelectorAll('#trigger-list .trg-drop-target').forEach((el) => {
      el.classList.remove('trg-drop-target');
    });
    state.dragTriggerId = null;
  }

  function showTriggerContextMenu(id, x, y) {
    const current = folderOfTrigger(id);
    const items = [
      { label: '删除触发器', action: () => deleteTrigger(id) },
    ];
    const others = state.folders.filter((f) => f.id !== current?.id);
    if (others.length) {
      items.push({ separator: true }, { heading: true, label: '转移到文件夹' });
      for (const folder of others) {
        items.push({ label: folderPath(folder), action: () => moveTriggerToFolder(id, folder.id) });
      }
    }
    showContextMenu(x, y, items);
  }

  function addFolderDropHandlers(container, folderId) {
    container.addEventListener('dragover', (e) => {
      if (!state.dragTriggerId) return;
      e.preventDefault();
      e.stopPropagation();
      container.classList.add('trg-drop-target');
    });
    container.addEventListener('dragleave', () => container.classList.remove('trg-drop-target'));
    container.addEventListener('drop', (e) => {
      if (!state.dragTriggerId) return;
      e.preventDefault();
      e.stopPropagation();
      container.classList.remove('trg-drop-target');
      moveTriggerToFolder(state.dragTriggerId, folderId);
    });
  }

  function renderFolderBlock(folder, map) {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(folderRow(folder));
    if (folder.collapsed) return fragment;
    const children = document.createElement('div');
    children.className = 'trg-folder-children';
    children.dataset.folderId = folder.id;
    addFolderDropHandlers(children, folder.id);
    for (const child of state.folders.filter((f) => f.parentId === folder.id)) {
      children.appendChild(renderFolderBlock(child, map));
    }
    for (const id of state.folderTriggers[folder.id] || []) {
      if (state.editing?.isNew && state.editing.id === id) {
        children.appendChild(triggerRow(id, '编辑中', state.editing.priority, true));
      } else {
        const trigger = (map.triggers || []).find((t) => t.id === id);
        if (trigger) children.appendChild(triggerRow(trigger.id, '', trigger.priority ?? 0));
      }
    }
    fragment.appendChild(children);
    return fragment;
  }

  function renderManager() {
    const map = Editor.getState().map;
    const list = $('trigger-list');
    if (!list) return;
    syncNewTriggerId();
    list.innerHTML = '';
    if (!map) return;
    ensureFolders(map);
    for (const folder of rootFolderList()) {
      list.appendChild(renderFolderBlock(folder, map));
    }
  }

  // ==================== 触发器改名：同步引用 ====================
  function firedCountsPath(id) {
    return `gamestate.triggerRuntime.firedCounts.${id}`;
  }

  function replaceTriggerTextRefs(text, oldId, newId) {
    const from = `{${firedCountsPath(oldId)}}`;
    const to = `{${firedCountsPath(newId)}}`;
    return String(text).split(from).join(to);
  }

  /** 条件里的 trigger_fired / firedCounts 断言路径 */
  function renameConditionRefs(cond, oldId, newId) {
    if (!cond || typeof cond !== 'object') return;
    if ((cond.op === 'and' || cond.op === 'or') && Array.isArray(cond.items)) {
      cond.items.forEach((item) => renameConditionRefs(item, oldId, newId));
      return;
    }
    if (cond.op === 'not') {
      renameConditionRefs(cond.item, oldId, newId);
      return;
    }
    if (cond.op === 'trigger_fired' && cond.trigger_id === oldId) {
      cond.trigger_id = newId;
    } else if (cond.op === 'state_assert' && cond.path === firedCountsPath(oldId)) {
      cond.path = firedCountsPath(newId);
    }
  }

  /** 效果文本里的 {gamestate.triggerRuntime.firedCounts.<id>} 占位符 */
  function renameEffectRefs(effect, oldId, newId) {
    if (effect && effect.op === 'show_text' && typeof effect.text === 'string') {
      effect.text = replaceTriggerTextRefs(effect.text, oldId, newId);
    }
  }

  /** 编辑区中的节点参数（含游离组件与未提交修改） */
  function renameNodeRefs(node, oldId, newId) {
    if (!node) return;
    if (Array.isArray(node.children)) {
      node.children.forEach((child) => renameNodeRefs(child, oldId, newId));
    }
    const p = node.params;
    if (!p) return;
    if (node.op === 'trigger_fired' && p.trigger_id === oldId) {
      p.trigger_id = newId;
    } else if (node.op === 'state_assert' && p.path === firedCountsPath(oldId)) {
      p.path = firedCountsPath(newId);
    } else if (node.op === 'show_text' && typeof p.text === 'string') {
      p.text = replaceTriggerTextRefs(p.text, oldId, newId);
    }
  }

  function renameTrigger(oldId) {
    const map = Editor.getState().map;
    if (!map) return;
    if (!(map.triggers || []).some((t) => t.id === oldId)) {
      return toast(`触发器「${oldId}」不存在`, 'error');
    }
    const input = window.prompt(`把触发器「${oldId}」改名为：`, oldId);
    if (input === null) return;
    const newId = String(input).trim();
    if (!newId) return toast('触发器 id 不能为空', 'error');
    if (newId.length > 64) return toast('触发器 id 不能超过 64 个字符', 'error');
    if (newId === 'any') return toast('「any」是保留字，不能作为触发器 id', 'error');
    if (newId === oldId) return;
    if ((map.triggers || []).some((t) => t.id === newId)) {
      return toast(`触发器 id「${newId}」已存在`, 'error');
    }
    if (state.editing?.isNew && state.editing.id === newId) {
      return toast(`「${newId}」正被当前新建触发器使用`, 'error');
    }

    // 已打开编辑区里的引用先同步，避免提交时把旧 id 写回去
    [...state.cond, ...state.eff, ...state.free].forEach((n) =>
      renameNodeRefs(n, oldId, newId),
    );
    if (state.editing?.id === oldId) {
      state.editing.id = newId;
      if (state.editing.src) state.editing.src.id = newId;
    }

    Editor.commit((m) => {
      const triggers = m.triggers || [];
      const target = triggers.find((t) => t.id === oldId);
      if (target) target.id = newId;
      for (const t of triggers) {
        renameConditionRefs(t.when, oldId, newId);
        for (const e of t.effects || []) renameEffectRefs(e, oldId, newId);
      }
      renameTriggerInFolders(oldId, newId);
    });
    renderManager();
    renderEditor();
    toast(`已把触发器「${oldId}」改名为「${newId}」，并同步更新引用`);
  }

  // ==================== 渲染：脚本编辑区 ====================
  function renderOpOptions() {
    const sel = $('trg-op');
    if (!sel) return;
    const kind = state.kind;
    const defs = CATALOG[kind] || [];
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

  /** 参数框宽度：2..6 字符，随文本自适应 */
  function fitWidth(el, text) {
    if (!el) return;
    const len = String(text ?? '').length;
    const pw = Math.min(6, Math.max(2, len));
    el.style.setProperty('--pw', String(pw));
  }

  /** 重新计算所有参数框宽度（渲染后与任意参数变化后调用） */
  function fitAllParams() {
    document.querySelectorAll('#trg-editor .trg-param').forEach((el) => {
      if (el.tagName === 'SELECT') fitWidth(el, el.selectedOptions[0]?.textContent || el.value);
      else if (el.tagName === 'BUTTON') fitWidth(el, el.querySelector('.trg-val')?.textContent || el.textContent);
      else fitWidth(el, el.value);
    });
    document.querySelectorAll('.trg-sentinel, .trg-placement select').forEach((el) => {
      fitWidth(el, el.selectedOptions?.[0]?.textContent || el.value || '');
    });
    document.querySelectorAll('#te-tree .te-param-row select, #te-tree .te-param-row input, #te-tree .te-pick-btn').forEach((el) => {
      if (el.tagName === 'SELECT') fitWidth(el, el.selectedOptions[0]?.textContent || el.value);
      else fitWidth(el, el.value || el.textContent);
    });
  }

  // ---------- 参数控件 ----------
  function renderParamField(node, param) {
    let control;
    if (param.type === 'placement') control = renderPlacementControl(node, param);
    else if (param.type === 'statePath') control = renderStatePathControl(node, param);
    else if (param.type === 'stateValue') control = renderStateValueControl(node, param);
    else if (param.type === 'textEditor') control = renderTextEditorControl(node, param);
    else if (param.type === 'orderEditor') control = renderOrderEditorControl(node, param);
    else if (ENUM_TYPES.has(param.type)) control = renderEnumControl(node, param);
    else if (param.type === 'int' || param.type === 'flag') control = withSentinels(node, param, renderNumberInput);
    else control = withSentinels(node, param, renderTextInput);
    return withParamRef(node, param, control);
  }

  /**
   * 参数引用开关：值 / 条件筛选列表 / 当前值 / 前态值。
   * 只对可引用的参数显示；引用存在时原输入仍保留但禁用。
   */
  function withParamRef(node, param, control) {
    const kind = refKindOf(node, param);
    if (!kind) return control;
    const listType = refFilterType(kind);
    const wrap = document.createElement('span');
    wrap.className = 'trg-ref-wrap';
    const target = document.createElement('span');
    target.className = 'trg-ref-target';
    target.appendChild(control);
    wrap.appendChild(target);

    const current = node.refs?.[param.key];
    const modeSel = document.createElement('select');
    modeSel.className = 'trg-ref-mode';
    modeSel.title = '参数来源';
    modeSel.innerHTML =
      '<option value="">值</option>' +
      (listType ? '<option value="condition">来自</option>' : '') +
      '<option value="state">当前值</option>' +
      '<option value="before">前态值</option>';
    modeSel.value = current ? current.mode : '';
    modeSel.addEventListener('change', () => {
      if (!modeSel.value) {
        if (node.refs) delete node.refs[param.key];
      } else if (modeSel.value === 'condition') {
        const candidates = conditionCandidates(listType);
        node.refs = node.refs || {};
        node.refs[param.key] = { mode: 'condition', cid: candidates[0]?.cid ?? '' };
      } else {
        node.refs = node.refs || {};
        node.refs[param.key] = { mode: modeSel.value, path: 'gamestate.turn' };
      }
      renderEditor();
    });
    wrap.appendChild(modeSel);

    if (current && current.mode === 'condition') {
      const refSel = document.createElement('select');
      refSel.className = 'trg-ref-cid';
      const candidates = conditionCandidates(listType);
      refSel.innerHTML = candidates
        .map((n) => `<option value="${esc(n.cid)}">${esc(n.cid)} ${esc(defOfOp(n.op)?.label || n.op)}</option>`)
        .join('');
      if (!candidates.length) {
        const none = document.createElement('option');
        none.value = '';
        none.textContent = '没有匹配的筛选条件';
        refSel.appendChild(none);
      }
      refSel.value = current.cid;
      refSel.addEventListener('change', () => {
        current.cid = refSel.value;
      });
      wrap.appendChild(refSel);
    } else if (current && (current.mode === 'state' || current.mode === 'before')) {
      wrap.appendChild(renderStateRefEditor(node, param, kind, current));
    }

    if (current) {
      wrap.classList.add('is-ref');
      target
        .querySelectorAll('input, select, textarea, button')
        .forEach((el) => { el.disabled = true; });
      target.title = '该参数由引用提供';
    }
    return wrap;
  }

  /** 单个值引用：选择 gamestate 路径（当前值/前态值由 mode 决定） */
  function renderStateRefEditor(node, param, kind, ref) {
    const box = document.createElement('span');
    box.className = 'trg-state-ref';
    const ctx = mapStateCtx();
    const parsed = StatePaths.parse(ref.path || '');
    const def = parsed ? parsed.def : StatePaths.DEFS[0];
    const args = {};
    for (const p of def.params) {
      args[p] = parsed && parsed.args[p] !== undefined ? parsed.args[p] : defaultPathArg(p, ctx);
    }
    const defSel = document.createElement('select');
    defSel.className = 'trg-ref-path-def';
    for (const [g, label] of Object.entries(StatePaths.GROUPS)) {
      const defs = StatePaths.DEFS.filter((d) => d.group === g);
      if (!defs.length) continue;
      const og = document.createElement('optgroup');
      og.label = label;
      for (const d of defs) {
        const o = document.createElement('option');
        o.value = d.template;
        o.textContent = d.label;
        og.appendChild(o);
      }
      defSel.appendChild(og);
    }
    defSel.value = def.template;
    const sync = () => {
      ref.path = StatePaths.fill(defSel.value, args);
    };
    defSel.addEventListener('change', () => {
      const next = StatePaths.DEFS.find((d) => d.template === defSel.value);
      for (const p of next.params) {
        if (args[p] === undefined) args[p] = defaultPathArg(p, ctx);
      }
      sync();
      renderEditor();
    });
    box.appendChild(defSel);
    for (const p of def.params) {
      let el;
      if (p === 'seat') {
        el = document.createElement('select');
        el.innerHTML =
          ctx.seats.map((s) => `<option value="${s.seat}">P${s.seat}</option>`).join('') +
          '<option value="player">玩家</option>';
      } else if (p === 'tile') {
        el = document.createElement('input');
        el.type = 'number';
        el.min = '0';
        el.step = '1';
      } else if (p === 'text') {
        el = document.createElement('select');
        el.innerHTML = ctx.texts.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
      } else if (p === 'var') {
        el = document.createElement('select');
        el.innerHTML = ctx.vars.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
      } else {
        el = document.createElement('select');
        el.innerHTML = ctx.ids.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
      }
      el.className = 'trg-ref-path-arg';
      el.value = args[p] ?? '';
      el.addEventListener('change', () => {
        args[p] = el.value;
        sync();
      });
      if (el.tagName === 'INPUT') {
        el.addEventListener('input', () => {
          args[p] = el.value;
          sync();
        });
      }
      box.appendChild(el);
    }
    return box;
  }

  /** 自由输入 + 特殊值（any / unchanged / auto / flipped）的下拉 */
  function withSentinels(node, param, makeInput) {
    const input = makeInput(node, param);
    const options = [];
    if (param.any) options.push(['any', '任意']);
    if (param.unchanged) options.push(['unchanged', '不修改']);
    if (param.auto) options.push(['auto', '自动']);
    if (param.flipped) options.push(['flipped', '翻转']);
    if (!options.length) return input;

    const wrap = document.createElement('span');
    wrap.className = 'trg-value-wrap';
    const sel = document.createElement('select');
    sel.className = 'trg-sentinel';
    sel.title = '特殊值';
    fitWidth(sel, sel.selectedOptions[0]?.textContent || '特殊值');
    sel.innerHTML =
      '<option value="">值</option>' +
      options.map(([v, label]) => `<option value="${v}">${label}</option>`).join('');
    const cur = String(node.params[param.key] ?? '').trim();
    const isSentinel = options.some(([v]) => v === cur);
    sel.value = isSentinel ? cur : '';
    input.disabled = isSentinel;
    if (isSentinel) input.value = '';

    sel.addEventListener('change', () => {
      fitWidth(sel, sel.selectedOptions[0]?.textContent || '');
      if (sel.value) {
        node.params[param.key] = sel.value;
        input.value = '';
        input.disabled = true;
      } else {
        node.params[param.key] = '';
        input.disabled = false;
        input.focus();
      }
      cancelPick();
    });
    input.addEventListener('input', () => {
      if (input.value) sel.value = '';
    });

    wrap.append(input, sel);
    return wrap;
  }

  function renderTextInput(node, param) {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'trg-param';
    input.dataset.uid = String(node.uid);
    input.dataset.key = param.key;
    input.dataset.type = param.type;
    input.value = node.params[param.key] || '';
    input.placeholder = param.placeholder || param.label;
    input.title = '必填';
    if (param.maxLen !== undefined) input.maxLength = param.maxLen;
    if (param.type === 'tile') {
      input.classList.add('pickable');
      input.title = `${param.label}：可手输，或点击后点棋盘拾取`;
    } else if (param.type === 'textId') {
      input.classList.add('pickable');
      input.title = `${param.label}：可手输，或点击右侧「触发器」列表按触发器拾取`;
    } else if (param.type === 'varId') {
      input.classList.add('pickable');
      input.title = `${param.label}：可手输，或点击右侧「触发器」列表按触发器拾取数字变量`;
    }
    fitWidth(input, input.value);
    input.addEventListener('input', () => {
      node.params[param.key] = input.value;
      fitWidth(input, input.value);
      // 显示文本 / 选项文本的 text_id 变化都会影响引用隐藏状态
      if ((node.op === 'show_text' || node.op === 'show_choice_text') && param.key === 'text_id') {
        syncAllShowTextReuse();
      }
      cancelPick();
    });
    input.addEventListener('focus', () => {
      if (param.type === 'tile' || param.type === 'textId' || param.type === 'varId') setPick(node, param, input);
      else cancelPick();
    });
    // 某些嵌入环境（窗口未聚焦）不会派发 focus，这里补一次点击触发
    input.addEventListener('click', () => {
      if (param.type === 'tile' || param.type === 'textId' || param.type === 'varId') setPick(node, param, input);
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
    input.placeholder = param.label;
    input.title = '必填';
    if (param.min !== undefined) input.min = String(param.min);
    if (param.max !== undefined) input.max = String(param.max);
    input.step = '1';
    fitWidth(input, input.value);
    input.addEventListener('input', () => {
      node.params[param.key] = input.value;
      fitWidth(input, input.value);
      cancelPick();
    });
    input.addEventListener('focus', () => cancelPick());
    return input;
  }

  /** 位置参数：模式（屏幕方位 / 绑定地块）+ 对应取值 */
  function renderPlacementControl(node, param) {
    const wrap = document.createElement('span');
    wrap.className = 'trg-value-wrap trg-placement';
    const raw = String(node.params[param.key] ?? '').trim() || 'screen:top-right';
    const sep = raw.indexOf(':');
    const kind = sep >= 0 ? raw.slice(0, sep) : 'screen';
    const rest = sep >= 0 ? raw.slice(sep + 1) : '';

    const modeSel = document.createElement('select');
    modeSel.className = 'trg-placement-mode';
    modeSel.innerHTML = '<option value="screen">屏幕方位</option><option value="tile">绑定地块</option>';
    modeSel.value = kind === 'tile' ? 'tile' : 'screen';
    fitWidth(modeSel, modeSel.selectedOptions[0]?.textContent || '');

    const posSel = document.createElement('select');
    posSel.className = 'trg-placement-pos';
    posSel.innerHTML = Object.keys(POSITION_LABELS)
      .map((v) => `<option value="${v}">${POSITION_LABELS[v]}</option>`)
      .join('');
    posSel.value = modeSel.value === 'screen' ? (rest || 'top-right') : 'top-right';
    fitWidth(posSel, posSel.selectedOptions[0]?.textContent || '');

    const tileInput = document.createElement('input');
    tileInput.type = 'number';
    tileInput.className = 'trg-param';
    tileInput.dataset.uid = String(node.uid);
    tileInput.dataset.key = param.key;
    tileInput.dataset.type = param.type;
    tileInput.min = '0';
    tileInput.step = '1';
    tileInput.placeholder = '地块序号';
    if (modeSel.value === 'tile') tileInput.value = rest || '';
    fitWidth(tileInput, tileInput.value || '地块');

    const setParam = () => {
      node.params[param.key] =
        modeSel.value === 'screen' ? `screen:${posSel.value}` : `tile:${tileInput.value}`;
      cancelPick();
      fitAllParams();
    };
    const syncMode = () => {
      const isScreen = modeSel.value === 'screen';
      posSel.hidden = !isScreen;
      tileInput.hidden = isScreen;
      setParam();
    };
    modeSel.addEventListener('change', syncMode);
    posSel.addEventListener('change', setParam);
    tileInput.addEventListener('input', setParam);
    tileInput.addEventListener('focus', () => {
      setPick(node, { ...param, type: 'tile', label: '绑定地块' }, tileInput, true);
    });
    tileInput.addEventListener('blur', () => cancelPick());

    wrap.append(modeSel, posSel, tileInput);
    syncMode();
    return wrap;
  }

  // ---------- gamestate 路径 / 断言 / 文本编辑器 ----------
  function mapStateCtx() {
    const map = Editor.getState().map;
    return {
      total: map ? map.row * map.column : 0,
      seats: map ? [...map.player_list].sort((a, b) => a.seat - b.seat) : [],
      ids: map ? (map.triggers || []).map((t) => t.id) : [],
      texts: [...collectTextIds()],
      vars: [...collectVarIds()],
    };
  }

  function defaultPathArg(kind, ctx) {
    if (kind === 'seat') return ctx.seats.length ? String(ctx.seats[0].seat) : 'player';
    if (kind === 'tile') return '0';
    if (kind === 'text') return ctx.texts[0] ?? '';
    if (kind === 'var') return ctx.vars[0] ?? '';
    return ctx.ids[0] ?? '';
  }

  /**
   * 状态路径控件：
   *   - 具体路径 → 原有选择器
   *   - 模板路径（{tile} 等）→ 每个动态参数可单独设为 具体值 / 任意（筛选）/ 来自
   */
  function renderStatePathControl(node, param) {
    const raw = String(node.params[param.key] || '');
    const templateDef =
      StatePaths.DEFS.find((d) => d.template === raw && d.params.length > 0) || null;
    if (templateDef) return renderTemplateStatePathControl(node, param, templateDef);
    return renderConcreteStatePathControl(node, param);
  }

  function renderConcreteStatePathControl(node, param) {
    const ctx = mapStateCtx();
    const parsed = StatePaths.parse(node.params[param.key] || '');
    const def = parsed ? parsed.def : StatePaths.DEFS[0];
    const args = {};
    for (const p of def.params) {
      args[p] = parsed && parsed.args[p] !== undefined ? parsed.args[p] : defaultPathArg(p, ctx);
    }

    const wrap = document.createElement('span');
    wrap.className = 'trg-value-wrap trg-statepath';

    const defSel = document.createElement('select');
    defSel.className = 'trg-param trg-path-def';
    defSel.dataset.uid = String(node.uid);
    defSel.dataset.key = param.key;
    defSel.dataset.type = param.type;
    for (const [g, label] of Object.entries(StatePaths.GROUPS)) {
      const defs = StatePaths.DEFS.filter((d) => d.group === g);
      if (!defs.length) continue;
      const og = document.createElement('optgroup');
      og.label = label;
      for (const d of defs) {
        const o = document.createElement('option');
        o.value = d.template;
        o.textContent = d.label;
        og.appendChild(o);
      }
      defSel.appendChild(og);
    }
    defSel.value = def.template;
    fitWidth(defSel, def.label);

    const apply = () => {
      node.params[param.key] = StatePaths.fill(defSel.value, args);
      renderEditor();
    };
    defSel.addEventListener('change', () => {
      const next = StatePaths.DEFS.find((d) => d.template === defSel.value);
      const nextArgs = {};
      for (const p of next.params) {
        nextArgs[p] = args[p] !== undefined ? args[p] : defaultPathArg(p, ctx);
      }
      if (next.params.some((p) => String(nextArgs[p] ?? '') === '')) {
        const missing = next.params.find((p) => String(nextArgs[p] ?? '') === '');
        toast(
          missing === 'text'
            ? '没有可用的文本'
            : missing === 'var'
              ? '没有可用的数字变量'
              : '没有可用的触发器',
          'error',
        );
        defSel.value = def.template;
        return;
      }
      Object.assign(args, nextArgs);
      apply();
    });
    wrap.appendChild(defSel);

    for (const p of def.params) {
      const modeSel = document.createElement('select');
      modeSel.className = 'trg-path-arg-mode';
      modeSel.title = '该参数的筛选方式';
      modeSel.innerHTML =
        '<option value="literal">具体值</option>' +
        '<option value="any">任意</option>' +
        '<option value="condition">来自</option>';
      modeSel.addEventListener('change', () => {
        node.filterArgs = node.filterArgs || {};
        if (modeSel.value === 'any') {
          node.filterArgs[p] = { mode: 'any' };
        } else if (modeSel.value === 'condition') {
          const type = pathArgFilterType(p);
          const candidates = conditionCandidates(type);
          node.filterArgs[p] = { mode: 'condition', cid: candidates[0]?.cid ?? '' };
        } else {
          node.filterArgs[p] = { mode: 'literal', value: args[p] };
        }
        node.params[param.key] = def.template;
        renderEditor();
      });
      wrap.appendChild(modeSel);
      let el;
      if (p === 'seat') {
        el = document.createElement('select');
        el.innerHTML =
          ctx.seats.map((s) => `<option value="${s.seat}">P${s.seat} ${esc(s.name || '')}</option>`).join('') +
          '<option value="player">玩家</option>';
        el.value = args.seat;
      } else if (p === 'tile') {
        el = document.createElement('input');
        el.type = 'number';
        el.min = '0';
        el.max = String(Math.max(0, ctx.total - 1));
        el.step = '1';
        el.value = args.tile;
      } else if (p === 'text') {
        el = document.createElement('select');
        el.innerHTML = ctx.texts.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
        // 旧数据可能把 {text} 原样写进路径；回落到第一个可用文本 id
        const selected = ctx.texts.includes(args.text) ? args.text : (ctx.texts[0] ?? '');
        el.value = selected;
        args.text = selected;
      } else if (p === 'var') {
        el = document.createElement('select');
        el.innerHTML = ctx.vars.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
        const selected = ctx.vars.includes(args.var) ? args.var : (ctx.vars[0] ?? '');
        el.value = selected;
        args.var = selected;
      } else {
        el = document.createElement('select');
        el.innerHTML = ctx.ids.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
        el.value = args.trigger;
      }
      el.className = 'trg-param';
      if (el.tagName === 'SELECT') fitWidth(el, el.selectedOptions[0]?.textContent || '');
      else fitWidth(el, el.value || '0');
      el.dataset.uid = String(node.uid);
      el.dataset.key = `${param.key}.${p}`;
      el.dataset.type = 'statePathArg';
      el.title = p === 'seat' ? '座次' : p === 'tile' ? '地块序号' : p === 'text' ? '文本' : p === 'var' ? '数字变量' : '触发器';
      el.addEventListener('change', () => {
        args[p] = el.value;
        apply();
      });
      if (p === 'text' || p === 'var') {
        wrap.append(el);
        continue;
      }
      const pickBtn = document.createElement('button');
      pickBtn.type = 'button';
      pickBtn.className = 'trg-param trg-pick-btn';
      pickBtn.textContent = '拾取';
      fitWidth(pickBtn, '拾取');
      pickBtn.title = `从地图中选取${el.title || ''}`;
      pickBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const pickType = p === 'seat' ? 'force' : p === 'tile' ? 'tile' : 'trigger';
        armPick({
          type: pickType,
          label: el.title || p,
          onValue: (v) => {
            args[p] = String(v);
            node.params[param.key] = StatePaths.fill(defSel.value, args);
            renderEditor();
          },
        });
      });
      wrap.append(el, pickBtn);
    }

    const filled = StatePaths.fill(def.template, args);
    const repairText = def.params.includes('text') && ctx.texts.length > 0 && filled !== node.params[param.key];
    const repairVar = def.params.includes('var') && ctx.vars.length > 0 && filled !== node.params[param.key];
    if (!node.params[param.key] || repairText || repairVar) node.params[param.key] = filled;
    return wrap;
  }

  /** 模板路径：每个动态参数单独选择 具体值 / 任意（筛选）/ 来自 */
  function renderTemplateStatePathControl(node, param, templateDef) {
    const ctx = mapStateCtx();
    node.filterArgs = node.filterArgs || {};
    for (const p of templateDef.params) {
      if (!node.filterArgs[p]) {
        node.filterArgs[p] = { mode: 'literal', value: defaultPathArg(p, ctx) };
      }
    }
    const wrap = document.createElement('span');
    wrap.className = 'trg-value-wrap trg-statepath trg-statepath-filter';

    const defSel = document.createElement('select');
    defSel.className = 'trg-param trg-path-def';
    defSel.dataset.uid = String(node.uid);
    defSel.dataset.key = param.key;
    defSel.dataset.type = param.type;
    for (const [g, label] of Object.entries(StatePaths.GROUPS)) {
      const defs = StatePaths.DEFS.filter((d) => d.group === g);
      if (!defs.length) continue;
      const og = document.createElement('optgroup');
      og.label = label;
      for (const d of defs) {
        const o = document.createElement('option');
        o.value = d.template;
        o.textContent = d.label;
        og.appendChild(o);
      }
      defSel.appendChild(og);
    }
    defSel.value = templateDef.template;
    fitWidth(defSel, templateDef.label);
    defSel.addEventListener('change', () => {
      const next = StatePaths.DEFS.find((d) => d.template === defSel.value);
      node.params[param.key] = next.template;
      node.filterArgs = {};
      for (const p of next.params) {
        node.filterArgs[p] = { mode: 'literal', value: defaultPathArg(p, ctx) };
      }
      renderEditor();
    });
    wrap.appendChild(defSel);

    for (const p of templateDef.params) {
      const flow = node.filterArgs[p];
      const modeSel = document.createElement('select');
      modeSel.className = 'trg-path-arg-mode';
      modeSel.title = '该参数的筛选方式';
      modeSel.innerHTML =
        '<option value="literal">具体值</option>' +
        '<option value="any">任意</option>' +
        '<option value="condition">来自</option>';
      modeSel.value = flow.mode === 'any' || flow.mode === 'condition' ? flow.mode : 'literal';
      modeSel.addEventListener('change', () => {
        if (modeSel.value === 'any') {
          node.filterArgs[p] = { mode: 'any' };
        } else if (modeSel.value === 'condition') {
          const type = pathArgFilterType(p);
          const candidates = conditionCandidates(type);
          node.filterArgs[p] = { mode: 'condition', cid: candidates[0]?.cid ?? '' };
        } else {
          node.filterArgs[p] = { mode: 'literal', value: defaultPathArg(p, ctx) };
        }
        renderEditor();
      });
      wrap.appendChild(modeSel);

      if (flow.mode === 'condition') {
        const candidates = conditionCandidates(pathArgFilterType(p));
        const refSel = document.createElement('select');
        refSel.className = 'trg-path-arg-ref';
        refSel.innerHTML = candidates
          .map((n) => `<option value="${esc(n.cid)}">${esc(n.cid)} ${esc(defOfOp(n.op)?.label || n.op)}</option>`)
          .join('');
        if (!candidates.length) {
          refSel.innerHTML = '<option value="">没有匹配的筛选条件</option>';
        }
        refSel.value = flow.cid || '';
        refSel.addEventListener('change', () => {
          flow.cid = refSel.value;
        });
        wrap.appendChild(refSel);
        continue;
      }
      if (flow.mode === 'any') {
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = '任意';
        wrap.appendChild(hint);
        continue;
      }

      let el;
      if (p === 'seat') {
        el = document.createElement('select');
        el.innerHTML =
          ctx.seats.map((s) => `<option value="${s.seat}">P${s.seat} ${esc(s.name || '')}</option>`).join('') +
          '<option value="player">玩家</option>';
      } else if (p === 'tile') {
        el = document.createElement('input');
        el.type = 'number';
        el.min = '0';
        el.max = String(Math.max(0, ctx.total - 1));
        el.step = '1';
      } else if (p === 'text') {
        el = document.createElement('select');
        el.innerHTML = ctx.texts.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
      } else if (p === 'var') {
        el = document.createElement('select');
        el.innerHTML = ctx.vars.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
      } else {
        el = document.createElement('select');
        el.innerHTML = ctx.ids.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
      }
      el.className = 'trg-param trg-path-arg';
      el.value = String(flow.value ?? '');
      const onChange = () => {
        flow.value = el.value;
      };
      el.addEventListener('change', onChange);
      if (el.tagName === 'INPUT') el.addEventListener('input', onChange);
      wrap.appendChild(el);
    }
    return wrap;
  }

  function renderStateValueControl(node, param) {
    const wrap = document.createElement('span');
    wrap.className = 'trg-value-wrap';
    // “改变”谓词不需要预期值
    if (String(node.params.cmp) === 'changed') return wrap;
    const parsed = StatePaths.parse(node.params.path || '');
    if (!parsed) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = '先选择变量';
      wrap.appendChild(hint);
      return wrap;
    }
    const def = parsed.def;
    const nullable = !!def.nullable || def.kind === 'owner';
    const raw = String(node.params.value ?? '').trim();
    const set = (v) => {
      node.params.value = v;
      cancelPick();
    };
    const makeSelect = (options, current) => {
      const sel = document.createElement('select');
      sel.className = 'trg-param trg-state-value';
      sel.dataset.uid = String(node.uid);
      sel.dataset.key = param.key;
      sel.dataset.type = param.type;
      sel.innerHTML = options
        .map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`)
        .join('');
      sel.value = current;
      fitWidth(sel, sel.selectedOptions[0]?.textContent || '');
      sel.addEventListener('change', () => {
        fitWidth(sel, sel.selectedOptions[0]?.textContent || '');
        set(sel.value);
      });
      return sel;
    };
    const ctx = mapStateCtx();
    /**
     * 枚举控件：当前值不在合法选项里（含空值）时落到默认值并写回 params。
     * 否则控件会显示默认项、但 params.value 仍为空，提交时被误判为“未填预期值”。
     */
    const ensureEnumValue = (options, fallback) => {
      const values = options.map(([v]) => v);
      const current = values.includes(raw) ? raw : fallback;
      if (raw !== current) node.params.value = current;
      return current;
    };
    switch (def.kind) {
      case 'bool': {
        const opts = [['true', '是'], ['false', '否']];
        if (nullable) opts.push(['null', '无']);
        wrap.appendChild(makeSelect(opts, ensureEnumValue(opts, 'true')));
        break;
      }
      case 'phase': {
        const opts = PHASES.map((p) => [p, PHASE_LABELS[p]]);
        wrap.appendChild(makeSelect(opts, ensureEnumValue(opts, PHASES[0])));
        break;
      }
      case 'terrain': {
        const opts = ['5', '0', '3', '4', '1'].map((v) => [v, MapConst.TERRAIN_LABELS[Number(v)]]);
        wrap.appendChild(makeSelect(opts, ensureEnumValue(opts, '0')));
        break;
      }
      case 'difficulty': {
        const opts = AI_LEVELS.map((v) => [String(v), MapConst.AI_LABELS[v] || String(v)]);
        wrap.appendChild(makeSelect(opts, ensureEnumValue(opts, String(AI_LEVELS[0]))));
        break;
      }
      case 'seat': {
        const opts = ctx.seats.map((s) => [String(s.seat), `P${s.seat}`]);
        opts.push(['player', '玩家']);
        if (nullable) opts.push(['null', '无']);
        wrap.appendChild(makeSelect(opts, ensureEnumValue(opts, opts[0] ? opts[0][0] : '')));
        break;
      }
      case 'owner': {
        const opts = ctx.seats.map((s) => [String(s.seat), `P${s.seat}`]);
        opts.push(['player', '玩家'], ['0', '野生'], ['255', '阻挡'], ['null', '无兵']);
        wrap.appendChild(makeSelect(opts, ensureEnumValue(opts, opts[0] ? opts[0][0] : 'null')));
        break;
      }
      case 'intent': {
        const opts = StatePaths.INTENTS.map((v) => [v, StatePaths.INTENT_LABELS[v] || v]);
        if (nullable) opts.push(['null', '无']);
        wrap.appendChild(makeSelect(opts, ensureEnumValue(opts, 'null')));
        break;
      }
      case 'textVisible': {
        const opts = [['true', '展示'], ['false', '隐藏']];
        wrap.appendChild(makeSelect(opts, ensureEnumValue(opts, 'false')));
        break;
      }
      case 'text': {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'trg-param';
        input.dataset.uid = String(node.uid);
        input.dataset.key = param.key;
        input.dataset.type = param.type;
        input.value = raw;
        fitWidth(input, input.value);
        input.addEventListener('input', () => {
          fitWidth(input, input.value);
          set(input.value);
        });
        wrap.appendChild(input);
        break;
      }
      default: {
        // int（可能为 null）
        const input = document.createElement('input');
        input.type = 'number';
        input.step = '1';
        input.className = 'trg-param';
        input.dataset.uid = String(node.uid);
        input.dataset.key = param.key;
        input.dataset.type = param.type;
        input.value = raw === 'null' ? '' : raw;
        input.disabled = raw === 'null';
        fitWidth(input, input.value);
        input.addEventListener('input', () => {
          fitWidth(input, input.value);
          set(input.value);
        });
        wrap.appendChild(input);
        if (nullable) {
          const sel = document.createElement('select');
          sel.className = 'trg-sentinel';
          sel.innerHTML = '<option value="value">值</option><option value="null">无</option>';
          sel.value = raw === 'null' ? 'null' : 'value';
          sel.addEventListener('change', () => {
            if (sel.value === 'null') {
              input.value = '';
              input.disabled = true;
              set('null');
            } else {
              input.disabled = false;
              set(input.value);
              input.focus();
            }
          });
          wrap.appendChild(sel);
        }
      }
    }
    return wrap;
  }


  let orderEditorNode = null;
  let orderDragIndex = null;

  function orderSeatsOf(raw) {
    const map = Editor.getState().map;
    const all = (map?.player_list || []).map((p) => p.seat).sort((a, b) => a - b);
    const parsed = String(raw || '')
      .split(/[,，\s]+/)
      .map(Number)
      .filter((n) => Number.isInteger(n));
    const out = [];
    const seen = new Set();
    for (const s of parsed) {
      if (all.includes(s) && !seen.has(s)) {
        out.push(s);
        seen.add(s);
      }
    }
    for (const s of all) if (!seen.has(s)) out.push(s);
    return out;
  }

  function forceLabel(seat) {
    const map = Editor.getState().map;
    const p = (map?.player_list || []).find((x) => x.seat === seat);
    return `P${seat} ${p?.name || ''}`.trim();
  }

  function renderOrderEditorControl(node, param) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'trg-param trg-order-btn';
    btn.dataset.uid = String(node.uid);
    btn.dataset.key = param.key;
    btn.dataset.type = param.type;
    const order = orderSeatsOf(node.params.order);
    btn.textContent = '编辑顺序…';
    btn.title = order.map(forceLabel).join(' → ');
    fitWidth(btn, btn.textContent);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openOrderEditor(node);
    });
    return btn;
  }

  function openOrderEditor(node) {
    orderEditorNode = node;
    buildOrderList();
    $('dlg-order-editor').showModal();
  }

  function buildOrderList() {
    const list = $('order-editor-list');
    if (!list || !orderEditorNode) return;
    const order = orderSeatsOf(orderEditorNode.params.order);
    list.innerHTML = '';
    order.forEach((seat, i) => {
      const row = document.createElement('div');
      row.className = 'order-row';
      row.draggable = true;
      row.dataset.index = String(i);
      row.innerHTML = `<span class="order-grip">⠿</span><span class="order-name">${esc(forceLabel(seat))}</span>`;
      row.addEventListener('dragstart', (e) => {
        orderDragIndex = i;
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', (e) => e.preventDefault());
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        if (orderDragIndex === null || orderDragIndex === i) return;
        const cur = orderSeatsOf(orderEditorNode.params.order);
        const [moved] = cur.splice(orderDragIndex, 1);
        cur.splice(i, 0, moved);
        orderDragIndex = null;
        orderEditorNode.params.order = cur.join(', ');
        buildOrderList();
      });
      list.appendChild(row);
      if (i < order.length - 1) {
        const arrow = document.createElement('div');
        arrow.className = 'order-arrow';
        arrow.textContent = '→';
        list.appendChild(arrow);
      }
    });
  }

  function submitOrderEditor() {
    if (!orderEditorNode) return;
    const order = orderSeatsOf(orderEditorNode.params.order);
    orderEditorNode.params.order = order.join(', ');
    $('dlg-order-editor').close();
    orderEditorNode = null;
    renderEditor();
  }

  let textEditor = null;

  function renderTextEditorControl(node, param) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'trg-param trg-text-btn';
    btn.dataset.uid = String(node.uid);
    btn.dataset.key = param.key;
    btn.dataset.type = param.type;
    const text = String(node.params.text || '');
    btn.textContent = text ? text.slice(0, 6) + (text.length > 6 ? '…' : '') : '编辑文本…';
    btn.title = text || '点击编辑文本';
    fitWidth(btn, btn.textContent);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openTextEditor(node);
    });
    return btn;
  }

  /** 输入的 text_id 已有定义时，隐藏内容与位置控件（选项文本引用优先） */
  function syncShowTextReference(comp, node) {
    if (!comp || !node) return;
    const id = node.params?.text_id;
    const choiceRef = findChoiceTextDefinition(id, node);
    const textRef = node.op === 'show_text' ? findTextDefinition(id, node) : null;
    const detail = comp.querySelector('.trg-showtext-detail');
    if (detail) detail.hidden = !!(choiceRef || textRef);
  }

  /** 任一文本身份变化后，刷新所有显示文本组件的引用状态 */
  function syncAllShowTextReuse() {
    document.querySelectorAll('#trg-editor .trg-comp').forEach((comp) => {
      const entry = findEntry(Number(comp.dataset.uid));
      if (entry && (entry.node.op === 'show_text' || entry.node.op === 'show_choice_text')) {
        syncShowTextReference(comp, entry.node);
      }
    });
  }

  function stateCtxForValidation() {
    const map = Editor.getState().map;
    return {
      total: map.row * map.column,
      seats: new Set(map.player_list.map((p) => p.seat)),
      ids: new Set((map.triggers || []).map((t) => t.id)),
      texts: collectTextIds(),
      vars: collectVarIds(),
    };
  }

  function openTextEditor(node) {
    const map = Editor.getState().map;
    if (!map) return toast('没有地图', 'error');
    const isChoice = node.op === 'show_choice_text';
    textEditor = { node, selected: null, isChoice, options: [], lastInput: $('te-text') };
    $('te-choice').hidden = !isChoice;
    if (isChoice) {
      const opts = Array.isArray(node.choiceOptions) ? node.choiceOptions.map((o) => String(o)) : [];
      textEditor.options = opts.length ? opts.slice() : [''];
      renderChoiceOptions();
    } else {
      $('te-choice-list').innerHTML = '';
    }
    $('te-text').value = String(node.params.text || '');
    buildTextTree();
    $('dlg-text-editor').showModal();
  }

  function renderChoiceOptions() {
    if (!textEditor?.isChoice) return;
    const list = $('te-choice-list');
    list.innerHTML = '';
    textEditor.options.forEach((value, i) => {
      const row = document.createElement('div');
      row.className = 'te-choice-row';
      const index = document.createElement('span');
      index.className = 'te-choice-index';
      index.textContent = String(i);
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'te-choice-input';
      input.value = value;
      input.placeholder = `选项 ${i}`;
      input.addEventListener('input', () => {
        textEditor.options[i] = input.value;
      });
      input.addEventListener('focus', () => {
        textEditor.lastInput = input;
      });
      row.append(index, input);
      if (i > 0) {
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'te-choice-del';
        del.textContent = '－';
        del.title = '删除该选项';
        del.addEventListener('click', () => {
          textEditor.options.splice(i, 1);
          if (textEditor.lastInput === input) textEditor.lastInput = $('te-text');
          renderChoiceOptions();
        });
        row.append(del);
      }
      list.append(row);
    });
    if (
      textEditor.lastInput &&
      textEditor.lastInput !== $('te-text') &&
      !textEditor.lastInput.isConnected
    ) {
      textEditor.lastInput = $('te-text');
    }
  }


  function setParamElValue(el, value) {
    const v = String(value);
    if (el.tagName === 'SELECT') {
      if (![...el.options].some((o) => o.value === v)) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = v;
        el.appendChild(o);
      }
      el.value = v;
      fitWidth(el, el.selectedOptions[0]?.textContent || v);
    } else {
      el.value = v;
      fitWidth(el, v);
    }
  }

  /** 文本编辑器的参数：暂时关闭弹窗，点击地图/势力/触发器取值；任意点击后重新打开 */
  function pickTextArg(paramName, el, args) {
    const dlg = $('dlg-text-editor');
    const type = paramName === 'seat' ? 'force' : paramName === 'tile' ? 'tile' : 'trigger';
    const label = paramName === 'seat' ? '座次' : paramName === 'tile' ? '地块' : '触发器';
    dlg.close();
    if (type === 'tile') {
      // 地块在 mousedown 拾取；鼠标抬起后立即恢复弹窗
      const reopen = () => {
        document.removeEventListener('mouseup', reopen, true);
        if (textEditor) dlg.showModal();
      };
      document.addEventListener('mouseup', reopen, true);
    }
    armPick({
      type,
      label,
      onValue: (v) => {
        args[paramName] = String(v);
        setParamElValue(el, v);
      },
      onSettled:
        type === 'tile'
          ? undefined
          : () => {
              if (textEditor) dlg.showModal();
            },
    });
  }

  function buildTextTree() {
    const map = Editor.getState().map;
    const tree = $('te-tree');
    tree.innerHTML = '';
    if (!map) return;
    const seats = [...map.player_list].sort((a, b) => a.seat - b.seat);
    const ids = (map.triggers || []).map((t) => t.id);
    const texts = [...collectTextIds()];
    const vars = [...collectVarIds()];
    const total = map.row * map.column;
    for (const [g, label] of Object.entries(StatePaths.GROUPS)) {
      const defs = StatePaths.DEFS.filter((d) => d.group === g);
      if (!defs.length) continue;
      const gh = document.createElement('button');
      gh.type = 'button';
      gh.className = 'te-group';
      const ghLabel = document.createElement('span');
      ghLabel.textContent = label;
      const ghArrow = document.createElement('span');
      ghArrow.className = 'te-arrow';
      ghArrow.textContent = '▼';
      gh.append(ghLabel, ghArrow);
      const body = document.createElement('div');
      body.className = 'te-group-body';
      body.hidden = true;
      gh.addEventListener('click', () => {
        const collapse = !body.hidden;
        body.hidden = collapse;
        ghArrow.textContent = collapse ? '▼' : '▲';
      });
      tree.append(gh, body);
      for (const def of defs) {
        const row = document.createElement('label');
        row.className = 'te-def';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        const span = document.createElement('span');
        span.textContent = def.label;
        row.append(cb, span);
        body.appendChild(row);

        const args = {};
        let paramRow = null;
        if (def.params.length) {
          paramRow = document.createElement('div');
          paramRow.className = 'te-param-row';
          paramRow.hidden = true;
          for (const p of def.params) {
            const tag = document.createElement('span');
            tag.textContent = p === 'seat' ? '座次' : p === 'tile' ? '地块' : p === 'text' ? '文本' : p === 'var' ? '数字变量' : '触发器';
            let el;
            if (p === 'seat') {
              el = document.createElement('select');
              el.innerHTML =
                seats.map((s) => `<option value="${s.seat}">P${s.seat} ${esc(s.name || '')}</option>`).join('') +
                '<option value="player">玩家</option>';
            } else if (p === 'tile') {
              el = document.createElement('input');
              el.type = 'number';
              el.min = '0';
              el.max = String(Math.max(0, total - 1));
              el.step = '1';
              el.value = '0';
            } else if (p === 'text') {
              el = document.createElement('select');
              el.innerHTML = texts.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
            } else if (p === 'var') {
              el = document.createElement('select');
              el.innerHTML = vars.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
            } else {
              el = document.createElement('select');
              el.innerHTML = ids.map((id) => `<option value="${esc(id)}">${esc(id)}</option>`).join('');
            }
            if (el.tagName === 'SELECT' && el.options.length) el.value = el.options[0].value;
            fitWidth(el, el.tagName === 'SELECT' ? (el.selectedOptions[0]?.textContent || '') : el.value || '0');
            args[p] = el.value === undefined ? '' : String(el.value);
            el.addEventListener('change', () => {
              args[p] = el.value;
              fitWidth(el, el.selectedOptions?.[0]?.textContent || el.value || '');
            });
            if (p === 'text' || p === 'var') {
              paramRow.append(tag, el);
              continue;
            }
            const pickBtn = document.createElement('button');
            pickBtn.type = 'button';
            pickBtn.className = 'te-pick-btn';
            pickBtn.textContent = '从地图中选取';
            pickBtn.addEventListener('click', (e) => {
              e.preventDefault();
              e.stopPropagation();
              pickTextArg(p, el, args);
            });
            paramRow.append(tag, el, pickBtn);
          }
          body.appendChild(paramRow);
        }

        cb.addEventListener('change', () => {
          if (!cb.checked) {
            row.classList.remove('checked');
            if (paramRow) paramRow.hidden = true;
            textEditor.selected = null;
            return;
          }
          tree.querySelectorAll('.te-def input[type=checkbox]').forEach((x) => {
            if (x !== cb) x.checked = false;
          });
          tree.querySelectorAll('.te-def').forEach((r) => r.classList.remove('checked'));
          tree.querySelectorAll('.te-param-row').forEach((r) => {
            r.hidden = true;
          });
          row.classList.add('checked');
          if (paramRow) paramRow.hidden = false;
          textEditor.selected = { def, args };
        });
      }
    }
  }

  function insertStateToken() {
    if (!textEditor?.selected) return toast('请先勾选一个 gamestate 变量', 'error');
    const { def, args } = textEditor.selected;
    const missing = def.params.find((p) => args[p] === undefined || args[p] === '');
    if (missing) return toast('请先填写变量参数', 'error');
    const token = `{${StatePaths.fill(def.template, args)}}`;
    const ta =
      textEditor.isChoice && textEditor.lastInput?.isConnected
        ? textEditor.lastInput
        : $('te-text');
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    ta.value = ta.value.slice(0, start) + token + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + token.length;
    if (ta.classList?.contains('te-choice-input')) {
      const i = [...$('te-choice-list').querySelectorAll('.te-choice-input')].indexOf(ta);
      if (i >= 0) textEditor.options[i] = ta.value;
    }
    ta.focus();
  }

  function submitTextEditor() {
    if (!textEditor) return;
    const text = $('te-text').value;
    if (text.length > 4000) return toast('文本不能超过 4000 个字符', 'error');
    const ctx = stateCtxForValidation();
    const bad = StatePaths.tokens(text).find((p) => !StatePaths.validatePath(p, ctx));
    if (bad) return toast(`未知的 gamestate 变量：${bad}`, 'error');
    let options = null;
    if (textEditor.isChoice) {
      options = (textEditor.options || []).map((o) => String(o).trim());
      if (!options.length) return toast('请至少添加一个选项', 'error');
      if (options.some((o) => o === '')) return toast('选项内容不能为空', 'error');
      if (options.some((o) => o.length > 4000)) return toast('单个选项不能超过 4000 个字符', 'error');
      for (const option of options) {
        const badOption = StatePaths.tokens(option).find((p) => !StatePaths.validatePath(p, ctx));
        if (badOption) return toast(`选项包含未知的 gamestate 变量：${badOption}`, 'error');
      }
    }
    textEditor.node.params.text = text;
    if (options) textEditor.node.choiceOptions = options;
    $('dlg-text-editor').close();
    textEditor = null;
    renderEditor();
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
    fitWidth(btn, val.textContent);
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
    if (v === 'any') return '任意';
    if (v === 'unchanged') return '不修改';
    if (v === 'auto') return '自动';
    if (v === 'flipped') return '翻转';
    if (v === 'null') return '无主/中立';
    switch (param.type) {
      case 'force':
        if (v === 'player') return '当前玩家';
        if (v === 'next_after_player') return '下一势力';
        return `P${v}`;
      case 'seat':
        return `P${v}`;
      case 'owner':
        if (v === 'player') return '当前玩家';
        return `P${v}`;
      case 'team':
        return `T${v}`;
      case 'terrain': {
        const n = /^[0-9]+$/.test(v) ? Number(v) : TERRAIN_ALIASES[v];
        return MapConst.TERRAIN_LABELS[n] ?? v;
      }
      case 'phase':
        return PHASE_LABELS[v] ?? v;
      case 'difficulty':
        return MapConst.AI_LABELS[Number(v)] ?? v;
      case 'compare':
        return { '=': '等于', '!=': '≠', '>': '>', '<': '<', '>=': '≥', '<=': '≤', changed: '改变' }[v] ?? v;
      case 'valueMode':
        return v === 'gamestate' ? '变量' : '具体值';
      case 'varValueMode':
        return v === 'gamestate' ? '变量' : '值';
      case 'operator':
        return v;
      case 'bool':
        return v === 'true' ? '是' : v === 'false' ? '否' : v;
      case 'position':
        return POSITION_LABELS[v] ?? v;
      case 'placement': {
        const sep = v.indexOf(':');
        if (sep < 0) return v;
        const kind = v.slice(0, sep);
        const rest = v.slice(sep + 1);
        if (kind === 'tile') return `地块 ${rest}`;
        return `屏幕·${POSITION_LABELS[rest] ?? rest}`;
      }
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

  /** 某参数的全部合法值（含该参数允许的特殊值） */
  function optionList(node, param) {
    const map = Editor.getState().map;
    const seats = map ? [...map.player_list].sort((a, b) => a.seat - b.seat) : [];
    const teams = map ? [...new Set(map.player_list.map((p) => p.team))].sort((a, b) => a - b) : [];
    const out = [];
    switch (param.type) {
      case 'force':
        for (const p of seats) out.push({ value: String(p.seat), label: `P${p.seat} ${p.name || ''}`.trim() });
        out.push({ value: 'player', label: '当前玩家（player）' });
        if (param.spawn) out.push({ value: 'next_after_player', label: '行动顺序下一势力' });
        if (param.any) out.push({ value: 'any', label: '任意' });
        return out;
      case 'trigger':
        for (const t of map?.triggers || []) out.push({ value: t.id, label: t.id });
        if (param.any) out.push({ value: 'any', label: '任意' });
        return out;
      case 'phase':
        for (const v of PHASES) out.push({ value: v, label: PHASE_LABELS[v] });
        if (param.any) out.push({ value: 'any', label: '任意' });
        return out;
      case 'terrain':
        return ['5', '0', '3', '4', '1'].map((v) => ({ value: v, label: MapConst.TERRAIN_LABELS[Number(v)] }));
      case 'difficulty': {
        const vals = param.values || AI_LEVELS;
        for (const v of vals) out.push({ value: String(v), label: MapConst.AI_LABELS[v] || String(v) });
        if (param.unchanged) out.push({ value: 'unchanged', label: '不修改' });
        return out;
      }
      case 'bool':
        out.push({ value: 'true', label: '是' }, { value: 'false', label: '否' });
        if (param.flipped) out.push({ value: 'flipped', label: '翻转' });
        if (param.unchanged) out.push({ value: 'unchanged', label: '不修改' });
        return out;
      case 'compare':
        return [
          { value: '=', label: '等于' },
          { value: '!=', label: '≠' },
          { value: '>', label: '>' },
          { value: '<', label: '<' },
          { value: '>=', label: '≥' },
          { value: '<=', label: '≤' },
          { value: 'changed', label: '改变' },
        ];
      case 'valueMode':
        return [
          { value: 'literal', label: '具体值' },
          { value: 'gamestate', label: '变量' },
        ];
      case 'varValueMode':
        return [
          { value: 'literal', label: '值' },
          { value: 'gamestate', label: '变量' },
        ];
      case 'operator':
        return [
          { value: '+', label: '+' },
          { value: '-', label: '-' },
          { value: '*', label: '*' },
          { value: '/', label: '/' },
          { value: '=', label: '=' },
        ];
      case 'position':
        return Object.keys(POSITION_LABELS).map((v) => ({ value: v, label: POSITION_LABELS[v] }));
      case 'seatList':
        return seats.map((p) => ({ value: String(p.seat), label: `P${p.seat} ${p.name || ''}`.trim() }));
      case 'seat':
        for (const p of seats) out.push({ value: String(p.seat), label: `P${p.seat} ${p.name || ''}`.trim() });
        if (param.unchanged) out.push({ value: 'unchanged', label: '不修改' });
        return out;
      case 'owner':
        for (const p of seats) out.push({ value: String(p.seat), label: `P${p.seat} ${p.name || ''}`.trim() });
        out.push({ value: 'player', label: '当前玩家（player）' });
        out.push({ value: 'any', label: '任意' }, { value: 'null', label: '无主/中立' });
        return out;
      case 'team':
        for (const t of teams) out.push({ value: String(t), label: `T${t}` });
        if (param.unchanged) out.push({ value: 'unchanged', label: '不修改' });
        return out;
      default:
        return [];
    }
  }

  function updateControlLabel(control, param, value) {
    const val = control.querySelector('.trg-val');
    if (val) {
      val.textContent = displayValue(param, value);
      fitWidth(control, val.textContent);
    }
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
          // 断言的“改变”/预期值来源、数字变量的输入方式都会改变后续控件，切换后重绘
          const needsRedraw =
            (node.op === 'state_assert' && (param.key === 'cmp' || param.key === 'value_mode')) ||
            ((node.op === 'declare' || node.op === 'change') &&
              (param.key === 'init_mode' || param.key === 'param_mode'));
          if (needsRedraw) renderEditor();
        }
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
      if (node.cid) {
        const badge = document.createElement('span');
        badge.className = 'trg-cid';
        badge.textContent = node.cid;
        badge.title = '组件编号（可被同触发器的参数引用）';
        head.appendChild(badge);
      }
      const children = document.createElement('div');
      children.className = 'trg-children' + (node.children.length ? '' : ' empty');
      children.dataset.drop = 'group';
      children.dataset.groupUid = String(node.uid);
      node.children.forEach((child) => children.appendChild(renderNode(child)));
      el.appendChild(head);
      el.appendChild(children);
    } else if (node.op === 'show_text' || node.op === 'show_choice_text') {
      const grip = document.createElement('span');
      grip.className = 'trg-grip';
      grip.draggable = true;
      grip.title = '拖动以移动/嵌套';
      grip.textContent = '⠿';
      el.appendChild(grip);

      const pId = def.params.find((p) => p.key === 'text_id');
      const pText = def.params.find((p) => p.key === 'text');
      const pPlacement = def.params.find((p) => p.key === 'placement');
      el.appendChild(document.createTextNode('文本ID：'));
      el.appendChild(renderParamField(node, pId));
      const detail = document.createElement('span');
      detail.className = 'trg-showtext-detail';
      detail.appendChild(document.createTextNode('，内容：'));
      detail.appendChild(renderParamField(node, pText));
      detail.appendChild(document.createTextNode('（位置 '));
      detail.appendChild(renderParamField(node, pPlacement));
      detail.appendChild(document.createTextNode('）'));
      el.appendChild(detail);
      syncShowTextReference(el, node);
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
          // 断言的“改变”谓词不需要预期值；预期值来源按具体值 / gamestate 变量二选一
          if (node.op === 'state_assert') {
            const changed = String(node.params.cmp) === 'changed';
            const byRef = String(node.params.value_mode) === 'gamestate';
            if (part === 'value_mode' && changed) return;
            if (part === 'value' && (changed || byRef)) return;
            if (part === 'value_ref' && (changed || !byRef)) return;
          } else if (node.op === 'declare') {
            const byRef = String(node.params.init_mode) === 'gamestate';
            if (part === 'init' && byRef) return;
            if (part === 'init_ref' && !byRef) return;
          } else if (node.op === 'change') {
            const byRef = String(node.params.param_mode) === 'gamestate';
            if (part === 'param' && byRef) return;
            if (part === 'param_ref' && !byRef) return;
          }
          const param = def.params.find((p) => p.key === part);
          if (param) el.appendChild(renderParamField(node, param));
        }
      });
    }

    if (!def.group && node.cid) {
      const badge = document.createElement('span');
      badge.className = 'trg-cid';
      badge.textContent = node.cid;
      badge.title = '组件编号（可被同触发器的参数引用）';
      el.appendChild(badge);
    }

    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        { label: '复制', action: () => copyNode(node.uid) },
        { label: '删除', action: () => deleteNode(node.uid) },
      ]);
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
    const title = $('trg-editing');
    if (title) title.textContent = `正在编辑：${state.editing.id}`;
    $('trg-kind').value = state.kind;
    renderOpOptions();

    const delayUnit = $('trg-delay-unit');
    const delayAmount = $('trg-delay-amount');
    if (delayUnit) delayUnit.value = state.editing.delay?.unit ?? '';
    if (delayAmount) {
      delayAmount.value = String(state.editing.delay?.amount ?? 1);
      delayAmount.disabled = !state.editing.delay;
    }
    const onceMode = $('trg-once-mode');
    if (onceMode) onceMode.value = state.editing.onceMode === 'once' ? 'once' : 'repeat';

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
    fitAllParams();
  }

  // ==================== 右栏触发器操作 ====================
  /** 新建触发器 id：用户改过就保留，否则始终跟随“当前数量 + 1” */
  function syncNewTriggerId() {
    const input = $('trg-new-id');
    if (!input) return;
    const auto = input.dataset.auto || '';
    if (!input.value || input.value === auto) {
      const next = nextTriggerId();
      input.value = next;
      input.dataset.auto = next;
    }
  }

  function createDraft(folderId = null) {
    const map = Editor.getState().map;
    if (!map) return toast('没有地图，无法创建触发器', 'error');
    ensureFolders(map);
    const id = ($('trg-new-id').value || '').trim() || nextTriggerId();
    if (!id) return toast('请填写触发器 id', 'error');
    if (id.length > 64) return toast('触发器 id 不能超过 64 个字符', 'error');
    if ((map.triggers || []).some((t) => t.id === id)) return toast(`触发器 id「${id}」已存在`, 'error');
    if (state.editing && state.editing.isNew && state.editing.id === id) return;
    const target =
      folderId && state.folders.some((f) => f.id === folderId)
        ? folderId
        : defaultTargetFolder();
    if (target) expandFolderAncestors(target);
    assignTriggerToFolder(id, target);
    startEdit({ id, isNew: true });
    $('trg-new-id').value = '';
    renderManager(); // 预填下一个默认 id
  }

  function startEdit(trigger) {
    if (document.body.classList.contains('mobile')) {
      return toast('窄屏暂不支持脚本编辑，请使用桌面端', 'error');
    }
    const map = Editor.getState().map;
    const isNew = trigger.isNew === true;
    state.editing = {
      ...trigger,
      // 新建默认优先级 = 当前触发器数量（越大越先执行）
      priority: isNew ? (map?.triggers?.length ?? 0) : (trigger.priority ?? 0),
      delay: trigger.delay ? { amount: trigger.delay.amount, unit: trigger.delay.unit } : null,
      onceMode: isNew ? 'once' : (trigger.once === true ? 'once' : 'repeat'),
    };
    resetCidSeq();
    collectRawCids(trigger.when);
    (trigger.effects || []).forEach(collectRawCids);
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
      isNew: false,
      src: JSON.parse(JSON.stringify(t)),
      when: t.when,
      effects: t.effects,
      priority: t.priority ?? 0,
      delay: t.delay ?? null,
      once: t.once === true,
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
    removeTriggerFromFolders(id);
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

  /** 复制组件时，id 类参数统一追加“1”（原参数1） */
  function bumpIdSuffix(value) {
    const v = String(value ?? '');
    return v ? `${v}1` : v;
  }

  function bumpPathId(path) {
    const parsed = StatePaths.parse(path || '');
    if (!parsed) return path;
    const args = { ...parsed.args };
    let changed = false;
    for (const p of parsed.def.params) {
      if (p === 'trigger' || p === 'text' || p === 'var') {
        args[p] = bumpIdSuffix(args[p]);
        changed = true;
      }
    }
    return changed ? StatePaths.fill(parsed.def.template, args) : path;
  }

  function bumpNodeIds(node) {
    const p = node.params;
    if (p) {
      for (const key of ['trigger_id', 'text_id', 'var_id']) {
        const v = p[key];
        if (typeof v === 'string' && v && !(key === 'trigger_id' && v === 'any')) {
          p[key] = bumpIdSuffix(v);
        }
      }
      for (const key of ['path', 'value_ref', 'init_ref', 'param_ref']) {
        if (typeof p[key] === 'string' && p[key]) p[key] = bumpPathId(p[key]);
      }
    }
    for (const [key, arg] of Object.entries(node.filterArgs || {})) {
      if (arg.mode === 'literal' && ['trigger', 'text', 'var'].includes(key)) {
        arg.value = bumpIdSuffix(arg.value);
      } else if (arg.mode === 'state' && arg.path) {
        arg.path = bumpPathId(arg.path);
      }
    }
    for (const ref of Object.values(node.refs || {})) {
      if (ref.mode !== 'condition' && ref.path) ref.path = bumpPathId(ref.path);
    }
    for (const child of node.children || []) bumpNodeIds(child);
  }

  function cloneNodeDeep(node, cidRemap) {
    const copy = {
      uid: nextUid(),
      cid: nextCid(),
      kind: node.kind,
      op: node.op,
      params: { ...(node.params || {}) },
      children: [],
    };
    if (node.cid) cidRemap.set(node.cid, copy.cid);
    if (node.refs) {
      copy.refs = Object.fromEntries(
        Object.entries(node.refs).map(([key, ref]) => [key, { ...ref }]),
      );
    }
    if (node.filterArgs) {
      copy.filterArgs = Object.fromEntries(
        Object.entries(node.filterArgs).map(([key, arg]) => [key, { ...arg }]),
      );
    }
    if (Array.isArray(node.choiceOptions)) copy.choiceOptions = node.choiceOptions.map(String);
    copy.children = (node.children || []).map((child) => cloneNodeDeep(child, cidRemap));
    bumpNodeIds(copy);
    if (copy.op === 'show_text' || copy.op === 'show_choice_text') {
      copy.textIdOrigin = String(copy.params.text_id ?? '');
    }
    return copy;
  }

  /** 复制子树内部的引用改指向复制出来的新编号 */
  function remapNodeCidRefs(node, cidRemap) {
    for (const ref of Object.values(node.refs || {})) {
      if (ref.mode === 'condition' && cidRemap.has(ref.cid)) ref.cid = cidRemap.get(ref.cid);
    }
    for (const arg of Object.values(node.filterArgs || {})) {
      if (arg.mode === 'condition' && cidRemap.has(arg.cid)) arg.cid = cidRemap.get(arg.cid);
    }
    (node.children || []).forEach((child) => remapNodeCidRefs(child, cidRemap));
  }

  function copyNode(uid) {
    const entry = findEntry(uid);
    if (!entry) return;
    const cidRemap = new Map();
    const copy = cloneNodeDeep(entry.node, cidRemap);
    remapNodeCidRefs(copy, cidRemap);
    entry.list.splice(entry.index + 1, 0, copy);
    cancelPick();
    renderEditor();
  }

  function closeContextMenu() {
    const el = $('ctx-menu');
    if (!el) return;
    el.hidden = true;
    el.innerHTML = '';
  }

  function showContextMenu(x, y, items) {
    const el = $('ctx-menu');
    if (!el) return;
    el.innerHTML = '';
    for (const item of items) {
      if (item.separator) {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        el.appendChild(sep);
        continue;
      }
      if (item.heading) {
        const head = document.createElement('div');
        head.className = 'ctx-label';
        head.textContent = item.label;
        el.appendChild(head);
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = item.label;
      if (item.disabled) btn.disabled = true;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeContextMenu();
        item.action?.();
      });
      el.appendChild(btn);
    }
    el.hidden = false;
    el.style.left = '0px';
    el.style.top = '0px';
    const rect = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 8))}px`;
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

  function clearPickZones() {
    (state.pickZones || []).forEach((el) => el.classList.remove('pick-zone'));
    state.pickZones = [];
  }

  function activateRightTab(name) {
    document.querySelectorAll('.tabs [data-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === name);
    });
    document.querySelectorAll('.tab-page').forEach((p) => {
      p.hidden = p.id !== `tab-${name}`;
    });
  }

  function markPickZones(type) {
    clearPickZones();
    const els = [];
    if (type === 'tile' || type === 'terrain') els.push($('canvas-wrap'));
    else if (type === 'force') els.push($('right'), $('player-list'));
    else if (type === 'trigger' || type === 'textId' || type === 'varId') els.push($('right'), $('trigger-list'));
    state.pickZones = els.filter(Boolean);
    state.pickZones.forEach((el) => el.classList.add('pick-zone'));
    if (type === 'force') activateRightTab('players');
    else if (type === 'trigger' || type === 'textId' || type === 'varId') activateRightTab('triggers');
  }

  function setPick(node, param, anchor, placement = false) {
    if (state.pick?.anchor) state.pick.anchor.classList.remove('picking');
    state.pick = null;
    clearPickZones();
    state.pick = { node, key: param.key, type: param.type, param, anchor, label: param.label, placement };
    anchor.classList.add('picking');
    const where =
      param.type === 'tile'
        ? '棋盘地块'
        : param.type === 'terrain'
          ? '棋盘地块（取其地形）'
          : param.type === 'force'
            ? '右侧「势力」列表中的势力'
            : param.type === 'textId'
              ? '右侧「触发器」列表中的触发器（取其文本）'
              : param.type === 'varId'
                ? '右侧「触发器」列表中的触发器（取其数字变量）'
                : '右侧「触发器」列表中的触发器';
    setHint(`点击${where}填充「${param.label}」；也可以直接从选项中选择，点其他位置取消。`);
    markPickZones(param.type);
  }

  /** 通用拾取：不带编辑节点，选中值交给 onValue，结束后调用 onSettled */
  function armPick(opts) {
    if (state.pick?.anchor) state.pick.anchor.classList.remove('picking');
    state.pick = null;
    clearPickZones();
    state.pick = {
      type: opts.type,
      label: opts.label,
      onValue: opts.onValue,
      onSettled: opts.onSettled,
      anchor: null,
      param: null,
      key: null,
      node: null,
    };
    markPickZones(opts.type);
    const where =
      opts.type === 'tile' || opts.type === 'terrain'
        ? '棋盘地块'
        : opts.type === 'force'
          ? '右侧「势力」列表中的势力'
          : '右侧「触发器」列表中的触发器';
    setHint(`点击${where}填充「${opts.label}」；任意点击后返回。`);
  }

  function cancelPick() {
    const pick = state.pick;
    if (pick?.anchor) pick.anchor.classList.remove('picking');
    state.pick = null;
    clearPickZones();
    if (pick?.onSettled) {
      pick.onSettled();
      return;
    }
    if (state.editing) setHint(defaultHint());
  }

  /** 某触发器里的显示文本列表（用于 hide_text 的 text_id 拾取） */
  function triggerTextsFor(triggerId) {
    const map = Editor.getState().map;
    const editingId = state.editing?.id;
    let effects = null;
    if (editingId && triggerId === editingId) {
      effects = state.eff.map((n) => ({
        op: n.op,
        text_id: n.params?.text_id,
        text: n.params?.text,
      }));
    } else {
      const t = (map?.triggers || []).find((x) => x.id === triggerId);
      effects = t ? t.effects : null;
    }
    const out = [];
    for (const e of effects || []) {
      if (e && (e.op === 'show_text' || e.op === 'show_choice_text') && e.text_id) {
        out.push({ id: String(e.text_id), text: String(e.text || '') });
      }
    }
    return out;
  }

  /** 点击触发器填充文本 id；多个文本时弹出选择框 */
  function pickTextFromTrigger(triggerId) {
    const texts = triggerTextsFor(triggerId);
    if (!texts.length) return toast('该触发器没有显示文本', 'error');
    if (texts.length === 1) {
      fillPick(texts[0].id);
      closeParamPop();
      return;
    }
    const dlg = $('dlg-pick-text');
    const title = dlg.querySelector('h3');
    if (title) title.textContent = '选择文本';
    const list = $('pick-text-list');
    list.innerHTML = '';
    for (const t of texts) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pick-text-item';
      b.innerHTML = `<span class="pick-text-id">${esc(t.id)}</span><span class="pick-text-preview">${esc(t.text || '（空文本）')}</span>`;
      b.addEventListener('click', () => {
        fillPick(t.id);
        dlg.close();
        closeParamPop();
      });
      list.appendChild(b);
    }
    dlg.showModal();
  }

  /** 某触发器里声明的数字变量 id（用于 change 的 var_id 拾取） */
  function triggerVarsFor(triggerId) {
    const map = Editor.getState().map;
    const editingId = state.editing?.id;
    let effects = null;
    if (editingId && triggerId === editingId) {
      effects = state.eff.map((n) => ({ op: n.op, var_id: n.params?.var_id }));
    } else {
      const t = (map?.triggers || []).find((x) => x.id === triggerId);
      effects = t ? t.effects : null;
    }
    const out = [];
    for (const e of effects || []) {
      if (e && e.op === 'declare' && e.var_id) {
        const id = String(e.var_id);
        if (!out.includes(id)) out.push(id);
      }
    }
    return out;
  }

  /** 点击触发器填充数字变量 id；多个变量时弹出选择框 */
  function pickVarFromTrigger(triggerId) {
    const vars = triggerVarsFor(triggerId);
    if (!vars.length) return toast('该触发器没有数字变量', 'error');
    if (vars.length === 1) {
      fillPick(vars[0]);
      closeParamPop();
      return;
    }
    const dlg = $('dlg-pick-text');
    const title = dlg.querySelector('h3');
    if (title) title.textContent = '选择数字变量';
    const list = $('pick-text-list');
    list.innerHTML = '';
    for (const id of vars) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pick-text-item';
      b.innerHTML = `<span class="pick-text-id">${esc(id)}</span><span class="pick-text-preview">数字变量</span>`;
      b.addEventListener('click', () => {
        fillPick(id);
        dlg.close();
        closeParamPop();
      });
      list.appendChild(b);
    }
    dlg.showModal();
  }

  function fillPick(value) {
    const pick = state.pick;
    if (!pick) return;
    if (pick.onValue) {
      const cb = pick.onValue;
      const settle = pick.onSettled;
      state.pick = null;
      clearPickZones();
      cb(String(value));
      if (settle) settle();
      return;
    }
    const str = pick.placement ? `tile:${value}` : String(value);
    pick.node.params[pick.key] = str;
    if (pick.anchor && pick.anchor.isConnected) {
      if (pick.anchor.tagName === 'INPUT') pick.anchor.value = String(value);
      else updateControlLabel(pick.anchor, pick.param, str);
      pick.anchor.classList.add('picking');
    }
    if (
      (pick.node.op === 'show_text' || pick.node.op === 'show_choice_text') &&
      pick.key === 'text_id'
    ) {
      syncAllShowTextReuse();
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
    const textRenames = collectTextIdRenames();
    const editing = state.editing;
    const map = Editor.getState().map;
    if (editing.isNew && (map.triggers || []).some((t) => t.id === editing.id)) {
      const msg = `触发器 id「${editing.id}」已存在`;
      setHint(msg, true);
      return toast(msg, 'error');
    }
    const folderId = editing.isNew
      ? folderOfTrigger(editing.id) || defaultTargetFolder()
      : null;
    closeEditor();
    if (editing.isNew) assignTriggerToFolder(editing.id, folderId);
    Editor.commit((m) => {
      // 文本 id 改名：同步其他触发器里的 show_text / hide_text / 断言与文本占位符
      for (const t of m.triggers || []) applyTextIdRenamesToTrigger(t, textRenames);
      applyTextIdRenamesToTrigger(trigger, textRenames);
      m.triggers = Array.isArray(m.triggers) ? m.triggers.slice() : [];
      if (editing.isNew) {
        m.triggers.push(trigger);
        orderMapTriggers(m);
      } else {
        const i = m.triggers.findIndex((t) => t.id === editing.id);
        if (i >= 0) m.triggers[i] = trigger;
        else m.triggers.push(trigger);
      }
      m.trigger_schema_version = 2;
    });
    renderManager();
    toast(
      textRenames.size
        ? `已提交触发器「${editing.id}」，并同步 ${textRenames.size} 个文本 id 的引用`
        : `已提交触发器「${editing.id}」`,
    );
  }

  // ==================== 事件绑定 ====================
  function bind() {
    $('btn-trg-create')?.addEventListener('click', () => createDraft());
    $('btn-trg-folder')?.addEventListener('click', () => {
      const map = Editor.getState().map;
      if (!map) return toast('没有地图，无法创建文件夹', 'error');
      ensureFolders(map);
      createFolder();
      renderManager();
    });
    $('trg-new-id')?.addEventListener('input', (e) => {
      const input = e.currentTarget;
      if (input.value !== (input.dataset.auto || '')) delete input.dataset.auto;
    });
    $('order-editor-submit')?.addEventListener('click', submitOrderEditor);
    $('order-editor-cancel')?.addEventListener('click', () => {
      $('dlg-order-editor').close();
      orderEditorNode = null;
    });
    $('dlg-order-editor-close')?.addEventListener('click', () => {
      $('dlg-order-editor').close();
      orderEditorNode = null;
    });
    $('dlg-order-editor')?.addEventListener('close', () => {
      orderEditorNode = null;
    });
    $('dlg-pick-text-close')?.addEventListener('click', () => {
      $('dlg-pick-text').close();
    });
    $('dlg-pick-text')?.addEventListener('close', () => {
      const title = $('dlg-pick-text')?.querySelector('h3');
      if (title) title.textContent = '选择文本';
      cancelPick();
    });
    $('te-insert')?.addEventListener('click', insertStateToken);
    $('te-submit')?.addEventListener('click', submitTextEditor);
    $('te-choice-add')?.addEventListener('click', () => {
      if (!textEditor?.isChoice) return;
      textEditor.options.push('');
      renderChoiceOptions();
      const inputs = $('te-choice-list').querySelectorAll('.te-choice-input');
      const last = inputs[inputs.length - 1];
      if (last) {
        textEditor.lastInput = last;
        last.focus();
      }
    });
    $('dlg-text-editor')?.addEventListener('focusin', (e) => {
      if (!textEditor) return;
      const target = e.target;
      if (target === $('te-text') || target.classList?.contains('te-choice-input')) {
        textEditor.lastInput = target;
      }
    });
    $('te-cancel')?.addEventListener('click', () => {
      $('dlg-text-editor').close();
      textEditor = null;
    });
    $('dlg-text-editor-close')?.addEventListener('click', () => {
      $('dlg-text-editor').close();
      textEditor = null;
    });
    // 注意：拾取值时也会 close()，这里不能用 close 事件清空 textEditor，
    // 否则恢复弹窗时拿不到当前编辑的节点；只处理 Esc 取消。
    $('dlg-text-editor')?.addEventListener('cancel', () => {
      textEditor = null;
    });
    $('btn-trg-add')?.addEventListener('click', addComponent);
    $('btn-trg-submit')?.addEventListener('click', submit);
    $('btn-trg-cancel')?.addEventListener('click', () => closeEditor());
    $('trg-kind')?.addEventListener('change', () => {
      state.kind = $('trg-kind').value;
      renderOpOptions();
    });
    $('trg-delay-unit')?.addEventListener('change', () => {
      if (!state.editing) return;
      const unit = $('trg-delay-unit').value;
      const amountEl = $('trg-delay-amount');
      if (unit === 'intent' || unit === 'turn' || unit === 'round') {
        const amount = Math.max(1, Math.round(Number(amountEl.value) || 1));
        amountEl.value = String(amount);
        amountEl.disabled = false;
        state.editing.delay = { amount, unit };
      } else {
        amountEl.disabled = true;
        state.editing.delay = null;
      }
    });
    $('trg-delay-amount')?.addEventListener('input', () => {
      if (!state.editing?.delay) return;
      const v = Math.round(Number($('trg-delay-amount').value));
      if (Number.isInteger(v) && v > 0) state.editing.delay.amount = v;
    });
    $('trg-delay-amount')?.addEventListener('change', () => {
      if (!state.editing?.delay) return;
      const amount = Math.max(1, Math.round(Number($('trg-delay-amount').value) || 1));
      $('trg-delay-amount').value = String(amount);
      state.editing.delay.amount = amount;
    });
    $('trg-once-mode')?.addEventListener('change', () => {
      if (!state.editing) return;
      state.editing.onceMode = $('trg-once-mode').value === 'once' ? 'once' : 'repeat';
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
        } else if (state.pick.type === 'textId' && item) {
          e.preventDefault();
          e.stopPropagation();
          pickTextFromTrigger(item.dataset.triggerId);
          closeParamPop();
        } else if (state.pick.type === 'varId' && item) {
          e.preventDefault();
          e.stopPropagation();
          pickVarFromTrigger(item.dataset.triggerId);
          closeParamPop();
        } else {
          cancelPick();
        }
        return;
      }
      if (!item) return;
      const act = e.target.closest('button')?.dataset.act;
      if (act === 'edit') {
        // 草稿尚未写入地图：再次点“编辑”直接回到当前编辑区
        if (state.editing?.isNew && state.editing.id === item.dataset.triggerId) renderEditor();
        else editTrigger(item.dataset.triggerId);
      } else if (act === 'rename') renameTrigger(item.dataset.triggerId);
      else if (act === 'del') deleteTrigger(item.dataset.triggerId);
    });

    // 触发器列表空白处右键：新建文件夹
    $('trigger-list')?.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.trg-item') || e.target.closest('.trg-folder')) return;
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        {
          label: '新建文件夹',
          action: () => {
            const map = Editor.getState().map;
            if (!map) return;
            ensureFolders(map);
            createFolder();
            renderManager();
          },
        },
      ]);
    });
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest('#ctx-menu')) closeContextMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeContextMenu();
    });
    window.addEventListener('blur', closeContextMenu);
    window.addEventListener('scroll', closeContextMenu, true);
    $('ctx-menu')?.addEventListener('contextmenu', (e) => e.preventDefault());
    // 脚本编辑区空白处也屏蔽浏览器默认右键菜单
    $('trg-editor')?.addEventListener('contextmenu', (e) => {
      if (!e.defaultPrevented) e.preventDefault();
    });

    // 触发器列表：优先级编辑（越大越先执行；默认新建时为当前数量）
    $('trigger-list')?.addEventListener('change', (e) => {
      const input = e.target.closest('.trg-priority-input');
      if (!input) return;
      const item = input.closest('.trg-item');
      const id = item?.dataset.triggerId;
      if (!id) return;
      const value = Number(input.value);
      const priority = Number.isInteger(value) ? value : 0;
      input.value = String(priority);
      if (state.editing && state.editing.id === id) {
        state.editing.priority = priority;
        if (state.editing.isNew) return; // 草稿提交时才写入地图
      }
      Editor.commit((m) => {
        const t = (m.triggers || []).find((x) => x.id === id);
        if (t) t.priority = priority;
      });
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
  const editorRoot = $('trg-editor');
  if (editorRoot) {
    new MutationObserver(() => fitAllParams()).observe(editorRoot, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }
  renderManager();
  renderEditor();
  Editor.onUI(onMapUI);

  return { handleBoardClick, refresh: onMapUI };
})();
