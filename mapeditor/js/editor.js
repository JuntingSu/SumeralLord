/**
 * editor.js — 编辑器状态机：画笔/撤销重做/批量操作
 * 通过 onCanvas / onUI 订阅通知（main.js 注册渲染）。
 */
const Editor = (() => {
  const state = {
    map: null,
    id: 'map_new',
    tool: 'paint', // 'paint' | 'pan' | 'script' | 'random'
    brush: {
      terrain: MapConst.TERRAIN.PLAIN,
      owner: MapConst.TILE_OWNER.EMPTY,
      strength: MapConst.DEFAULT_STRENGTH,
      mode: 'all', // 'all' | 'terrain' | 'strength'
    },
    view: { zoom: 1, panX: 0, panY: 0 },
    hover: -1,
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

  /** 含触发器的地图做结构性编辑前提醒：tile/seat 引用可能失效 */
  function confirmStructuralEdit(map, action) {
    if (!map || !Array.isArray(map.triggers) || map.triggers.length === 0) return true;
    return window.confirm(
      `该地图包含 ${map.triggers.length} 个触发器。${action}会改变地块坐标或势力编号，可能使触发器引用失效。仍要继续吗？`,
    );
  }
  function getState() { return state; }

  function setMap(map, id) {
    state.map = map;
    state.id = id || 'map_new';
    state.undoStack = [];
    state.redoStack = [];
    state.hover = -1;
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
    refreshCanvas();
    refreshUI();
  }

  function redo() {
    if (!state.map || state.redoStack.length === 0) return;
    state.undoStack.push(JSON.parse(JSON.stringify(state.map)));
    state.map = state.redoStack.pop();
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
    if (!confirmStructuralEdit(state.map, '调整行列')) return;
    pushUndo();
    MapData.resizeMap(state.map, delta);
    refreshCanvas();
    refreshUI();
  }

  function generateMap(opts) {
    const map = Generator.generate(opts);
    map.author = MapData.defaultAuthor();
    setMap(map, MapData.randomId());
  }

  function addPlayer() {
    if (!state.map) return;
    if (!confirmStructuralEdit(state.map, '新增势力')) return;
    pushUndo();
    MapData.addPlayer(state.map);
    refreshCanvas();
    refreshUI();
  }

  function removePlayer(seat) {
    if (!state.map) return;
    if (!confirmStructuralEdit(state.map, '删除势力')) return;
    pushUndo();
    MapData.removePlayer(state.map, seat);
    refreshCanvas();
    refreshUI();
  }

  /** 调整势力座次（供拖动手柄使用；调用方负责先 pushUndo 一次） */
  function moveSeat(seat, target) {
    if (!state.map) return;
    if (!confirmStructuralEdit(state.map, '调整势力座次')) return;
    MapData.movePlayerSeat(state.map, seat, target);
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

  function setTool(tool) {
    state.tool = tool;
    refreshCanvas();
    refreshUI();
  }

  function setBrush(partial) {
    Object.assign(state.brush, partial);
    refreshUI();
  }

  return {
    state, getState, onCanvas, onUI, setMap, undo, redo,
    pushUndo, paintStart, paintDrag, paintEnd,
    setHover, setView, resize, generateMap, addPlayer, removePlayer, moveSeat,
    commit, setTool, setBrush,
  };
})();
