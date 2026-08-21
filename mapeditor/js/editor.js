/**
 * editor.js — 编辑器状态机：画笔/出生点/框选/复制粘贴/撤销重做/批量操作
 * 通过 onCanvas / onUI 订阅通知（main.js 注册渲染）。
 */
const Editor = (() => {
  const state = {
    map: null,
    id: 'map_new',
    tool: 'paint', // 'paint' | 'city' | 'select' | 'paste' | 'pan'
    brush: {
      terrain: MapConst.TERRAIN.PLAIN,
      owner: MapConst.TILE_OWNER.EMPTY,
      strength: MapConst.DEFAULT_STRENGTH,
      mode: 'all', // 'all' | 'terrain' | 'strength'
      seat: 1,
    },
    view: { zoom: 1, panX: 0, panY: 0 },
    selected: -1,
    hover: -1,
    selection: null, // {r0,c0,r1,c1}
    clipboard: null, // {w,h,cells}
    pasteAnchor: -1,
    undoStack: [],
    redoStack: [],
    dirty: false,
  };

  const _canvas = new Set();
  const _ui = new Set();
  let _lastPaintIndex = -1;

  function onCanvas(fn) { _canvas.add(fn); return () => _canvas.delete(fn); }
  function onUI(fn) { _ui.add(fn); return () => _ui.delete(fn); }
  function refreshCanvas() { _canvas.forEach((fn) => fn(state)); }
  function refreshUI() { _ui.forEach((fn) => fn(state)); }
  function getState() { return state; }

  function setMap(map, id) {
    state.map = map;
    state.id = id || 'map_new';
    state.undoStack = [];
    state.redoStack = [];
    state.selected = -1;
    state.hover = -1;
    state.selection = null;
    state.clipboard = null;
    state.pasteAnchor = -1;
    state.dirty = false;
    refreshCanvas();
    refreshUI();
  }

  function pushUndo() {
    if (!state.map) return;
    state.undoStack.push(JSON.parse(JSON.stringify(state.map)));
    if (state.undoStack.length > 50) state.undoStack.shift();
    state.redoStack = [];
    state.dirty = true;
  }

  function undo() {
    if (!state.map || state.undoStack.length === 0) return;
    state.redoStack.push(JSON.parse(JSON.stringify(state.map)));
    state.map = state.undoStack.pop();
    state.selected = -1;
    state.selection = null;
    state.pasteAnchor = -1;
    refreshCanvas();
    refreshUI();
  }

  function redo() {
    if (!state.map || state.redoStack.length === 0) return;
    state.undoStack.push(JSON.parse(JSON.stringify(state.map)));
    state.map = state.redoStack.pop();
    state.selected = -1;
    state.selection = null;
    state.pasteAnchor = -1;
    refreshCanvas();
    refreshUI();
  }

  // ---------- 画笔 ----------
  /** 规则联动：山地/虚空不可驻兵（强制无主+0 兵力）；无主强制 0 兵力 */
  function applyBrush(index) {
    const b = state.brush;
    const tile = state.map.battlefield[index];
    let t = tile[0];
    let o = tile[1];
    let s = tile[2];
    if (b.mode === 'all' || b.mode === 'terrain') t = b.terrain;
    if (b.mode === 'all' || b.mode === 'strength') {
      o = b.owner;
      s = b.strength;
    }
    if (MapConst.NO_SOLDIER_TERRAIN.has(t)) {
      o = MapConst.TILE_OWNER.EMPTY;
      s = 0;
    }
    if (o === MapConst.TILE_OWNER.EMPTY) s = 0;
    state.map.battlefield[index] = [t, o, s];
  }

  function paintStart(index) {
    if (!state.map || index < 0) return;
    pushUndo();
    applyBrush(index);
    _lastPaintIndex = index;
    refreshCanvas();
  }

  function paintDrag(index) {
    if (!state.map || index < 0 || index === _lastPaintIndex) return;
    applyBrush(index);
    _lastPaintIndex = index;
    refreshCanvas();
  }

  function paintEnd() {
    _lastPaintIndex = -1;
    refreshUI();
  }

  // ---------- 出生点 ----------
  function placeCity(index) {
    if (!state.map || index < 0) return;
    pushUndo();
    MapData.moveBirthPoint(state.map, state.brush.seat, index);
    refreshCanvas();
    refreshUI();
  }

  // ---------- 框选 / 复制 / 粘贴 ----------
  function selectionFromIndexes(a, b) {
    const col = state.map.column;
    const ra = Math.floor(a / col);
    const ca = a % col;
    const rb = Math.floor(b / col);
    const cb = b % col;
    state.selection = {
      r0: Math.min(ra, rb),
      c0: Math.min(ca, cb),
      r1: Math.max(ra, rb),
      c1: Math.max(ca, cb),
    };
  }

  function startSelect(index) {
    if (!state.map || index < 0) return;
    state.selected = index;
    selectionFromIndexes(index, index);
    refreshCanvas();
  }

  function selectDrag(index) {
    if (!state.map || index < 0) return;
    state.selected = index;
    selectionFromIndexes(state.selected, index);
    refreshCanvas();
  }

  function endSelect() {
    refreshUI();
  }

  function copySelection() {
    const sel = state.selection;
    if (!state.map || !sel || sel.r0 < 0) return;
    const w = sel.c1 - sel.c0 + 1;
    const h = sel.r1 - sel.r0 + 1;
    const cells = [];
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const idx = (sel.r0 + j) * state.map.column + (sel.c0 + i);
        cells.push(state.map.battlefield[idx].slice());
      }
    }
    state.clipboard = { w, h, cells };
    refreshUI();
  }

  /** 计算粘贴 ghost（anchor 为左上角所在格；越界部分跳过） */
  function ghostForAnchor(anchor) {
    if (!state.map || !state.clipboard || anchor < 0) return null;
    const col = state.map.column;
    const ar = Math.floor(anchor / col);
    const ac = anchor % col;
    const indices = [];
    const cells = [];
    for (let j = 0; j < state.clipboard.h; j++) {
      for (let i = 0; i < state.clipboard.w; i++) {
        const r = ar + j;
        const c = ac + i;
        if (r >= 0 && r < state.map.row && c >= 0 && c < state.map.column) {
          indices.push(r * col + c);
          cells.push(state.clipboard.cells[j * state.clipboard.w + i]);
        }
      }
    }
    return { indices, cells };
  }

  function pasteAt(anchor) {
    if (!state.map || !state.clipboard || anchor < 0) return;
    const ghost = ghostForAnchor(anchor);
    if (!ghost || ghost.indices.length === 0) return;
    pushUndo();
    for (let k = 0; k < ghost.indices.length; k++) {
      state.map.battlefield[ghost.indices[k]] = ghost.cells[k].slice();
    }
    state.pasteAnchor = -1;
    refreshCanvas();
    refreshUI();
  }

  // ---------- 视图 ----------
  function setHover(index) {
    if (state.hover === index) return;
    state.hover = index;
    refreshCanvas();
  }

  function setView(partial) {
    Object.assign(state.view, partial);
    refreshCanvas();
  }

  // ---------- 批量操作 ----------
  function resize(delta) {
    if (!state.map) return;
    pushUndo();
    MapData.resizeMap(state.map, delta);
    state.selected = -1;
    state.selection = null;
    refreshCanvas();
    refreshUI();
  }

  function generateMap(opts) {
    const map = Generator.generate(opts);
    setMap(map, 'map_random');
  }

  function addPlayer() {
    if (!state.map) return;
    pushUndo();
    MapData.addPlayer(state.map);
    refreshCanvas();
    refreshUI();
  }

  function removePlayer(seat) {
    if (!state.map) return;
    pushUndo();
    MapData.removePlayer(state.map, seat);
    refreshCanvas();
    refreshUI();
  }

  function reorderPlayer(i, dir) {
    if (!state.map) return;
    const list = state.map.player_list;
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    pushUndo();
    [list[i], list[j]] = [list[j], list[i]];
    refreshCanvas();
    refreshUI();
  }

  /** 信息/势力字段提交：记录一次撤销后执行 fn(map) */
  function commit(fn) {
    if (!state.map) return;
    pushUndo();
    fn(state.map);
    refreshCanvas();
    refreshUI();
  }

  function updateId(id) {
    state.id = id || 'map_new';
    refreshUI();
  }

  function setTool(tool) {
    state.tool = tool;
    if (tool !== 'paste') state.pasteAnchor = -1;
    if (tool !== 'select') {
      state.selected = -1;
      state.selection = null;
    }
    refreshCanvas();
    refreshUI();
  }

  function setBrush(partial) {
    Object.assign(state.brush, partial);
    refreshUI();
  }

  return {
    state, getState, onCanvas, onUI, setMap, undo, redo,
    paintStart, paintDrag, paintEnd, placeCity,
    startSelect, selectDrag, endSelect, copySelection, pasteAt, ghostForAnchor,
    setHover, setView, resize, generateMap, addPlayer, removePlayer, reorderPlayer,
    commit, updateId, setTool, setBrush,
  };
})();
