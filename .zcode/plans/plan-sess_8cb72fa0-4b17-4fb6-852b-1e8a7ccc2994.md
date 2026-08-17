# 《数字领主》三份规划文档修订计划

依据已拍板的三项决策：**① 维持前端权威（服务器只中继+收共识）② 朋友间娱乐（迷雾装饰性、不追求反作弊）③ AI 仅保留接口（v1 不实现演算）**。修订只改文档，不动代码；每处变更在文首"修订说明块"集中标注，便于群内评审 diff。

---

## 一、协议层核心修订（三文档同步）

### P1 消除乱序分歧（最重要，改"乐观应用"为"按 eventId 序应用"）
- 前端规划 §4.2：删除"本地 boardState 立即更新"的乐观应用流程。新流程：玩家操作 → WS 发意图（带 `clientTempId`）→ 服务器分配 eventId 并回 `INTENT_ACK` → **所有客户端（含发送者）一律按 eventId 顺序把意图交给 reducer 演算**。发送者收到 ACK 且此前无 eventId 空洞时立即应用（即自己操作延迟约 1 个 RTT，回合制可接受）。
- 需求声明 §2.3 / 后端 §3.3.1：正式采纳后端质疑点 5 的 `INTENT_ACK { clientTempId, eventId }`，并写明发送方应用规则与广播顺序保证（广播序 = eventId 序）。

### P2 共识机制加固（改为"全票一致，否则中止"）
- 删除"按多数一致推进"（≥⌈expected/2⌉ 在 1v1 下单票即多数，公式失效）与"超时按已收到结果推进"（可被抢先谎报利用，也会让网络抖动产生错误胜负）。改为：**全票一致 → CONFIRMED；不一致或超时 → ERROR CONSENSUS_MISMATCH(fatal) 中止对局不结算**。
- 共识上报与动画解耦：收到意图即同步演算、立即上报；动画播放仅在"到达共识节点且 CONFIRMED 未到"时才暂停（改为兜底而非常态）。
- `expectedSeats` 重定义为**会话状态而非游戏状态**：当前在线的参战 seat − 已确认清除的 seat（后者从共识确认历史推导）。成员中途断线时从期望集合移除并复检，而非死等。
- `consensusId` 采纳后端简化方案：前端生成，格式严格约束 `{触发eventId}:{nodeType}:{seat}`（P1 之后触发 eventId 唯一，不再有归并歧义）。

### P3 断线防僵尸对局（v1 必须有）
- 服务器注入投降：参战玩家断线超过宽限期（建议 120s）→ 服务器以 `from: 'SERVER'` 身份注入一条该 seat 的 `SURRENDER` 意图并照常分配 eventId 广播，各端 reducer 确定性处理（服务器只执行会话规则，不算游戏逻辑，不违背前端权威）。
- 空闲扫描不再无限豁免对局中房间：对局房间改为硬上限（建议 4h）。
- 需求声明/后端方案新增 `SERVER_SURRENDER`（或复用 INTENT_BROADCAST 的 SERVER 来源标记）与 `PLAYER_DISCONNECT` 后的宽限期语义。

### P4 随机源由服务器下发
- `GAME_START` 采纳后端质疑点 1（不带 initialBoardState），并新增 `spawnAssignments`：`randomSpawn=true` 时由服务器洗牌生成出生点分配表下发；另附 `seed` 字段为未来扩展预留。前端 reducer 禁止一切本地随机性（见 P7）。

### P5 非法意图的确定性处理
- reducer 契约改为 `(state, intent) → { state', chain } | { state, REJECTED(reason) }`：非法意图产生确定性拒绝结果（状态不变），所有端以相同方式拒绝。前端类型层补充 `RejectedIntent`。服务器继续不校验、照常中继。

### P6 EVENT_LOG 语义统一
- 修正前端规划 §6.1 最后一处矛盾表述：WS 只承载意图（INTENT_BROADCAST），事件链是各端本地派生物，不作为 WS 推送类型；EVENT_LOG 一词退役，统一叫本地 `GameEvent[]` 日志。

### P7 确定性工程保障
- 共享包内新增 lint 规则：reducer 禁用 `Math.random` / `Date.now` / 浮点敏感运算 / 依赖排序稳定性的写法。
- CI 黄金样本测试：录制意图流 → Node 与浏览器双端重放比对事件链与最终 boardState（后端风险清单第 1 条的落地手段）。

---

## 二、后端方案结构调整（v1 服务器零 reducer）

- §0/§1.2 选型理由改写：AI 不做、快照后置后，v1 服务器**完全不运行 reducer**；Node+TS + monorepo 共享包的理由改为"共享协议类型与 Zod schema（协议单一事实来源）+ 为未来快照/AI 预留 reducer 接入位"。技术栈本身不变。
- 质疑点 2（快照）降级为 BM7+ 优化项：v1 断线重连/中途观战 = 按 eventId 全量分批重放（朋友间规模可接受），`GET /api/game/:id/state` 瘦身为只返回 `{gameId, status, winners, lastEventId, reducerVersion, participants}`（turn/phase 由前端重放自行推导，服务器不再需要知道）。
- 质疑点 7（AI 代演）从 v1 移除：`seatAssignments` 保留 `isAI` 字段，但 v1 开局校验禁止存在 AI seat（错误码 `AI_NOT_SUPPORTED`）。
- 采纳后端其余质疑点：1（GAME_START 瘦身）、3（删 PHASE_CHANGE/TURN_CHANGE 独立推送，重连走 state 接口）、4（TIME_SYNC 仅活动 seat 发）、6（观战发意图记 warn 日志+回 ERROR）、9（聊天规则澄清）、11（join 响应按 room.status 区分跳转）、12（reducerVersion 在 GAME_START 与重连时校验）。
- §4.1 共识收集器按 P2 重写；§4.2 房间状态机按 P3 修订（宽限期注入投降、对局硬上限）。
- §6 里程碑重排：BM5 缩短（无 AI），新增断线强制与共识加固工时；§8 决策点表更新为已拍板结果。

---

## 三、需求声明与前端规划其余修订

- **路径与包裹统一**：采用后端 RESTful 集（`POST /api/rooms`、`POST /api/rooms/:id/join` 等），响应统一 `{ success, data, code, message }`；删除前端声明中 `/api/rooms/create`、`/api/rooms/join` 旧写法；path adapter 保留用于兼容规则书原路径。
- **WS 认证**：改为 REST 换一次性 ticket（`GET /api/ws-ticket` → 5 分钟内一次性使用）再连 WS，替代 URL 长期 token；生产强制 wss。
- **大厅房间列表**：明确 v1 为轮询（5~10s），删除"WS 推送"表述（WS 通道需 roomId，v1 不做无 roomId 的大厅连接）。
- **计时语义小节（新增）**：精确定义步时（每次轮到该势力重置、行动+加点阶段共用）、局时（仅自己回合走表）、加时（触发与结算时机），标注 2 处需对照规则书原文确认的假设。
- **发版策略**：写入运维守则——有活跃对局时不下发新版本；重连遇版本不一致拒绝并提示"版本已更新，本局无法返回"；可选新增"新版本可用请刷新"预告推送（标记 nice-to-have）。
- **小项**：flags 路径统一为 `/static/flags/flag_{num}.png`；`Soldier.owner` 的 0/255 魔数改类型别名+discriminated union；4006 重复连接定义为"新连接顶替旧连接"；登录失败与 CHAT 增加内存级限流；多实例部署警告（v1 单进程，多实例需按 roomId 分片或 Redis，ip_hash 不是方案）。
- **排期修订**：M4 由 7-10d 调整为 12-18d（reducer 全规则+同步边界）；后端总工时相应更新。
- **风险清单更新**：僵尸对局/超时抢跑/1v1 多数派三条标记"已修复（P2/P3）"；新增"诚实客户端分歧仍会中止对局（可接受，朋友间场景）"、"迷雾对 devtools 无效（已声明，装饰性）"。

---

## 四、产出物

1. 《数字领主-前端实现规划（修订v3）.md》——文件名升级 v3，文首加修订说明块
2. 《数字领主-前端接口需求声明.md》——原地修订 + 修订说明块
3. 《数字领主-后端实现方案.md》——原地修订 + 修订说明块

每份文档的修订说明块列出：本轮决策（前端权威/娱乐定位/AI 仅接口）、协议变更表（P1-P7）、各节改动索引，方便群里评审时对照。