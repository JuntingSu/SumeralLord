/**
 * mobile.js — 手机端适配（在 main.js 之后加载）
 * 窄屏时：隐藏整个顶栏与两侧侧边栏，只显示地图区域；
 * 左上悬浮 涂刷/拖动/撤回/前进（仅图标）；
 * 右上「⚙ 地图信息/势力」「＋ 新建/导入/随机生成」「📤 导出 JSON / 导出到服务器」三个图标；
 * 涂刷模式下底部一条参数栏：最左为当前画笔效果预览，其后 模式/地形/归属/兵力 四个框（带上箭头提示向上弹出）；
 * 四边尺寸按钮只保留 ±1，并补「方向+ 数值输入」按任意整数调节；
 * 右侧面板整块移入齿轮弹窗，随机生成模块移入「＋ → 随机生成」弹窗（内容与桌面端完全一致）。
 * 依赖全局：Editor / MapConst / HexRender / IO，以及 main.js 暴露的 window.MapEditorActions。
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const act = window.MapEditorActions || {};

  const dlgSettings = $('dlg-settings');
  const dlgGenerate = $('dlg-generate');
  const dlgMore = $('dlg-more');
  const dlgServerImport = $('dlg-serverimport');
  const uploadMenu = $('upload-menu');
  const mobileBrush = $('mobile-brush');
  const mModeAll = $('m-mode-all');
  const mModeTerrain = $('m-mode-terrain');
  const mModeStrength = $('m-mode-strength');
  const mStrength = $('m-strength-input');
  const previewCanvas = $('mb-preview-canvas');

  const MQ = window.matchMedia('(max-width: 820px), ((pointer: coarse) and (max-width: 1024px))');

  function closeDlg(d) { if (d.open) d.close(); }

  function buildPalette(container, items, current, onClick) {
    container.innerHTML = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.className = 'pal' + (it.value === current ? ' active' : '');
      b.title = it.label;
      b.style.background = it.color;
      b.innerHTML = `<span>${it.text}</span>`;
      b.addEventListener('click', () => onClick(it.value));
      container.appendChild(b);
    }
  }

  function buildTerrainPalette() {
    const s = Editor.getState();
    if (!s.map) return;
    const pop = $('mb-pop-terrain');
    buildPalette(
      pop,
      MapConst.TERRAIN_ORDER.map((t) => ({
        value: t,
        label: MapConst.TERRAIN_LABELS[t],
        color: MapConst.TERRAIN_COLORS[t],
        text: MapConst.TERRAIN_LABELS[t],
      })),
      s.brush.terrain,
      (v) => { Editor.setBrush({ terrain: v }); pop.hidden = true; },
    );
  }

  function buildOwnerPalette() {
    const s = Editor.getState();
    if (!s.map) return;
    const pop = $('mb-pop-owner');
    const items = MapConst.OWNER_ORDER.map((o) => ({
      value: o,
      label: MapConst.OWNER_LABELS[o],
      color: MapConst.OWNER_COLORS[o],
      text: MapConst.OWNER_LABELS[o],
    }));
    for (const p of s.map.player_list) {
      items.push({
        value: p.seat,
        label: `势力${p.seat} ${p.name}`,
        color: MapConst.flagColor(p.flag),
        text: `P${p.seat}`,
      });
    }
    buildPalette(
      pop,
      items,
      s.brush.owner,
      (v) => { Editor.setBrush({ owner: v }); pop.hidden = true; },
    );
  }

  function ownerLabel(owner, map) {
    if (owner in MapConst.OWNER_LABELS) return MapConst.OWNER_LABELS[owner];
    const p = map.player_list.find((x) => x.seat === owner);
    return p ? `P${p.seat}` : String(owner);
  }

  /**
   * 底栏最左的效果预览：把当前画笔「虚拟放在」一个格子上。
   * 归一化规则与 editor.applyBrush 一致（山地/虚空不可驻兵；无主格兵力强制 0），
   * 使预览与涂刷后的真实结果一致；「仅兵力」不画地形、兵按断兵展示，「仅地形」只画纯地形。
   */
  function drawBrushPreview() {
    if (!previewCanvas) return;
    const s = Editor.getState();
    const dpr = window.devicePixelRatio || 1;
    const cw = previewCanvas.clientWidth || 48;
    const ch = previewCanvas.clientHeight || 42;
    const bw = Math.round(cw * dpr);
    const bh = Math.round(ch * dpr);
    if (previewCanvas.width !== bw || previewCanvas.height !== bh) {
      previewCanvas.width = bw;
      previewCanvas.height = bh;
    }
    const ctx = previewCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!s.map) return;
    const b = s.brush;
    let { terrain, owner, strength } = b;
    if (b.mode === 'strength') {
      if (owner === MapConst.TILE_OWNER.EMPTY) strength = 0;
    } else {
      if (MapConst.NO_SOLDIER_TERRAIN.has(terrain)) { owner = MapConst.TILE_OWNER.EMPTY; strength = 0; }
      if (owner === MapConst.TILE_OWNER.EMPTY) strength = 0;
    }
    HexRender.drawPreview(ctx, cw, ch, { map: s.map, mode: b.mode, terrain, owner, strength });
  }

  function syncMobileUI() {
    if (!document.body.classList.contains('mobile')) return;
    const s = Editor.getState();
    if (!s.map) return;
    document.querySelectorAll('#mobile-toolbar [data-tool]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tool === s.tool);
    });
    mobileBrush.classList.toggle('active', s.tool === 'paint');
    mModeAll.checked = s.brush.mode === 'all';
    mModeTerrain.checked = s.brush.mode === 'terrain';
    mModeStrength.checked = s.brush.mode === 'strength';
    $('m-mode-value').textContent = s.brush.mode === 'all' ? '全部' : s.brush.mode === 'terrain' ? '仅地形' : '仅兵力';
    $('m-terrain-value').textContent = MapConst.TERRAIN_LABELS[s.brush.terrain] ?? s.brush.terrain;
    $('m-owner-value').textContent = ownerLabel(s.brush.owner, s.map);
    $('m-strength-value').textContent = s.brush.strength;
    mStrength.value = s.brush.strength;
    buildTerrainPalette();
    buildOwnerPalette();
    drawBrushPreview();
  }

  /** 布局切换：把右侧面板/随机生成模块在「主区 ↔ 弹窗」之间搬移，避免维护两套 DOM */
  function applyMobile(mobile) {
    closeDlg(dlgSettings);
    closeDlg(dlgGenerate);
    closeDlg(dlgMore);
    closeDlg(dlgServerImport);
    uploadMenu.hidden = true;
    const was = document.body.classList.contains('mobile');
    if (mobile === was) return;
    document.body.classList.toggle('mobile', mobile);
    const mainEl = document.querySelector('main');
    const leftAside = $('left');
    const rightAside = $('right');
    const genPanel = $('gen-panel');
    if (mobile) {
      document.querySelector('#dlg-settings .dlg-body').appendChild(rightAside);
      document.querySelector('#dlg-generate .dlg-body').appendChild(genPanel);
    } else {
      mainEl.appendChild(rightAside);      // 原位于 main 末尾（right-resizer 之后）
      leftAside.appendChild(genPanel);     // 原位于左栏末尾
    }
    syncMobileUI();
  }

  // 免审核资格提示弹窗：确定/取消/关闭/ESC 各自回落到 Promise 结果
  const uwDlg = $('dlg-upload-warn');
  let uwResolve = null;
  function uwFinish(v) {
    const resolve = uwResolve;
    uwResolve = null;
    if (uwDlg.open) uwDlg.close();
    if (resolve) resolve(v);
  }
  $('uw-ok').addEventListener('click', () => uwFinish(true));
  $('uw-cancel').addEventListener('click', () => uwFinish(false));
  $('dlg-upload-warn-close').addEventListener('click', () => uwFinish(false));
  uwDlg.addEventListener('cancel', (e) => { e.preventDefault(); uwFinish(false); });

  // ---- 事件绑定 ----
  document.querySelectorAll('#mobile-toolbar [data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => Editor.setTool(btn.dataset.tool));
  });
  $('btn-undo-m').addEventListener('click', () => Editor.undo());
  $('btn-redo-m').addEventListener('click', () => Editor.redo());

  $('btn-settings-m').addEventListener('click', () => dlgSettings.showModal());
  $('dlg-settings-close').addEventListener('click', () => closeDlg(dlgSettings));
  $('dlg-generate-close').addEventListener('click', () => closeDlg(dlgGenerate));
  // 点击「生成随机地图」后关闭弹窗（实际生成由 main.js 的 btn-generate 处理器负责）
  $('btn-generate').addEventListener('click', () => closeDlg(dlgGenerate));

  // ＋：新建 / 本地导入 / 地图码导入 / 服务器导入 / 随机生成
  // 前四项沿用桌面端既有流程（顶栏按钮在窄屏只做隐藏，click 处理器不变，行为与原来完全一致）
  $('btn-more-m').addEventListener('click', () => {
    uploadMenu.hidden = true;
    dlgMore.showModal();
  });
  $('dlg-more-close').addEventListener('click', () => closeDlg(dlgMore));
  document.querySelectorAll('#dlg-more .mm-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      closeDlg(dlgMore);
      switch (btn.dataset.act) {
        case 'new': $('btn-new').click(); break;
        case 'open': $('btn-open').click(); break;
        case 'mapcode': $('btn-mapcode').click(); break;
        case 'server':
          dlgServerImport.showModal();
          $('m-server-search').focus();
          break;
        case 'random': dlgGenerate.showModal(); break;
      }
    });
  });
  $('dlg-serverimport-close').addEventListener('click', () => closeDlg(dlgServerImport));

  // 📤：导出 JSON / 导出到服务器（导出到服务器前先查一次当前账号的积分与对局数）
  $('btn-upload-m').addEventListener('click', () => {
    uploadMenu.hidden = !uploadMenu.hidden;
  });
  document.querySelectorAll('#upload-menu button[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      uploadMenu.hidden = true;
      if (btn.dataset.act === 'json') $('btn-export').click();
      else exportToServerFlow();
    });
  });
  // 点击菜单外任意处收起
  document.addEventListener('click', (e) => {
    if (e.target.closest('#mobile-actions')) return;
    uploadMenu.hidden = true;
  });

  // 免审核上传资格：积分 < 150 且对局数 < 10 → 先弹提示确认，仍要继续才上传
  function confirmUploadWarn() {
    return new Promise((resolve) => {
      uwResolve = resolve;
      uwDlg.showModal();
    });
  }
  async function exportToServerFlow() {
    const s = Editor.getState();
    if (!s.map) {
      if (act.statusMsg) act.statusMsg('没有地图可上传', 'error');
      return;
    }
    let qualified = false;
    try {
      const stats = await IO.loadMyStats(act.serverUrl ? act.serverUrl() : '');
      qualified = stats.score >= 150 || stats.matches >= 10;
    } catch {
      qualified = false; // 未登录 / 取不到统计 → 按未获得免审核资格处理
    }
    if (!qualified && !(await confirmUploadWarn())) return;
    $('btn-save').click(); // 复用「保存到服务器」流程（id 白名单 + 结构校验 + 结果提示）
  }

  // 模式复选框：互斥，始终恰好勾选一个；选定后收起面板
  function setMode(mode, self) {
    [mModeAll, mModeTerrain, mModeStrength].forEach((c) => { if (c !== self) c.checked = false; });
    Editor.setBrush({ mode });
    $('mb-pop-mode').hidden = true;
  }
  mModeAll.addEventListener('change', () => { if (mModeAll.checked) setMode('all', mModeAll); else mModeAll.checked = true; });
  mModeTerrain.addEventListener('change', () => { if (mModeTerrain.checked) setMode('terrain', mModeTerrain); else mModeTerrain.checked = true; });
  mModeStrength.addEventListener('change', () => { if (mModeStrength.checked) setMode('strength', mModeStrength); else mModeStrength.checked = true; });

  // 兵力：输入即应用（input 实时 + change 失焦提交），保证任何环境都能生效
  function applyStrength(v) {
    Editor.setBrush({ strength: v });
    $('m-strength-value').textContent = v;
  }
  mStrength.addEventListener('input', () => {
    applyStrength(Math.max(0, Math.min(255, Math.round(Number(mStrength.value) || 0))));
  });
  mStrength.addEventListener('change', () => {
    const v = Math.max(0, Math.min(255, Math.round(Number(mStrength.value) || 0)));
    mStrength.value = v;
    applyStrength(v);
  });
  $('m-strength-ok').addEventListener('click', () => { $('mb-pop-strength').hidden = true; });

  // 四个参数框：点击展开对应选项面板（同一时刻只开一个）
  document.querySelectorAll('#mobile-brush .mb-box').forEach((box) => {
    box.addEventListener('click', (e) => {
      if (e.target.closest('.mb-pop')) return; // 面板内点击由面板自身处理
      const pop = box.querySelector('.mb-pop');
      const willOpen = pop.hidden;
      document.querySelectorAll('#mobile-brush .mb-pop').forEach((p) => { p.hidden = true; });
      if (willOpen) pop.hidden = false;
    });
  });
  // 点击底栏外任意处收起所有面板
  document.addEventListener('click', (e) => {
    if (e.target.closest('#mobile-brush')) return;
    document.querySelectorAll('#mobile-brush .mb-pop').forEach((p) => { p.hidden = true; });
  });

  Editor.onUI(syncMobileUI);
  // 旗帜精灵（含镂空断兵）加载完成后重绘预览，避免首次显示兜底色块
  HexRender.onSpriteReady(drawBrushPreview);

  // 启动与响应式切换
  applyMobile(MQ.matches);
  function checkMQ() { applyMobile(MQ.matches); }
  MQ.addEventListener('change', checkMQ);
  window.addEventListener('resize', checkMQ);
  // 兜底：部分嵌入环境不派发 matchMedia/resize 事件，观察画布容器尺寸变化重新判定
  new ResizeObserver(checkMQ).observe(document.getElementById('canvas-wrap'));
})();
