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
  window.addEventListener('load', fitCanvas);

  function seatName(map, seat) {
    const p = map.player_list.find((x) => x.seat === seat);
    return p ? p.name : '?';
  }

  function render() {
    const s = Editor.getState();
    if (!s.map || !cssW) return;
    const layout = HexRender.draw(ctx, cssW, cssH, s.map, s.view, {
      hover: s.hover,
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
  const toastEl = $('m-toast');
  function statusMsg(text, kind = 'ok') {
    statusEl.textContent = text;
    statusEl.className = 'status ' + kind;
    // 窄屏顶栏整体隐藏，同一条消息在浮层复现（宽屏下 #m-toast 不显示）
    if (toastEl) {
      toastEl.textContent = text;
      toastEl.className = kind + ' show';
    }
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => {
      statusEl.className = 'status';
      statusEl.textContent = '就绪';
      if (toastEl) toastEl.className = '';
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
    Editor.paintStart(idx);
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
      Editor.paintDrag(idx);
    } else {
      Editor.setHover(idx);
    }
  }

  function upNow() {
    if (mouseDown) {
      mouseDown = false;
      Editor.paintEnd();
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
    // 面板显隐：画笔工具才显示画笔面板，平移工具隐藏
    const paintOn = s.tool === 'paint';
    $('brush-mode').style.display = paintOn ? '' : 'none';
    $('terrain-palette').style.display = paintOn ? '' : 'none';
    $('owner-palette').style.display = paintOn ? '' : 'none';
    $('strength-row').style.display = paintOn ? '' : 'none';
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
    $('strength-number').value = s.brush.strength;
  }
  $('strength-input').addEventListener('input', (e) => {
    const v = Math.max(0, Math.min(255, Math.round(Number(e.target.value) || 0)));
    Editor.setBrush({ strength: v });
    $('strength-number').value = v;
  });
  $('strength-number').addEventListener('change', (e) => {
    const v = Math.max(0, Math.min(255, Math.round(Number(e.target.value) || 0)));
    Editor.setBrush({ strength: v });
    $('strength-input').value = v;
    $('strength-number').value = v;
  });

  // ==================== 文件操作 ====================
  // embed=1：从主程序大厅进入——服务器即当前来源（同源相对路径），隐藏服务器输入框
  const EMBEDDED = new URLSearchParams(window.location.search).get('embed') === '1';
  if (EMBEDDED) {
    $('server-field').style.display = 'none';
    const back = $('btn-back-lobby');
    if (back) back.style.display = '';
  }

  function serverUrl() {
    if (EMBEDDED) return ''; // 同源：相对路径直接打到当前服务器
    return $('server-url').value.trim() || MapConst.DEFAULT_SERVER;
  }
  if (!EMBEDDED) {
    $('server-url').value = localStorage.getItem('dl-mapeditor-server') || MapConst.DEFAULT_SERVER;
  }
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
    const m = MapData.createDefaultMap(row, column, players);
    m.author = MapData.defaultAuthor();
    Editor.setMap(m, MapData.randomId());
    statusMsg(`已新建 ${row}×${column}、${players} 势力地图`);
  });

  $('btn-open').addEventListener('click', () => $('file-open').click());
  $('file-open').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) loadFile(file);
  });

  // 地图码导入：base64 解码 → 适配为本游戏 JSON 地图载入编辑器
  $('btn-mapcode').addEventListener('click', () => $('dlg-mapcode').showModal());
  $('dlg-mapcode-cancel').addEventListener('click', () => $('dlg-mapcode').close());
  $('dlg-mapcode-ok').addEventListener('click', async () => {
    const code = $('mapcode-input').value.trim();
    if (!code) { statusMsg('请先粘贴地图码', 'error'); return; }
    statusMsg('解析地图码中…');
    const res = await MapCode.decodeMapCode(code);
    if (!res.ok) { statusMsg(res.error, 'error'); return; }
    const errors = MapValidate.validate(res.map).filter((i) => i.level === 'error');
    Editor.setMap(res.map, MapData.randomId());
    $('dlg-mapcode').close();
    $('mapcode-input').value = '';
    statusMsg(errors.length
      ? `已从地图码导入「${res.map.title || '未命名'}」（${errors.length} 处校验问题，请检查）`
      : `已从地图码导入「${res.map.title || '未命名'}」`);
  });
  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      const res = IO.parseMapJson(String(reader.result));
      if (!res.ok) {
        statusMsg(`打开失败：${res.error}`, 'error');
        return;
      }
      Editor.setMap(res.map, MapData.randomId());
      statusMsg(`已导入 ${file.name}`);
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
      if (res.ok) {
        const savedTo = res.result?.data?.savedTo || 'maps-uncensored';
        const reason = res.result?.data?.reason;
        statusMsg(reason ? `已保存到服务器 ${savedTo}/${id}.json（${reason}）` : `已保存到服务器 ${savedTo}/${id}.json`);
      } else statusMsg(`保存失败：${res.result.message || 'HTTP ' + res.status}`, 'error');
    } catch (e) {
      statusMsg(`保存失败：${e.message}（请检查服务器地址）`, 'error');
    }
  });

  /**
   * 服务器地图搜索：顶栏下拉（宽屏）与「服务器导入」弹窗（窄屏）共用同一套渲染逻辑。
   * onPick 收到地图 id；返回 { ok, count } 供调用方决定下拉是否展开。
   */
  async function renderServerResults(inputEl, boxEl, onPick) {
    boxEl.innerHTML = '<div class="none">搜索中…</div>';
    let list;
    try {
      list = await IO.loadServerMapList(serverUrl(), inputEl.value.trim());
    } catch (e) {
      boxEl.innerHTML = `<div class="none">搜索失败：${esc(e.message)}</div>`;
      statusMsg(`搜索地图失败：${e.message}`, 'error');
      return { ok: false, count: 0 };
    }
    boxEl.innerHTML = '';
    if (!list.length) {
      boxEl.innerHTML = '<div class="none">无匹配地图</div>';
      statusMsg('没有匹配的服务器地图');
      return { ok: true, count: 0 };
    }
    for (const m of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = `${m.title}（${m.author || '?'} · ${m.playerNum}人）`;
      b.title = m.id;
      b.addEventListener('click', () => onPick(m.id));
      boxEl.appendChild(b);
    }
    statusMsg(`找到 ${list.length} 张匹配地图`);
    return { ok: true, count: list.length };
  }

  async function loadServerMapById(id) {
    try {
      const map = await IO.loadServerMap(serverUrl(), id);
      Editor.setMap(map, map.id);
      statusMsg(`已加载服务器地图 ${id}`);
      return true;
    } catch (e) {
      statusMsg(`加载地图失败：${e.message}`, 'error');
      return false;
    }
  }

  // 顶栏（宽屏）搜索：🔍 按钮 / 回车触发，结果用下拉展示
  const topSearchBox = $('server-map-results');
  async function searchTopbarMaps() {
    await renderServerResults($('server-map-search'), topSearchBox, (id) => {
      topSearchBox.hidden = true;
      loadServerMapById(id);
    });
    topSearchBox.hidden = false;
  }
  $('btn-server-search').addEventListener('click', searchTopbarMaps);
  $('server-map-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchTopbarMaps();
    else if (e.key === 'Escape') topSearchBox.hidden = true;
  });
  // 点击搜索框外关闭下拉结果
  document.addEventListener('click', (e) => {
    if (!topSearchBox.hidden && !e.target.closest('#server-search-wrap')) topSearchBox.hidden = true;
  });

  // 窄屏「服务器导入」弹窗：同一个搜索逻辑，结果常显在弹窗内
  const dlgSearchBox = $('m-server-results');
  async function searchDialogMaps() {
    await renderServerResults($('m-server-search'), dlgSearchBox, async (id) => {
      if (await loadServerMapById(id)) $('dlg-serverimport').close();
    });
  }
  $('m-server-search-btn').addEventListener('click', searchDialogMaps);
  $('m-server-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchDialogMaps();
  });

  // ==================== 右侧面板宽度拖拽 ====================
  let rightResize = null;
  const rightPanel = $('right');
  const rightResizer = $('right-resizer');
  rightResizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    rightResize = { startX: e.clientX, startW: rightPanel.getBoundingClientRect().width };
    rightResizer.classList.add('active');
  });
  window.addEventListener('mousemove', (e) => {
    if (!rightResize) return;
    const w = Math.max(240, Math.min(560, rightResize.startW + (rightResize.startX - e.clientX)));
    rightPanel.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (!rightResize) return;
    rightResize = null;
    rightResizer.classList.remove('active');
  });

  // 点击势力行外关闭旗帜选择弹层
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.p-flag-wrap')) {
      document.querySelectorAll('.p-flag-pop').forEach((p) => { p.hidden = true; });
    }
  });

  // ==================== 撤销/重做 / 尺寸 / 生成 ====================
  $('btn-undo').addEventListener('click', () => Editor.undo());
  $('btn-redo').addEventListener('click', () => Editor.redo());
  // 四边 ±1 快捷按钮（带 data-d）；窄屏另用「方向+ 数值输入」按任意整数调节
  document.querySelectorAll('.resize-float button[data-d]').forEach((btn) => {
    btn.addEventListener('click', () => {
      Editor.resize({ [btn.dataset.dir]: Number(btn.dataset.d) });
    });
  });
  document.querySelectorAll('.resize-float .rf-apply').forEach((btn) => {
    const input = btn.parentElement.querySelector('.rf-num');
    const isColumn = btn.dataset.dir === 'left' || btn.dataset.dir === 'right';
    const apply = () => {
      const v = Math.round(Number(input.value));
      if (!Number.isFinite(v) || v === 0) {
        statusMsg('请输入非 0 整数（正数扩容 / 负数缩减）', 'error');
        return;
      }
      Editor.resize({ [btn.dataset.dir]: v });
      statusMsg(`已按 ${v > 0 ? '+' + v : v} 调整${isColumn ? '列' : '行'}`);
    };
    btn.addEventListener('click', apply);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); apply(); }
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
  // 作者取自当前登录账号，界面上为只读灰显，不接受编辑
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

  function syncInfo() {
    const s = Editor.getState();
    if (!s.map) return;
    const focused = document.activeElement;
    const set = (el, val) => {
      if (el !== focused && el.value !== String(val)) el.value = val;
    };
    set($('f-title'), s.map.title);
    set($('f-author'), s.map.author);
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
  // 座次拖动：按住「⇕」手柄上下拖动，把该势力移到任意座次（一次拖动只记一次撤销）
  let seatDrag = null;
  function onSeatDragMove(e) {
    if (!seatDrag) return;
    const s = Editor.getState();
    if (!s.map) return;
    const n = s.map.player_list.length;
    const delta = Math.round((e.clientY - seatDrag.startY) / 26);
    const target = Math.max(1, Math.min(n, seatDrag.baseSeat + delta));
    if (target !== seatDrag.lastTarget) {
      if (!seatDrag.pushed) {
        Editor.pushUndo();
        seatDrag.pushed = true;
      }
      seatDrag.lastTarget = target;
      Editor.moveSeat(seatDrag.seat, target);
      seatDrag.seat = target;
    }
  }
  function onSeatDragEnd() {
    seatDrag = null;
  }
  window.addEventListener('mousemove', onSeatDragMove);
  window.addEventListener('mouseup', onSeatDragEnd);

  function syncPlayers() {
    const s = Editor.getState();
    Players.render($('player-list'), s.map, {
      onPlayerField: (fn) => Editor.commit(fn),
      onRemove: (seat) => Editor.removePlayer(seat),
      onSeatDragStart: (seat, event) => {
        event.preventDefault();
        seatDrag = { seat, baseSeat: seat, startY: event.clientY, lastTarget: seat, pushed: false };
      },
    });
  }
  $('btn-add-player').addEventListener('click', () => {
    Editor.addPlayer();
    statusMsg('已新增势力');
  });

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
      }
    }
  });

  // ==================== 启动 ====================
  // 旗帜精灵预载（加载完成触发重绘，避免首次绘制显示兜底色块）
  HexRender.setSpriteWatcher(() => {
    const s = Editor.getState();
    if (s.map && cssW) render();
  });
  HexRender.preloadAllFlags();

  // 起始画布：从服务器地图库（backend/static/maps）加载；未连接服务器则建默认图
  (async () => {
    try {
      const list = await IO.loadServerMapList(serverUrl());
      const preferred = list.find((m) => m.id === 'map_duo_plain') || list[0];
      if (preferred) {
        const map = await IO.loadServerMap(serverUrl(), preferred.id);
        Editor.setMap(map, map.id);
        statusMsg(`已加载服务器地图 ${map.title}`);
        return;
      }
      throw new Error('服务器地图库为空');
    } catch (e) {
      const fb = MapData.createDefaultMap(7, 10, 2);
      fb.author = MapData.defaultAuthor();
      Editor.setMap(fb, MapData.randomId());
      statusMsg('已创建默认地图（未连接服务器）');
    }
  })();

  // ==================== 供 mobile.js 复用的入口 ====================
  // 窄屏顶栏整体隐藏后，服务器地址与状态提示只在这里可取；
  // 其余「新建 / 本地导入 / 地图码导入 / 随机生成 / 保存 / 导出」沿用各自按钮的 click（事件处理器不变）。
  window.MapEditorActions = { serverUrl, statusMsg };
})();
