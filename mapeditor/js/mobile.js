/**
 * mobile.js — 手机端适配（在 main.js 之后加载）
 * 窄屏时：隐藏两侧侧边栏，只显示地图区域；
 * 左上悬浮 涂刷/拖动/撤回/前进（仅图标）；右上 齿轮（设置）/ 骰子（随机生成）按钮；
 * 涂刷模式下底部一条参数栏：模式/地形/归属/兵力 四个框，点击弹起选项面板（仿服务器地图搜索下拉）；
 * 右侧面板整块移入齿轮弹窗，随机生成模块移入骰子弹窗（内容与桌面端完全一致）。
 * 依赖全局：Editor / MapConst。
 */
(() => {
  const $ = (id) => document.getElementById(id);

  const dlgSettings = $('dlg-settings');
  const dlgGenerate = $('dlg-generate');
  const mobileBrush = $('mobile-brush');
  const mModeAll = $('m-mode-all');
  const mModeTerrain = $('m-mode-terrain');
  const mModeStrength = $('m-mode-strength');
  const mStrength = $('m-strength-input');

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
  }

  /** 布局切换：把右侧面板/随机生成模块在「主区 ↔ 弹窗」之间搬移，避免维护两套 DOM */
  function applyMobile(mobile) {
    closeDlg(dlgSettings);
    closeDlg(dlgGenerate);
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

  // ---- 事件绑定 ----
  document.querySelectorAll('#mobile-toolbar [data-tool]').forEach((btn) => {
    btn.addEventListener('click', () => Editor.setTool(btn.dataset.tool));
  });
  $('btn-undo-m').addEventListener('click', () => Editor.undo());
  $('btn-redo-m').addEventListener('click', () => Editor.redo());

  $('btn-settings-m').addEventListener('click', () => dlgSettings.showModal());
  $('dlg-settings-close').addEventListener('click', () => closeDlg(dlgSettings));
  $('btn-generate-m').addEventListener('click', () => dlgGenerate.showModal());
  $('dlg-generate-close').addEventListener('click', () => closeDlg(dlgGenerate));
  // 点击「生成随机地图」后关闭弹窗（实际生成由 main.js 的 btn-generate 处理器负责）
  $('btn-generate').addEventListener('click', () => closeDlg(dlgGenerate));

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

  // 启动与响应式切换
  applyMobile(MQ.matches);
  function checkMQ() { applyMobile(MQ.matches); }
  MQ.addEventListener('change', checkMQ);
  window.addEventListener('resize', checkMQ);
  // 兜底：部分嵌入环境不派发 matchMedia/resize 事件，观察画布容器尺寸变化重新判定
  new ResizeObserver(checkMQ).observe(document.getElementById('canvas-wrap'));
})();
