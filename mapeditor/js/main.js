/**
 * main.js — 装配启动：画布交互、工具/画笔面板、文件操作、信息/势力/校验面板
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const canvas = $('board');
  const ctx = canvas.getContext('2d');
  const wrap = $('canvas-wrap');
  const tooltip = $('tooltip');
  const statusEl = $('status');

  let cssW = 0;
  let cssH = 0;

  // ==================== 画布尺寸 / 渲染 ====================
  function fitCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = wrap.getBoundingClientRect();
    cssW = rect.width;
    cssH = rect.height;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }
  new ResizeObserver(fitCanvas).observe(wrap);
  window.addEventListener('resize', fitCanvas);

  function seatName(map, seat) {
    const p = map.player_list.find((x) => x.seat === seat);
    return p ? p.name : '?';
  }

  function render() {
    const s = Editor.getState();
    if (!s.map || !cssW) return;
    let ghost = null;
    if (s.tool === 'paste' && s.pasteAnchor >= 0) ghost = Editor.ghostForAnchor(s.pasteAnchor);
    const layout = HexRender.draw(ctx, cssW, cssH, s.map, s.view, {
      selected: s.selected,
      hover: s.hover,
      selection: s.selection,
      ghost,
    });

    if (s.hover >= 0) {
      const tile = s.map.battlefield[s.hover];
      const r = Math.floor(s.hover / s.map.column);
      const c = s.hover % s.map.column;
      const ownerText =
        tile[1] >= 1 && tile[1] <= 127
          ? `势力 ${tile[1]}（${esc(seatName(s.map, tile[1]))}）`
          : (MapConst.OWNER_LABELS[tile[1]] ?? String(tile[1]));
      tooltip.hidden = false;
      tooltip.innerHTML = `行 ${r + 1} · 列 ${c + 1} · idx ${s.hover}<br>地形：${MapConst.TERRAIN_LABELS[tile[0]] ?? tile[0]}<br>归属：${ownerText}<br>兵力：${tile[2]}`;
      const { cx, cy } = HexRender.centerOf(s.hover, s.map.column, layout);
      const rect = wrap.getBoundingClientRect();
      let tx = cx - rect.left + 14;
      let ty = cy - rect.top - tooltip.offsetHeight - 10;
      if (ty < 4) ty = cy - rect.top + 14;
      tooltip.style.left = tx + 'px';
      tooltip.style.top = ty + 'px';
    } else {
      tooltip.hidden = true;
    }
  }
  Editor.onCanvas(render);

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ==================== 状态栏 ====================
  let statusTimer = null;
  function statusMsg(text, kind = 'ok') {
    statusEl.textContent = text;
    statusEl.className = 'status ' + kind;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusEl.className = 'status';
      statusEl.textContent = '就绪';
    }, 5000);
  }

  // ==================== 鼠标 / 触摸交互 ====================
  let mouseDown = false;
  let panning = false;
  let lastX = 0;
  let lastY = 0;

  function indexAt(clientX, clientY) {
    const s = Editor.getState();
    if (!s.map || !cssW) return -1;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const layout = HexRender.computeLayout(s.map.column, s.map.row, cssW, cssH, s.view.zoom, s.view.panX, s.view.panY);
    return HexRender.pickIndex(x, y, s.map.column, s.map.row, layout);
  }

  function downAt(clientX, clientY) {
    const s = Editor.getState();
    if (!s.map) return;
    if (s.tool === 'pan') {
      panning = true;
      lastX = clientX;
      lastY = clientY;
      return;
    }
    const idx = indexAt(clientX, clientY);
    if (idx < 0) return;
    mouseDown = true;
    if (s.tool === 'paint') Editor.paintStart(idx);
    else if (s.tool === 'city') Editor.placeCity(idx);
    else if (s.tool === 'select') Editor.startSelect(idx);
    else if (s.tool === 'paste') Editor.pasteAt(idx);
  }

  function moveTo(clientX, clientY) {
    const s = Editor.getState();
    if (!s.map) return;
    if (panning) {
      const dx = clientX - lastX;
      const dy = clientY - lastY;
      lastX = clientX;
      lastY = clientY;
      Editor.setView({ panX: s.view.panX + dx, panY: s.view.panY + dy });
      return;
    }
    const idx = indexAt(clientX, clientY);
    if (mouseDown) {
      if (idx < 0) return;
      if (s.tool === 'paint') Editor.paintDrag(idx);
      else if (s.tool === 'select') Editor.selectDrag(idx);
      else if (s.tool === 'paste' && s.pasteAnchor !== idx) { s.pasteAnchor = idx; render(); }
    } else {
      Editor.setHover(idx);
      if (s.tool === 'paste' && s.pasteAnchor !== idx) { s.pasteAnchor = idx; render(); }
    }
  }

  function upNow() {
    if (mouseDown) {
      mouseDown = false;
      const s = Editor.getState();
      if (s.tool === 'paint') Editor.paintEnd();
      else if (s.tool === 'select') Editor.endSelect();
    }
    panning = false;
  }

  canvas.addEventListener('mousedown', (e) => {
    if (!Editor.getState().map) return;
    e.preventDefault();
    if (e.button === 1 || e.button === 2) {
      panning = true;
      lastX = e.clientX;
      lastY = e.clientY;
      return;
    }
    downAt(e.clientX, e.clientY);
  });
  canvas.addEventListener('mousemove', (e) => moveTo(e.clientX, e.clientY));
  window.addEventListener('mouseup', upNow);
  canvas.addEventListener('mouseleave', () => {
    mouseDown = false;
    panning = false;
    const s = Editor.getState();
    if (s.hover !== -1) { s.hover = -1; render(); }
    if (s.pasteAnchor !== -1) { s.pasteAnchor = -1; render(); }
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const s = Editor.getState();
    if (!s.map) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const layout = HexRender.computeLayout(s.map.column, s.map.row, cssW, cssH, s.view.zoom, s.view.panX, s.view.panY);
    const newZoom = Math.max(0.2, Math.min(8, s.view.zoom * factor));
    const baseSize = layout.size / s.view.zoom;
    const wx = (px - layout.offX) / s.view.zoom;
    const wy = (py - layout.offY) / s.view.zoom;
    const SQRT3 = Math.sqrt(3);
    const totalW1 = SQRT3 * (s.map.column + 0.5) * baseSize * newZoom;
    const totalH1 = (2 + 1.5 * (s.map.row - 1)) * baseSize * newZoom;
    const offX1 = px - wx * newZoom;
    const offY1 = py - wy * newZoom;
    Editor.setView({
      zoom: newZoom,
      panX: offX1 - (cssW - totalW1) / 2,
      panY: offY1 - (cssH - totalH1) / 2,
    });
  }, { passive: false });

  // 触摸：单指=左键，双指=平移+捏合缩放
  let pinch = null;
  canvas.addEventListener('touchstart', (e) => {
    e.preventDefault();
    if (e.touches.length === 1) {
      pinch = null;
      downAt(e.touches[0].clientX, e.touches[0].clientY);
    } else if (e.touches.length === 2) {
      upNow();
      const s = Editor.getState();
      pinch = {
        midX: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        midY: (e.touches[0].clientY + e.touches[1].clientY) / 2,
        dist: Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY),
        zoom: s.view.zoom,
        panX: s.view.panX,
        panY: s.view.panY,
      };
    }
  }, { passive: false });
  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (pinch && e.touches.length === 2) {
      const s = Editor.getState();
      const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      Editor.setView({
        zoom: Math.max(0.2, Math.min(8, pinch.zoom * (dist / pinch.dist))),
        panX: pinch.panX + (midX - pinch.midX),
        panY: pinch.panY + (midY - pinch.midY),
      });
    } else if (e.touches.length === 1) {
      moveTo(e.touches[0].clientX, e.touches[0].clientY);
    }
  }, { passive: false });
  canvas.addEventListener('touchend', (e) => {
    e.preventDefault();
    if (e.touches.length === 0) {
      pinch = null;
      upNow();
    }
  }, { passive: false });

  // ==================== 工具 / 画笔面板 ====================
  document.querySelectorAll('#left [data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => {
      Editor.setTool(btn.dataset.tool);
      refreshUI();
    });
  });
  document.querySelectorAll('#brush-mode [data-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      Editor.setBrush({ mode: btn.dataset.mode });
      refreshUI();
    });
  });

  function syncToolUI() {
    const s = Editor.getState();
    document.querySelectorAll('#left [data-tool]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === s.tool);
    });
    document.querySelectorAll('#brush-mode [data-mode]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.mode === s.brush.mode);
    });
    // 面板显隐
    const paintOn = s.tool === 'paint';
    const cityOn = s.tool === 'city';
    $('brush-mode').style.display = paintOn ? '' : 'none';
    $('terrain-palette').style.display = paintOn ? '' : 'none';
    $('owner-palette').style.display = paintOn ? '' : 'none';
    $('strength-row').style.display = paintOn ? '' : 'none';
    $('city-seat-row').style.display = cityOn ? '' : 'none';
    $('btn-copy').style.display = s.tool === 'select' ? '' : 'none';
    const hint = $('paste-hint');
    if (hint) hint.style.display = s.tool === 'paste' ? '' : 'none';
  }

  function buildPalette(container, items, current, onClick) {
    container.innerHTML = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.className = 'pal' + (it.value === current ? ' active' : '');
      b.title = it.label;
      b.style.background = it.color;
      b.innerHTML = `<span>${it.text}</span>`;
      b.addEventListener('click', () => { onClick(it.value); refreshUI(); });
      container.appendChild(b);
    }
  }

  function syncBrushUI() {
    const s = Editor.getState();
    if (!s.map) return;
    // 地形
    buildPalette(
      $('terrain-palette').querySelector('.palette'),
      MapConst.TERRAIN_ORDER.map((t) => ({
        value: t,
        label: MapConst.TERRAIN_LABELS[t],
        color: MapConst.TERRAIN_COLORS[t],
        text: MapConst.TERRAIN_LABELS[t],
      })),
      s.brush.terrain,
      (v) => Editor.setBrush({ terrain: v }),
    );
    // 归属：无主/野生/阻挡 + 各势力
    const ownerItems = MapConst.OWNER_ORDER.map((o) => ({
      value: o,
      label: MapConst.OWNER_LABELS[o],
      color: MapConst.OWNER_COLORS[o],
      text: MapConst.OWNER_LABELS[o],
    }));
    for (const p of s.map.player_list) {
      ownerItems.push({
        value: p.seat,
        label: `势力${p.seat} ${p.name}`,
        color: MapConst.flagColor(p.flag),
        text: `P${p.seat}`,
      });
    }
    buildPalette(
      $('owner-palette').querySelector('.palette'),
      ownerItems,
      s.brush.owner,
      (v) => Editor.setBrush({ owner: v }),
    );
    // 兵力
    $('strength-input').value = s.brush.strength;
    $('strength-val').textContent = s.brush.strength;
    // 出生点势力下拉
    const seatSel = $('city-seat');
    seatSel.innerHTML = s.map.player_list
      .map((p) => `<option value="${p.seat}" ${p.seat === s.brush.seat ? 'selected' : ''}>势力${p.seat} ${esc(p.name)}</option>`)
      .join('');
  }
  $('strength-input').addEventListener('input', (e) => {
    Editor.setBrush({ strength: Number(e.target.value) });
    $('strength-val').textContent = e.target.value;
  });
  $('city-seat').addEventListener('change', (e) => {
    Editor.setBrush({ seat: Number(e.target.value) });
  });

  // ==================== 文件操作 ====================
  function serverUrl() {
    return ($('server-url').value.trim() || MapConst.DEFAULT_SERVER);
  }
  $('server-url').value = localStorage.getItem('dl-mapeditor-server') || MapConst.DEFAULT_SERVER;
  $('server-url').addEventListener('change', (e) => {
    localStorage.setItem('dl-mapeditor-server', e.target.value.trim());
  });

  $('btn-new').addEventListener('click', () => $('dlg-new').showModal());
  $('dlg-new-cancel').addEventListener('click', () => $('dlg-new').close());
  $('dlg-new-ok').addEventListener('click', () => {
    const row = Math.max(2, Math.min(64, Math.round(Number($('new-row').value) || 7)));
    const column = Math.max(2, Math.min(64, Math.round(Number($('new-col').value) || 10)));
    const players = Math.max(1, Math.min(8, Math.round(Number($('new-players').value) || 2)));
    $('dlg-new').close();
    Editor.setMap(MapData.createDefaultMap(row, column, players), `map_new_${Date.now() % 100000}`);
    statusMsg(`已新建 ${row}×${column}、${players} 势力地图`);
  });

  $('btn-open').addEventListener('click', () => $('file-open').click());
  $('file-open').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) loadFile(file);
  });
  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const res = IO.parseMapJson(String(reader.result));
      if (!res.ok) {
        statusMsg(`打开失败：${res.error}`, 'error');
        return;
      }
      const id = (file.name || 'map').replace(/\.json$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_');
      Editor.setMap(res.map, id);
      statusMsg(`已打开 ${file.name}`);
    };
    reader.readAsText(file);
  }
  // 拖拽打开
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file && /\.json$/i.test(file.name)) loadFile(file);
  });

  $('btn-export').addEventListener('click', () => {
    const s = Editor.getState();
    if (!s.map) { statusMsg('没有地图可导出', 'error'); return; }
    IO.downloadMap(s.map, s.id);
    statusMsg(`已导出 ${s.id}.json`);
  });

  $('btn-save').addEventListener('click', async () => {
    const s = Editor.getState();
    if (!s.map) { statusMsg('没有地图可保存', 'error'); return; }
    const id = (s.id || '').trim() || 'map_new';
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      statusMsg('id 仅允许字母/数字/下划线/连字符', 'error');
      return;
    }
    const errors = MapValidate.validate(s.map).filter((i) => i.level === 'error');
    if (errors.length) {
      statusMsg(`校验未通过（${errors.length} 处错误），请先修复`, 'error');
      return;
    }
    statusMsg('保存中…');
    try {
      const res = await IO.saveToServer(serverUrl(), id, s.map);
      if (res.ok) statusMsg(`已保存到服务器 maps-uncensored/${id}.json`);
      else statusMsg(`保存失败：${res.result.message || 'HTTP ' + res.status}`, 'error');
    } catch (e) {
      statusMsg(`保存失败：${e.message}（请检查服务器地址）`, 'error');
    }
  });

  async function refreshServerList() {
    const sel = $('server-map-select');
    sel.innerHTML = '<option value="">— 从服务器加载 —</option>';
    try {
      const list = await IO.loadServerMapList(serverUrl());
      for (const m of list) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = `${m.id}（${m.title} · ${m.playerNum}人）`;
        sel.appendChild(opt);
      }
      if (list.length) statusMsg(`服务器共 ${list.length} 张地图`);
      else statusMsg('服务器上暂无地图');
    } catch (e) {
      statusMsg(`加载地图列表失败：${e.message}`, 'error');
    }
  }
  $('btn-refresh-server').addEventListener('click', refreshServerList);
  $('server-map-select').addEventListener('change', async () => {
    const sel = $('server-map-select');
    const id = sel.value;
    if (!id) return;
    sel.value = '';
    try {
      const map = await IO.loadServerMap(serverUrl(), id);
      Editor.setMap(map, map.id);
      statusMsg(`已加载服务器地图 ${id}`);
    } catch (e) {
      statusMsg(`加载地图失败：${e.message}`, 'error');
    }
  });

  // ==================== 撤销/重做 / 复制 / 尺寸 / 生成 ====================
  $('btn-undo').addEventListener('click', () => Editor.undo());
  $('btn-redo').addEventListener('click', () => Editor.redo());
  $('btn-copy').addEventListener('click', () => {
    Editor.copySelection();
    statusMsg('已复制选中区域，切到「粘贴」工具点击放置');
  });
  document.querySelectorAll('.resize button').forEach((btn) => {
    btn.addEventListener('click', () => {
      Editor.resize({ [btn.dataset.dir]: Number(btn.dataset.d) });
    });
  });
  $('btn-generate').addEventListener('click', () => {
    const opts = {
      row: Math.max(3, Math.min(30, Math.round(Number($('gen-row').value) || 9))),
      column: Math.max(3, Math.min(40, Math.round(Number($('gen-col').value) || 11))),
      playerNum: Math.max(1, Math.min(8, Math.round(Number($('gen-players').value) || 2))),
      mode: $('gen-mode').value,
    };
    Editor.generateMap(opts);
    statusMsg(`已生成随机地图（${opts.row}×${opts.column}，${opts.playerNum} 势力）`);
  });

  // ==================== 信息面板 ====================
  function bindCommit(id, fn) {
    $(id).addEventListener('change', () => Editor.commit((m) => fn(m, $(id))));
  }
  bindCommit('f-title', (m, el) => { m.title = el.value.trim() || m.title; });
  bindCommit('f-author', (m, el) => { m.author = el.value.trim(); });
  bindCommit('f-timestamp', (m, el) => { m.timestamp = el.value.trim(); });
  bindCommit('f-desc', (m, el) => { m.description = el.value; });
  bindCommit('f-tags', (m, el) => {
    m.tags = el.value.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
  });
  bindCommit('f-total', (m, el) => { m.online_time_settings.total_time = Math.max(0, Number(el.value) || 0); });
  bindCommit('f-round', (m, el) => { m.online_time_settings.round_time = Math.max(0, Number(el.value) || 0); });
  bindCommit('f-bonus', (m, el) => { m.online_time_settings.time_bonus = Math.max(0, Number(el.value) || 0); });
  bindCommit('f-random', (m, el) => { m.random_spawn = el.checked; });
  bindCommit('f-cyl', (m, el) => { m.cylindrical_map = el.checked; });
  bindCommit('f-fog', (m, el) => { m.fog_mode = el.checked; });
  $('f-id').addEventListener('change', (e) => {
    Editor.updateId(e.target.value.trim() || 'map_new');
    statusMsg('id（文件名）已更新');
  });
  $('btn-now').addEventListener('click', () => {
    Editor.commit((m) => { m.timestamp = MapData.nowTimestamp(); });
    statusMsg('时间戳已更新');
  });

  function syncInfo() {
    const s = Editor.getState();
    if (!s.map) return;
    const focused = document.activeElement;
    const set = (el, val) => {
      if (el !== focused && el.value !== String(val)) el.value = val;
    };
    set($('f-id'), s.id);
    set($('f-title'), s.map.title);
    set($('f-author'), s.map.author);
    set($('f-timestamp'), s.map.timestamp);
    set($('f-desc'), s.map.description);
    set($('f-tags'), (s.map.tags || []).join(', '));
    set($('f-total'), s.map.online_time_settings?.total_time ?? 0);
    set($('f-round'), s.map.online_time_settings?.round_time ?? 0);
    set($('f-bonus'), s.map.online_time_settings?.time_bonus ?? 0);
    if ($('f-random') !== focused) $('f-random').checked = !!s.map.random_spawn;
    if ($('f-cyl') !== focused) $('f-cyl').checked = !!s.map.cylindrical_map;
    if ($('f-fog') !== focused) $('f-fog').checked = !!s.map.fog_mode;
    $('f-size').textContent = `${s.map.row} × ${s.map.column}`;
  }

  // ==================== 势力面板 ====================
  function syncPlayers() {
    const s = Editor.getState();
    Players.render($('player-list'), s.map, {
      onPlayerField: (fn) => Editor.commit(fn),
      onReorder: (i, dir) => Editor.reorderPlayer(i, dir),
      onRemove: (seat) => {
        const p = s.map?.player_list.find((x) => x.seat === seat);
        if (p && !window.confirm(`删除势力「${p.name}」(seat=${seat})？其战场格子将归无主，更高座次整体 -1。`)) return;
        Editor.removePlayer(seat);
      },
    });
  }
  $('btn-add-player').addEventListener('click', () => {
    Editor.addPlayer();
    statusMsg('已新增势力');
  });

  // ==================== 校验面板 ====================
  function syncValidate() {
    const s = Editor.getState();
    const box = $('validate-summary');
    const list = $('validate-list');
    if (!s.map) {
      box.textContent = '无地图';
      list.innerHTML = '';
      return;
    }
    const issues = MapValidate.validate(s.map);
    const errs = issues.filter((i) => i.level === 'error').length;
    const warns = issues.filter((i) => i.level === 'warn').length;
    box.textContent = errs === 0 && warns === 0 ? '✅ 全部通过' : `${errs ? `❌ ${errs} 错误` : ''}${warns ? ` ⚠ ${warns} 警告` : ''}`.trim();
    box.className = errs ? 'v-err' : warns ? 'v-warn' : 'v-ok';
    list.innerHTML = '';
    for (const issue of issues) {
      const li = document.createElement('li');
      li.className = issue.level;
      li.textContent = issue.text;
      list.appendChild(li);
    }
  }

  // ==================== 顶栏状态 ====================
  function syncTopbar() {
    const s = Editor.getState();
    if (!s.map) return;
    document.title = `${s.id} · 数字领主地图编辑器`;
  }

  // ==================== UI 刷新聚合 ====================
  function refreshUI() {
    const s = Editor.getState();
    if (!s.map) return;
    syncInfo();
    syncPlayers();
    syncValidate();
    syncToolUI();
    syncBrushUI();
    syncTopbar();
  }
  Editor.onUI(refreshUI);

  // ==================== 标签页切换 ====================
  document.querySelectorAll('.tabs [data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabs [data-tab]').forEach((b) => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tab-page').forEach((p) => {
        p.hidden = p.id !== `tab-${btn.dataset.tab}`;
      });
    });
  });

  // ==================== 键盘 ====================
  window.addEventListener('keydown', (e) => {
    const tag = (document.activeElement?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) Editor.redo();
      else Editor.undo();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      Editor.redo();
    } else if (e.key === 'Escape') {
      const s = Editor.getState();
      if (s.tool !== 'paint') {
        Editor.setTool('paint');
        refreshUI();
      } else if (s.selection) {
        s.selection = null;
        s.selected = -1;
        render();
        refreshUI();
      }
    }
  });

  // ==================== 启动 ====================
  // 优先从 samples 加载一张官方地图作为起始画布（fetch 失败则用内置默认图）
  const starter = 'samples/map_duo_plain.json';
  fetch(starter)
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error('no sample'))))
    .then((text) => {
      const res = IO.parseMapJson(text);
      if (res.ok) {
        Editor.setMap(res.map, 'map_duo_plain');
        statusMsg('已加载示例地图，可开始编辑');
        return;
      }
      throw new Error(res.error);
    })
    .catch(() => {
      Editor.setMap(MapData.createDefaultMap(7, 10, 2), 'map_new');
      statusMsg('已创建默认地图（未找到示例文件）');
    });
})();
