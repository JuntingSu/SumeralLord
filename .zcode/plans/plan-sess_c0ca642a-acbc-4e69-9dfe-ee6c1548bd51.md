# M4 阶段开发计划（对局核心闭环）

按《数字领主-M4开发流程设计.md》阶段顺序推进，每阶段过验收门槛（测试全绿）再进下一阶段。已拍板决策：**randomSpawn = 洗"玩家→势力"分配（势力/出生点不洗，兵严格按 battlefield 三元组置入，spawnAssignments 恒等映射）**；**AI computer 1~3 在 M4 一律按 255 跳过**；**联调以自动化集成测试为主 + 浏览器 GUI 抽查**。

## P0 前置清理（0.5~1d）

1. **文档回改**（M4 文档 §2.1 七项清单）：
   - 后端实现方案 §2.3：删"seat 全分配"校验、`SEATS_UNASSIGNED` 退役、改"至少 1 名非观战玩家"；写入 randomSpawn 新语义（开局洗玩家↔seat 分配，仅在原有玩家扮演的 seat 集合内重排）
   - 后端实现方案 §3.2 + 需求声明 §2.2：`seatAssignments = { seat, playerId|null, isAI }[]`（isAI = aiTakeover && playerId===null）；spawnIndex 语义改"据点（原王城）地块、恒等映射"；AI 难度由前端读 `map.player_list[].computer`
   - 后端实现方案 §8 决策表 #8、前端规划附录 B #5：AI 接管进 M4（255=reducer 内建跳过，1~3 按 255 处理、行为 M5+）
   - 需求声明 §1.3：`AI_NOT_SUPPORTED` 退役
   - 规则 v2：§3.1 标注王城已纠正、§6.3 补 randomSpawn 语义、§6.4 改 reducer 内建跳过、§12 两个待定项关闭/标已决
2. **王城→据点迁移**：`packages/shared/src/types.ts` 删 `TERRAIN.KINGDOM`（编码 2 空缺，注释防复用）；`gen-maps.mjs` 改据点生成并重生成 3 张图、`example.json` 手改；`catalog.ts` 校验去 terrain=2；`HexMapPreview.tsx` 删 2 分支、王城色并入据点色；`TILE_OWNER.LEISURE` 重命名为 `BLOCKER`（阻挡）
3. **常量入 shared**：`constants.ts` 增 `AI_LEVEL = {1,2,3,255}`（255=休闲跳过）
4. 门槛：后端 59 测试全绿、双端 `tsc --noEmit` 通过

## M4.1 reducer 与确定性基建（4~5d，`packages/shared/src/game/`）

- `game/types.ts`：GameState（turn/currentSeat/phase/forces/tiles[]/finished）、SoldierState、ForceState（含 exists 标记无主势力、isAI/computer）、四级 GameEvent 判别联合、ApplyResult/RejectReason、IntentEnvelope（intent + actor seat|'SERVER'）
- `game/constants.ts`：TERRAIN_PROPS 属性表（连通性/据点性/失活/反击/移动距离）、COUNTER_INFINITE（据点反击∞）
- `game/coord.ts` / `distance.ts`：even-r 邻居表（含滚筒 wrap）、整数 axial/cube 距离
- `game/initState.ts`：三元组直接置入（全断兵）→ 初始化事件级联重连（升序确定）→ 无主势力删兵（exists=false、不进轮转/胜负/共识）→ AI 保留进轮转 → 首回合准备阶段自动执行
- `game/reducer.ts`：规则 v2 §8 事件全集（一级 7 种/二级 3 种/三级重连断连/四级清除胜利），级联=同步递归+顺序记录；断连环图、断连判定 BFS、势力清除、胜利判定按规则实现；AI(255) 轮到即内建跳过（含连续 AI）；演算到 FORCE_CLEAR/VICTORY 同步产出共识上报任务；迭代顺序全部按线性 index 升序保证确定性
- `game/hash.ts`（稳定序列化+FNV 哈希）、`game/version.ts`（reducerVersion = 包版本+git short sha；后端启动时计算、前端 vite define 注入）
- vitest 接入 packages/shared；单测覆盖 M4 文档 §3.1 全清单（约 60+ 用例，按规则章节组织）
- ESLint flat config（root 安装 eslint+typescript-eslint）：`no-restricted-properties`(Math.random/Date.now/performance.now)、`no-restricted-syntax`(new Date、浮点字面量比较)，作用于 shared src 与前端 game/
- 黄金样本：JSONL 格式（meta+意图流+终局哈希）、录制/Node 重放比对测试

## BM4 开局+意图中继（backend，2d）

- `RoomManager.start()`：房主+全员(非观战)prepared+≥1 非观战玩家+全员 reducerVersion 一致；randomSpawn=true 时对玩家分配在原有 seat 集合内 Fisher-Yates 洗牌（服务器随机源）；生成 gameId/seed/恒等 spawnAssignments；广播 GAME_START；房间转 IN_GAME
- `game/manager.ts` + `game/eventLog.ts`：JSONL 对局流（INTENT/CONSENSUS_CONFIRMED/GAME_OVER 三类条目，eventId 单调）
- gateway 扩展：query 增 seat/asSpectator/reducerVersion；INTENT_SUBMIT 处理链（Zod→观战拒绝→eventId→持久化→ACK→广播）；CONNECT_ACK 扩展
- `api/game.ts`：`GET /api/game/:id/state`、`/events?after=` 分页
- shared protocol 补齐对局消息 schema（GameStartMsg/ReconnectMsg/ReconnectAckMsg/TimeSyncMsg/PlayerDisconnectMsg/PlayerReconnectMsg/GameOverMsg/GameStreamEntry）
- 测试：start 新前置、GAME_START 结构、eventId 单调、JSONL 读写、分页、观战拒绝、无主+AI 混编开局

## M4.2 Mock 对局闭环（frontend，5~6d）

- `stores/game.ts`：boardState/eventQueue（动画解耦）/appliedEventId 游标/clientTempId↔eventId 关联/EVENT_GAP 检测与补发接口
- `mock/wsServer.ts`：遵守 P1/P2 的假服务器（eventId 分配、ACK/广播、共识延迟回执、脚本对手、跳号模拟）；`VITE_USE_MOCK` 切换
- `pages/Game.tsx`（左状态栏/上个人状态/中间战场/底部阶段按钮+聊天）+ Result 结算弹窗 + `/game/:gameId` 路由
- `canvas/BoardCanvas.tsx` 双层画布：静态层（地形+旗帜+兵力，dirty 重绘）/动态层（hover/选中/反击着色/拖拽缩放）；旗帜 sprite 预加载、断兵 globalCompositeOperation 擦边
- 行动交互（点兵→反击着色→MOVE/ATTACK）、加点长按 150ms 累计+500ms 聚合、SWITCH_PHASE 意图化、投降按钮
- `game/fog.ts` 三档（visible/explored/hidden）+ `game/consensus.ts`（上报/比对/动画暂停兜底）
- 本地计时器（规则 §10：局时/步时/加时/同时归零步时优先、<10s 红闪）；观战视角全图无迷雾+灰禁
- 门槛：Mock 四用例（①1v1 打完含胜利共识 ②断连级联清除 ③加点+迷雾 ④并发意图）GUI 跑通

## M4.3 联调①（开局+意图按序）

前端 ws handlers 切真实 ACK/BROADCAST、api/game.ts 补发拉取、GAME_START→initState。自动化集成测试：真实 WS 双客户端 + 共享 reducer 双端重放 boardState 哈希一致 + 补发路径 + 无主/AI 混编。GUI 抽查双端一致。

## BM5 + M4.4 全票共识（2d+1d）

- ConsensusTracker（期望集合=在线参战−clearedSeats、去重取首条、全票确认/分歧/5s 超时、断线剔除复检、边界表）；GAME_OVER→match_history 结算（全部玩家场次+1、胜者胜场+1）；房间 GAME_OVER 状态+5min 回落
- 前端 consensus.ts 联调；联调三路径（确认/断线剔除凑齐/篡改分歧中止）

## BM6 + M4.5 断线重连+计时（3d+1~2d）

- disconnectWatch（10s 检测/120s 宽限/代发 SURRENDER(timeout)）、RECONNECT_ACK 分批重放（≤500）、TIME_SYNC 转发、idleSweeper 扩展（IN_GAME 4h/GAME_OVER 5min）；时间参数全部 config 可配（测试加速）
- 前端重连流程（重取 ticket→RECONNECT→去重追平）、4003 版本拒绝提示、TIME_SYNC 校正
- 联调：刷新/断网追平、代发投降各端一致、清理时间线（加速参数）

## M4.6 无主势力与 AI 收口（1~2d）

专项回归：连续 AI 依次跳过、AI seat 被清除后轮转正确、仅剩 AI 胜利判定、混编局（2 真人+1 无主+1 AI255）完整打完；AI/无主不进共识期望与结算列表。

## M4.7 收尾验收（1~2d）

中途观战全量重放+灰禁 UI；四批联调+Mock 四用例全量回归；第 8 章验收清单逐项打勾；文档同步（前端规划附录 A、后端方案 §6.1、规则 v2 §12、M4 文档）。

## 纪律

- 现有 59 后端测试保持全绿；reducer 改动后 L1 单测+黄金样本必跑
- 遵守确定性 lint；迭代/遍历顺序全确定
- 每阶段完成即汇报，验收不过不进下一阶段