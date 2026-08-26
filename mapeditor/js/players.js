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
   *   onSeatDragStart(seat, event),  // 座次拖动手柄 mousedown
   * }
   */
  function render(container, map, actions) {
    container.innerHTML = '';
    if (!map || !Array.isArray(map.player_list)) return;
    const list = map.player_list.slice().sort((a, b) => a.seat - b.seat);

    list.forEach((p) => {
      const row = document.createElement('div');
      row.className = 'prow';
      // 旗号 0 为无图片兜底（纯色），其余为有图片的旗号（1..30 标准纯色旗）
      const flagOptions = [0, ...MapConst.FLAG_IMAGE_NUMS];
      row.innerHTML = `
        <button class="p-drag" title="按住并上下拖动，调整座次">⇕</button>
        <span class="p-seat" title="座次（拖动 ⇕ 可调整）">${p.seat}</span>
        <span class="swatch" title="旗帜 ${p.flag}"></span>
        <input class="p-name" value="${esc(p.name)}" placeholder="名称" title="势力名称">
        <label class="p-num">队<input class="p-team" type="number" min="1" max="32" value="${p.team}"></label>
        <select class="p-ai" title="电脑难度">${MapConst.AI_LEVELS.map((l) => `<option value="${l}" ${l === p.computer ? 'selected' : ''}>${MapConst.AI_LABELS[l]}</option>`).join('')}</select>
        <div class="p-flag-wrap">
          <button class="p-flag-btn" type="button" title="选择旗帜"><span class="fprev"></span><span class="p-flag-num">${p.flag}</span></button>
          <div class="p-flag-pop" hidden>
            <div class="p-flag-head"><span>选择旗帜</span><button type="button" class="p-flag-close" title="关闭">✕</button></div>
            <div class="p-flag-grid">${flagOptions.map((f) => `<button type="button" class="p-flag-opt" data-flag="${f}"><span class="fprev"></span>${f}</button>`).join('')}</div>
          </div>
        </div>
        <button class="p-del" title="删除势力（战场该座次格子一并清理）">✕</button>
      `;
      container.appendChild(row);

      const q = (sel) => row.querySelector(sel);

      // 旗帜预览：旗帜为透明底尖顶六边形图片，直接显示图片（不加有色底）；无图片的旗号回退纯色
      const setFlagPrev = (el, flag) => {
        const img = MapConst.flagImage(flag);
        if (img) {
          el.style.backgroundImage = `url('${img}')`;
          el.style.backgroundSize = 'contain';
          el.style.backgroundPosition = 'center';
          el.style.backgroundColor = 'transparent';
        } else {
          el.style.backgroundImage = 'none';
          el.style.backgroundSize = 'auto';
          el.style.backgroundPosition = '0 0';
          el.style.backgroundColor = MapConst.flagColor(flag);
        }
      };

      q('.p-drag').addEventListener('mousedown', (e) => actions.onSeatDragStart(p.seat, e));
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
      setFlagPrev(q('.swatch'), p.flag);
      const flagBtn = q('.p-flag-btn');
      const flagPop = q('.p-flag-pop');
      setFlagPrev(q('.p-flag-btn .fprev'), p.flag);
      flagPop.querySelectorAll('.p-flag-opt').forEach((opt) => {
        const f = Number(opt.dataset.flag);
        setFlagPrev(opt.querySelector('.fprev'), f);
        opt.classList.toggle('sel', f === p.flag);
        opt.addEventListener('click', (e) => {
          e.stopPropagation();
          flagPop.hidden = true;
          actions.onPlayerField((m) => { p.flag = f; });
        });
      });
      flagBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        flagPop.hidden = !flagPop.hidden;
      });
      q('.p-flag-close').addEventListener('click', (e) => {
        e.stopPropagation();
        flagPop.hidden = true;
      });
      q('.p-del').addEventListener('click', () => actions.onRemove(p.seat));
    });
  }

  return { render };
})();
