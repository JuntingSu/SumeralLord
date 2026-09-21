执行《数字领主-人工示范注入训练-修改技术文档.md》（train/docs），实现"用户回放中演示操作 → 保存示范 JSON → 200 倍权重并入训练"全链路。已核实现状：所有功能均未实现，代码结构、reducer 回合边界、测试模式与文档描述一致。

## A. replay-viewer 前端（train/replay-viewer/）

**1. vite.config.ts — demo-saver 写盘插件**
- 新增自定义插件 `demo-saver`：`configureServer` 挂 `server.middlewares.use('/api/demo')`，POST 时解析 body → `mkdirSync(TRAIN_ROOT/demos, {recursive})` → 写 `demo-<Date.now()>.json` → 返回 `{ok, file}`；非 POST 或出错返回 500/next()。
- `TRAIN_ROOT = path.join(dirname(fileURLToPath(import.meta.url)), '..')`（即 train/），用 `node:fs` 直接写。

**2. src/App.tsx — demo 模式**
- `Mode` 增加 `'demo'`；新增状态：`demoState/demoSelected/demoHistory(栈)/demoIntents(并行数组)/demoSeat/demoStartEventId/demoTurnStartEventId/demoPositionHash/demoNote/demoError/saving` + 简易 `toast`（useState+定时清除，不引第三方库）。
- **回合边界表**（§4.3.1）：新增 `turnBoundariesRef = useRef<Map<number, number[]>>`，在 `replayTo` 与播放循环的逐条 `applyIntent` 处统一维护：应用第 idx 条意图后，若 `r.state.phase==='ACTION'` 且上一状态 `currentSeat !== r.state.currentSeat` → 向该 seat 压入 `idx+1`。已核实 reducer：`initState` 后即首势力 ACTION，后续回合切换（ADD_POINT 点数耗尽 → END_TURN → PREPARE → ACTION）全部发生在 applyIntent 内部，此规则可完整覆盖；首回合取 `turnStartEventId = 0`（=initState，语义正确）。
- 工具栏加"示范操作"按钮：`board && !board.finished && board.phase==='ACTION'` 才启用；点击采集 `seat/startEventId=cursor/turnStartEventId（≤cursor 的最后一个边界，无则 0）/positionHash=hashGameState(board)`，以当前 board 引用为演示基线，`setMode('demo')`。
- **棋盘交互**（§4.3.2，BoardCanvas.tsx 不改）：demo 模式给 BoardCanvas 传 `mySeat={demoSeat} selected={demoSelected} onTileClick={handleDemoClick} isSpectator fogEnabled={false} animatorRef={null}`；`handleDemoClick` 模仿 `frontend/src/pages/Game.tsx` 的 `handleTileClick` 两步交互（己方有移动力兵选中/取消 → 目标格敌兵 ATTACK/空格 MOVE/同队忽略），生成意图后 `applyIntent(demoState, {actor:{kind:'PLAYER',seat},intent})` 本地验证：ok → push 应用前状态入栈 + 应用 + 按 `nextSelectedTile` 模式自动续选；拒绝 → 展示 reason，不入栈。
- **撤销**（§4.3.3）：`demoState = demoHistory.pop()`，同步 `demoIntents.pop()`，栈空禁用。
- **示范结束/返回**（§4.3.4）：`demoIntents.length>0` 校验 → 组装 §3 JSON → `POST /api/demo` → 成功 toast「示范已保存到 …」并回回放；失败红字停留；"返回"按钮直接放弃回回放。
- demo 模式 UI：底部控制条替换为演示条（撤销/示范结束/返回/备注输入/错误提示），顶部显示"演示中"。

**3. README.md** — 补充：示范流程使用说明 + 仅 `npx vite`（dev 模式）可写盘、`vite preview` 构建产物无该端点。

## B. 训练侧（train/）

**4. train/lib/driver.ts** — `TrainSample` 新增 `weight?: number`（缺省 1，注释：示范样本 200 倍学习权重）。

**5. train/lib/fitter.ts** — `pairLoss`（:86）与主循环 pairWeight（:101）均改为 `(wS.weight ?? 1)/d² + (lS.weight ?? 1)/d²`；eval 计算不变（weight 只影响梯度缩放）。

**6. train/lib/paths.ts** — 新增 `DEMOS_DIR = path.join(trainRoot, 'demos')`。

**7. train/lib/demos.ts（新）**
- `DemoFile` 接口（id/createdAt/sourceGameId/seat/turnStartEventId/startEventId/positionHash?/intents/note?）、`DEMO_WEIGHT = 200`。
- `loadDemos(dir)`：读 `train/demos/*.json`，字段校验，非法文件警告跳过。
- `demoToSample(demo, logsDir?=LOGS_DIR)`：① 按 sourceGameId 扫描 `runs/logs/*.jsonl` 的 GAME_START 首行定位源日志（进程内缓存，按 logsDir 分键、mtime 变化重建）；② 同 viewer 规则解析日志 → initState；③ 重放到 turnStartEventId 校验 `phase==='ACTION' && currentSeat===seat`，重放到 startEventId 得演示起点；④ 逐条应用 demo.intents（actor=seat），任何拒绝则整体跳过并 warn；⑤ `features = teFeatures(操作后局面, 回合初局面, seat)`；⑥ 返回 `TrainSample{gameId:demo.id, mapId:源图id, seat, turn:操作后.turn, area:row*column, late:isLatePhase(操作后), features, dToEnd:1, label:1, weight:200}`。日志缺失/重放不一致 → null（调用方跳过）。

**8. train/scripts/train.ts** — runFit（:306）在窗口样本后并入 `loadDemos(DEMOS_DIR)` 的 `demoToSample` 结果（记录 +N 与跳过 M），日志追加 `样本 N（示范 +N，跳过 M）`；与 `--fit-anchor current` 增量拟合正交。

**9. train/tests/demos.test.ts（新）** — 参照 pipeline.test.ts 模式（temp dir + playSelfPlayGame 低预算日志）：
- demoToSample 主流程：迷你对局日志 → demo（seat1，turnStartEventId=0）→ 断言 6 维特征有限、label=+1、weight=200、dToEnd=1、mapId/seat/turn 正确；
- 回合边界：定位 seat2 首条意图 idx → 其 turnStartEventId=idx，断言 demoToSample 非 null 且重放至 idx 时 currentSeat===2；
- 容错：非法意图（空格 ATTACK）→ null；源日志缺失 → null；turnStartEventId 指向他人回合 → null；
- loadDemos 字段校验；
- fitter 加权：同样本集仅 weight 1 vs 200、同固定 rng（margin>0 保证有更新），断言 weight=200 时 `|Δweights.mid[0]|` 更大。

**10. train/demos/.gitkeep** — 新建目录（首次保存自动创建）。

## C. 验证
- `cd train/replay-viewer && npx tsc --noEmit`
- `cd train && npx vitest run`（全量回归，含新增 demos.test.ts）

涉及文件：replay-viewer/vite.config.ts、src/App.tsx、README.md（改）；train/lib/driver.ts、fitter.ts、paths.ts、scripts/train.ts（改）；train/lib/demos.ts、tests/demos.test.ts、train/demos/.gitkeep（新）。BoardCanvas.tsx 与共享 reducer 不改。