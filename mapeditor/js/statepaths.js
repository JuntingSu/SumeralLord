/**
 * statepaths.js — gamestate 路径表（编辑器副本）
 * 与 packages/shared/src/game/trigger/state.ts 的 STATE_PATH_DEFS 保持一致；
 * 纯 JS 无法直接 import TS，因此这里维护一份，并由 shared 的契约测试比对。
 */
const StatePaths = (() => {
  const GROUPS = {
    global: '全局',
    force: '势力',
    tile: '地块',
    fog: '迷雾',
    trigger: '触发器',
    text: '文本',
    var: '变量',
  };

  const D = (template, label, group, kind, params = [], nullable = false) => ({
    template,
    label,
    group,
    kind,
    params,
    nullable,
  });

  const DEFS = [
    D('gamestate.turn', '当前回合', 'global', 'int'),
    D('gamestate.phase', '当前阶段', 'global', 'phase'),
    D('gamestate.currentSeat', '当前行动势力', 'global', 'seat'),
    D('gamestate.controlledSeat', '玩家控制势力', 'global', 'seat', [], true),
    D('gamestate.finished', '对局是否结束', 'global', 'bool'),
    D('gamestate.winningTeam', '获胜队伍', 'global', 'int', [], true),
    D('gamestate.intentSeq', '意图计数', 'global', 'int'),
    D('gamestate.turnSeq', '结束回合计数', 'global', 'int'),
    D('gamestate.lastIntentType', '上一个意图', 'global', 'intent', [], true),
    D('gamestate.forces.{seat}.alive', '势力存活', 'force', 'bool', ['seat']),
    D('gamestate.forces.{seat}.exists', '势力存在', 'force', 'bool', ['seat']),
    D('gamestate.forces.{seat}.points', '势力点数', 'force', 'int', ['seat']),
    D('gamestate.forces.{seat}.team', '势力队伍', 'force', 'int', ['seat']),
    D('gamestate.forces.{seat}.name', '势力名称', 'force', 'text', ['seat']),
    D('gamestate.forces.{seat}.flag', '势力旗帜', 'force', 'int', ['seat']),
    D('gamestate.forces.{seat}.computer', '势力 AI 难度', 'force', 'difficulty', ['seat']),
    D('gamestate.tiles.{tile}.terrain', '地块地形', 'tile', 'terrain', ['tile']),
    D('gamestate.tiles.{tile}.soldier.exists', '地块是否有兵', 'tile', 'bool', ['tile']),
    D('gamestate.tiles.{tile}.soldier.owner', '地块守军归属', 'tile', 'owner', ['tile'], true),
    D('gamestate.tiles.{tile}.soldier.strength', '地块守军兵力', 'tile', 'int', ['tile'], true),
    D('gamestate.tiles.{tile}.soldier.isLinked', '地块守军是否连兵', 'tile', 'bool', ['tile'], true),
    D('gamestate.tiles.{tile}.soldier.hasMovement', '地块守军是否有移动力', 'tile', 'bool', ['tile'], true),
    D('gamestate.fogOverrides.enabled', '迷雾覆盖是否开启', 'fog', 'bool', [], true),
    D('gamestate.triggerRuntime.firedCounts.{trigger}', '触发器已触发次数', 'trigger', 'int', ['trigger']),
    D('gamestate.texts.{text}.visible', '文本状态', 'text', 'textVisible', ['text']),
    D('gamestate.texts.{text}.option', '已选选项', 'text', 'int', ['text']),
    D('gamestate.vars.{var}', '数字变量', 'var', 'int', ['var']),
  ];

  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function compileTemplate(template) {
    const parts = template.split(/(\{seat\}|\{tile\}|\{trigger\}|\{text\}|\{var\})/);
    let pattern = '^';
    for (const part of parts) {
      if (part === '{seat}' || part === '{tile}') pattern += '([^.]+)';
      else if (part === '{trigger}' || part === '{text}' || part === '{var}') pattern += '(.+)';
      else pattern += escapeRegExp(part);
    }
    return new RegExp(pattern + '$');
  }

  const COMPILED = DEFS.map((def) => ({ def, re: compileTemplate(def.template) }));

  function parse(path) {
    for (const { def, re } of COMPILED) {
      const m = re.exec(String(path || ''));
      if (!m) continue;
      const args = {};
      def.params.forEach((p, i) => { args[p] = m[i + 1]; });
      return { def, args };
    }
    return null;
  }

  function fill(template, args) {
    return template.replace(/\{(seat|tile|trigger|text|var)\}/g, (_, key) => String(args[key] ?? ''));
  }

  function validatePath(path, ctx) {
    const parsed = parse(path);
    if (!parsed) return false;
    for (const param of parsed.def.params) {
      const raw = parsed.args[param];
      if (param === 'seat') {
        if (raw === 'player') continue;
        const n = Number(raw);
        if (!Number.isInteger(n) || !ctx.seats.has(n)) return false;
      } else if (param === 'tile') {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0 || n >= ctx.total) return false;
      } else if (param === 'trigger') {
        if (!ctx.ids.has(raw)) return false;
      } else if (param === 'text') {
        if (!(ctx.texts ?? new Set()).has(raw)) return false;
      } else if (param === 'var') {
        if (!(ctx.vars ?? new Set()).has(raw)) return false;
      }
    }
    return true;
  }

  const TOKEN_RE = /\{gamestate\.([^{}]+)\}/g;

  function tokens(text) {
    const out = [];
    for (const m of String(text || '').matchAll(TOKEN_RE)) out.push(`gamestate.${m[1]}`);
    return out;
  }

  function validateText(text, ctx) {
    return tokens(text).every((path) => validatePath(path, ctx));
  }

  const PHASES = ['PREPARE', 'ACTION', 'ADD_POINT', 'END'];
  const TERRAINS = [0, 1, 3, 4, 5];
  const DIFFICULTIES = [1, 2, 3, 255];
  /** 意图类型（“上一个意图”断言的预期值） */
  const INTENTS = ['MOVE', 'ATTACK', 'ADD_POINT', 'SWITCH_PHASE', 'SURRENDER', 'CHOOSE_TEXT'];
  const INTENT_LABELS = {
    MOVE: '移动',
    ATTACK: '进攻',
    ADD_POINT: '加点',
    SWITCH_PHASE: '切换阶段',
    SURRENDER: '投降',
    CHOOSE_TEXT: '选择选项',
  };

  function validateValue(path, value, ctx) {
    const parsed = parse(path);
    if (!parsed) return false;
    const def = parsed.def;
    if (value === null) return !!def.nullable || def.kind === 'owner';
    switch (def.kind) {
      case 'int':
        return typeof value === 'number' && Number.isInteger(value);
      case 'bool':
        return typeof value === 'boolean';
      case 'text':
        return typeof value === 'string';
      case 'phase':
        return typeof value === 'string' && PHASES.includes(value);
      case 'terrain':
        return typeof value === 'number' && TERRAINS.includes(value);
      case 'difficulty':
        return typeof value === 'number' && DIFFICULTIES.includes(value);
      case 'seat':
        return value === 'player' || (typeof value === 'number' && ctx.seats.has(value));
      case 'owner':
        return (
          value === 'player' ||
          (typeof value === 'number' && (value === 0 || value === 255 || ctx.seats.has(value)))
        );
      case 'intent':
        return typeof value === 'string' && INTENTS.includes(value);
      case 'textVisible':
        return typeof value === 'boolean';
      default:
        return false;
    }
  }

  return { GROUPS, DEFS, INTENTS, INTENT_LABELS, parse, fill, validatePath, validateValue, tokens, validateText };
})();
