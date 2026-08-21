/**
 * players.js — 势力列表表格渲染
 * 每次结构性变化（增/删/排序/字段提交）整表重绘；actions 由 main.js 注入。
 */
const Players = (() => {
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /**
   * actions: {
   *   onPlayerField(fn),   // 记录撤销后执行 fn(map)，然后整体刷新
   *   onReorder(i, dir),   // 上移/下移（-1/+1）
   *   onRemove(seat),
   * }
   */
  function render(container, map, actions) {
    container.innerHTML = '';
    if (!map || !Array.isArray(map.player_list)) return;
    const births = MapData.findBirthPoints(map);
    const list = map.player_list;

    list.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'prow';
      row.innerHTML = `
        <span class="swatch" title="旗帜 ${p.flag}" style="background:${MapConst.flagColor(p.flag)}"></span>
        <input class="p-name" value="${esc(p.name)}" placeholder="名称" title="势力名称">
        <label class="p-num">座<input class="p-seat" type="number" min="1" max="127" value="${p.seat}"></label>
        <label class="p-num">队<input class="p-team" type="number" min="1" max="32" value="${p.team}"></label>
        <select class="p-ai" title="电脑难度">${MapConst.AI_LEVELS.map((l) => `<option value="${l}" ${l === p.computer ? 'selected' : ''}>${MapConst.AI_LABELS[l]}</option>`).join('')}</select>
        <label class="p-num">旗<input class="p-flag" type="number" min="0" value="${p.flag}"></label>
        <span class="p-birth ${births.has(p.seat) ? 'ok' : 'warn'}" title="${births.has(p.seat) ? '有出生据点' : '无出生据点'}">${births.has(p.seat) ? '🏰' : '⚠'}</span>
        <button class="p-up" title="上移" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="p-down" title="下移" ${i === list.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="p-del" title="删除势力（战场该座次格子一并清理）">✕</button>
      `;
      container.appendChild(row);

      const q = (sel) => row.querySelector(sel);

      q('.p-name').addEventListener('change', (e) => {
        actions.onPlayerField((m) => { p.name = e.target.value.trim() || p.name; });
      });
      q('.p-seat').addEventListener('change', (e) => {
        const v = Math.max(1, Math.min(127, Math.round(Number(e.target.value) || 1)));
        actions.onPlayerField((m) => {
          // 与已有座次冲突时交换（保持唯一）
          const other = m.player_list.find((x) => x.seat === v && x !== p);
          if (other) other.seat = p.seat;
          p.seat = v;
        });
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
      q('.p-up').addEventListener('click', () => actions.onReorder(i, -1));
      q('.p-down').addEventListener('click', () => actions.onReorder(i, 1));
      q('.p-del').addEventListener('click', () => actions.onRemove(p.seat));
    });
  }

  return { render };
})();
