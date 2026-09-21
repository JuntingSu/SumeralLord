# 任务：生成修改技术文档

在 `train/docs/` 下新建《数字领主-人工示范注入训练-修改技术文档.md》，内容如下（仅创建此文档，不写任何代码；后续实施另行开工）：

---

# 数字领主 · 人工示范注入训练 — 修改技术文档

> 版本：v0.1（草案，2026-09-20）；状态：待评审
> 关联：《数字领主-MCTS自训练环境设计方案.md》《数字领主-行动阶段决策规则.md》

## 1. 目标与背景
现有训练循环（自对弈 → 双快照样本 → pairwise 排序拟合 E_te 权重）由终局胜负信号驱动。新增**人工示范（Human Demonstration）**通道：用户在 replay-viewer 中浏览自对弈数据，在任意行动阶段局面演示自己的操作（MOVE/ATTACK 序列）；演示自动存为 `train/demos/` 示范文件；训练时以 **200 倍样本权重**并入拟合窗口，让 E_te 学会高估"用户偏好的局面"（通过价值函数间接模仿、可泛化）。
本阶段**不实现**"精确局面候选注入"；示范 JSON 预留 `positionHash` 字段以便未来扩展。

## 2. 数据流总览
replay-viewer 回放界面（停在某 ACTION 局面）→ 点击"示范操作" → 对局模拟界面（点击棋盘演示 MOVE/ATTACK、可撤销、"示范结束"）→ `POST /api/demo`（vite dev-server 中间件）→ `train/demos/demo-<ts>.json` → 训练时（train.ts → demos.ts）按 sourceGameId 定位源日志、重放至 turnStartEventId/startEventId、应用用户 intents → `teFeatures(操作后局面, 回合初局面, seat)` → `TrainSample{..., label:+1, weight:200}` → fitWeights 以 pairwise 权重 = Σ sample.weight/d² 并入 → E_te 新权重（增量拟合，锚点=当前权重）。

## 3. 示范文件规范（train/demos/demo-<ts>.json）
```json
{
  "id": "demo-<ts>", "createdAt": "ISO", "sourceGameId": "t-xxxxxx",
  "seat": 1, "turnStartEventId": 42, "startEventId": 57,
  "positionHash": "8位hex",
  "intents": [ {"intentType":"MOVE","from":3,"to":9}, {"intentType":"ATTACK","from":9,"to":10} ],
  "note": ""
}
```
字段语义：id 唯一标识；sourceGameId 源对局（GAME_START.gameId，训练侧扫描 logs 匹配，不依赖浏览器路径）；seat 示范势力（board.currentSeat）；turnStartEventId 该势力本回合 ACTION 相位边界事件 id（E_te 双快照"回合初"）；startEventId 用户开始演示时的事件 id（cursor）；positionHash 演示起点局面哈希（预留）；intents 仅 MOVE/ATTACK。约定：一局可导出多个示范；删除 train/demos/ 文件即移除影响。

## 4. replay-viewer 修改设计
### 4.1 本地写盘通道（vite.config.ts）
新增自定义 vite 插件 `demo-saver`：`configureServer` 挂 `POST /api/demo` 中间件——手动收集 body → JSON.parse → `mkdirSync(train/demos)` + `writeFileSync(demo-<ts>.json)` → 返回 `{ok, file}`；异常 500。仅 dev 模式（README 注明需 `npm run dev`）。写文件用 node:fs 直接写，不受 `server.fs.allow` 影响。
### 4.2 回放界面改动（App.tsx，现 ~331 行；已核实：parseLog:22 / replayTo:76 / 播放循环:179 / BoardCanvas 接入:290 全空回调）
1. 新增 `mode:'demo'`；
2. 工具栏加"示范操作"按钮：启用条件 `board && !board.finished && board.phase==='ACTION'`（非 ACTION 禁用+提示）；点击采集 seat/startEventId/turnStartEventId/positionHash，记录当前 board 引用为演示基线（reducer 不可变、applyIntent 不改入参），进入 demo 模式。
### 4.3 对局模拟界面（demo 模式）
- **4.3.1 回合边界**：在 replayTo/播放推进的逐条 applyIntent 循环中维护 `turnBoundaries: Map<seat, number[]>`——应用第 i 条意图后若 `phase==='ACTION' && currentSeat===seat` 且上一状态 currentSeat!==seat，则记录 i；turnStartEventId = ≤cursor 的最后一个。
- **4.3.2 棋盘交互**：BoardCanvas 不改（交互协议完备：selected/onTileClick 等 props、选兵高亮 :449-576、Pointer 事件 :589-638）。App 接线 `mySeat={seat} phase='ACTION' selected={demoSelected}`；handleDemoClick 模仿 Game.tsx handleTileClick(:297) 两步交互（选己方有移动力兵→点目标生成 MOVE/ATTACK→applyIntent 本地验证：ok 则 demoHistory 入栈+自动续选(仿 nextSelectedTile:722)；拒绝则通知原因不加入）。
- **4.3.3 撤销**：demoHistory 状态栈（存应用前状态）+ demoIntents 并行数组；撤销=pop+移除意图；栈空禁用；仅限本次演示内。
- **4.3.4 示范结束与通知**：校验 intents 非空 → 组装 JSON → POST /api/demo → 成功 toast「示范已保存 train/demos/demo-xxx.json」并自动返回回放；失败红字停留；顶部"返回"放弃不保存；toast 用 App 内简易 useState，不引库。

## 5. 训练侧集成
### 5.1 train/lib/demos.ts（新）
`loadDemos(dir)` 读 train/demos/*.json 并校验；`demoToSample(demo)`：①按 sourceGameId 扫描 logs GAME_START 首行定位日志（进程内 gameId→file 缓存）；②重放至 turnStartEventId（校验 phase==='ACTION'&&currentSeat===seat）得回合初局面、至 startEventId 得演示起点局面；③逐条应用 demo.intents，任何拒绝则整条跳过并警告；④返回 TrainSample{ features: teFeatures(操作后,回合初,seat), turn, area, dToEnd:1, label:1, weight:200 }。容错：日志缺失/不一致 → null 跳过。
### 5.2 TrainSample 权重（driver.ts + fitter.ts）
TrainSample 增 `weight?:number`（缺省 1）；fitWeights 的 pairwise 权重改为 `pairWeight = (wS.weight??1)/d² + (lS.weight??1)/d²`——200 倍权重即此落点（重要性采样语义）。
### 5.3 train.ts runFit 集成
每次拟合窗口样本 ∪ 示范样本；日志追加"示范样本 +N（跳过 M）"；与增量拟合（--fit-anchor current）正交。

## 6. 测试与验收
| 项 | 内容 |
|---|---|
| train/tests/demos.test.ts | 构造迷你对局日志→demo JSON→断言 demoToSample features 6 维 / label+1 / weight200 / 回合边界正确；拒绝与缺失容错返回 null |
| fitter 加权 | 200 倍 vs 1 倍样本对比，断言 Σ weight/d² 生效 |
| viewer | tsc --noEmit + 人工验证（回放→示范→撤销→保存→落盘→toast→返回） |
| 回归 | vitest run 全绿后提交 |

## 7. 边界与不做事项
不做精确局面候选注入（positionHash 已预留）；演示仅限行动阶段 MOVE/ATTACK（非 ACTION 按钮禁用，不支持 ADD_POINT/SWITCH_PHASE/SURRENDER）；不做 demo 编辑/删除 UI（文件系统管理）；写盘仅 dev 模式。

## 8. 涉及文件清单
| 文件 | 动作 |
|---|---|
| train/replay-viewer/vite.config.ts | 改：demo-saver 写盘插件 |
| train/replay-viewer/src/App.tsx | 改：demo 模式/示范按钮/模拟界面/撤销/保存/toast |
| train/replay-viewer/src/components/BoardCanvas.tsx | 不改 |
| train/replay-viewer/README.md | 改：使用说明 |
| train/lib/driver.ts | 改：TrainSample.weight |
| train/lib/fitter.ts | 改：pairwise 权重乘样本 weight |
| train/lib/demos.ts | 新：示范加载/重放/样本构造 |
| train/scripts/train.ts | 改：runFit 并入示范样本 |
| train/tests/demos.test.ts | 新：示范管线单测 |
| train/demos/ | 新目录（首次保存自动创建） |

---

本次仅创建上述文档文件 `train/docs/数字领主-人工示范注入训练-修改技术文档.md`（内容如上），并 git 提交该文档；不修改任何代码。