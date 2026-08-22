/**
 * players.js — 势力列表表格渲染
 * 按 seat 自动排序；seat 只读显示在最左；每次结构性变化整表重绘；actions 由 main.js 注入。
 */
const Players = (() => {
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /**
   * actions: {
   *   onPlayerField(fn),   // 记录撤销后执行 fn(map)，然后整体刷新
   *   onRemove(seat),
   * }
   */
  function render(container, map, actions) {
    container.innerHTML = '';
    if (!map || !Array.isArray(map.player_list)) return;
    const list = map.player_list.slice().sort((a, b) => a.seat - b.seat);

    list.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'prow';
      row.innerHTML = `
        <span class="p-seat" title="座次（按座次排序，不可修改）">${p.seat}</span>
        <span class="swatch" title="旗帜 ${p.flag}" style="background:${MapConst.flagColor(p.flag)}"></span>
        <input class="p-name" value="${esc(p.name)}" placeholder="名称" title="势力名称">
        <label class="p-num">队<input class="p-team" type="number" min="1" max="32" value="${p.team}"></label>
        <select class="p-ai" title="电脑难度">${MapConst.AI_LEVELS.map((l) => `<option value="${l}" ${l === p.computer ? 'selected' : ''}>${MapConst.AI_LABELS[l]}</option>`).join('')}</select>
        <label class="p-num">旗<input class="p-flag" type="number" min="0" value="${p.flag}"></label>
        <button class="p-del" title="删除势力（战场该座次格子一并清理）">✕</button>
      `;
      container.appendChild(row);

      const q = (sel) => row.querySelector(sel);

      q('.p-name').addEventListener('change', (e) => {
        actions.onPlayerField((m) => { p.name = e.target.value.trim() || p.name; });
      });
      q('.p-team').addEventListener('change', (e) => {
        const v = Math.max(1, Math.min(32, Math.round(Number(e.target.value) || 1)));
        actions.onPlayerField((m) => { p.team = v; });
      });
      q('.p-ai').addEventListener('change', (e) => {
        actions.onPlayerField((m) => { p.computer = Number(e.target.value); });
      });
      q('.p-flag').addEventListener('change', (e) => {
        const v = Math.max(0, Math.round(Number(e.target.value) || 0));
        actions.onPlayerField((m) => { p.flag = v; });
      });
      q('.p-del').addEventListener('click', () => actions.onRemove(p.seat));
    });
  }

  return { render };
})();
