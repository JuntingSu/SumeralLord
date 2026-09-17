# AI 参与对局机制修改方案：AI 决策服务端托管（ai-bot 子进程）

> 版本：v1.0（2026-09-07）
> 分支：`bugfix/ai-turn-freeze`（自 `feat/ai-difficulty-1` 拉出）
> 状态：**已实施（2026-09-07）**——后端 158 / shared 97 测试全绿，前端 typecheck/build/lint 通过。实施明细见 §十。
> 实施前必须先读本方案；与既有文档冲突处，以本方案为准并回改文档。

## 一、背景与问题

### 1.1 现状

94040c9（feat(ai): 难度1 AI 策略实现「意图入流」）之后，AI 回合推进机制为：

- `reducer.runPreparePhaseContent` **不再自动完成 AI 回合**——轮到 AI 席位停在 `ACTION`/`ADD_POINT`；
- 由**提交方客户端**（在线参战玩家中 userId 最小者的浏览器）调用 `planAiTurn` 生成意图，经 `AI_INTENT_SUBMIT` 逐条提交；
- 服务器仅中继广播（`from:'AI'`），各端 reducer 以 `PLAYER seat=aiSeat` 应用；回放直接应用记录意图。

### 1.2 已排查证实的问题（分支 `bugfix/ai-turn-freeze` 排查结论）

1. **根因一：提交方判定依赖 Game 页拿不到实时性的房间在线数据，导致任何难度均无人驱动 AI 而卡死。**
   - `frontend/src/stores/game.ts` 的 `isAiSubmitter` 依赖 `useRoom.getState().room.players[].online`；
   - Room 页跳转 Game 页时，`Room.tsx` 卸载清理 `client.close()` + `useRoom.reset()`，旧 WS 关闭使服务器标记玩家离线（`gateway.ts` close 处理）；
   - Game 页仅一次性 `getRoom` 兜底拉取（`Game.tsx`，且 `room?.id !== data.id` 才 setRoom），大概率抓到 `online=false` 的过期数据；
   - Game 页期间 `ROOM_UPDATE` 不被处理（`applyServer` 仅在 Room 页接线），房间 store 的 `online` 永不刷新；
   - 结果：`isAiSubmitter` 恒 false → `driveAi` 首步 return → AI 意图一条都发不出去。日志实证：98 局含 AI 对局中 93 局零 AI 意图，0 局 AI 走完回合。
2. **根因二：意图被 reducer 拒绝时无人重新驱动，形成永久死锁。**
   - `applyStreamMessage` 在 `applyIntent` 返回 `!ok` 时只推进游标就 return，不调用 `driveAi`；
   - 而 `driveAi` 提交时已自增 `aiPlan.next`、ACK 后已清 `aiWaitingAck`；
   - 一旦某条 AI 意图被拒（如状态分歧），之后没有任何事件再触发 `driveAi` → 整局冻结。

### 1.3 结论

reducer、`planAiTurn`、服务器中继本身均正确；故障全部落在"谁来提交、何时提交"这一层。故将 AI 决策整体迁移到服务器侧托管，从根上移除"浏览器当提交方"的设计。

## 二、目标

1. **AI 回合推进不依赖任何玩家浏览器**——无人连接时 AI 也照常行动。
2. **彻底移除前端提交方机制**，消除对房间在线数据/身份的依赖。
3. **保持既有不变量**：
   - 服务器仍不跑 reducer（只做中继与持久化，AI 的"第二权威"隔离在子进程内）；
   - AI 席位 `playerId = null`、`isAI = true` 不动；
   - AI 不参与积分结算、不进胜负名单、不进共识期望集合、不触发断线投降；
   - 回放直接应用记录意图，无需运行 AI。
4. **崩溃可恢复**：进程随时可杀、随时可全量重放恢复，提交天然幂等。

## 三、总体架构

```
┌───────────────────────────── 后端（game server）─────────────────────────────┐
│  api/rooms.ts start 路由 ── 存在 isAI 席位 ──► AiBotManager.spawn(game)         │
│                                                     │ spawn 子进程（node）       │
│  AiBotManager（生命周期：spawn/kill/watchdog）        ▼                          │
│  WsGateway ── /ws-bot 升级路径 ◄───────────  ai-bot 进程（backend/src/ai-bot/） │
│    │  广播房间频道（INTENT_BROADCAST/…）              │ 读 game_logs/{gameId}.jsonl│
│    │  AI_INTENT_SUBMIT 中继（from:'AI'）              │ 重放重建权威状态           │
│    └──► 各玩家/观战前端（仅应用广播，不再演算 AI）     │ 轮到 AI 席位→planAiTurn    │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **每局一个 ai-bot 子进程**，进程生命周期 = 对局生命周期；房间销毁是对局未结束时的兜底 kill。
- bot 复用现有 `AI_INTENT_SUBMIT` 路径：服务器中继成 `from:'AI'` 广播，reducer/协议/日志格式零改动。

## 四、设计决策

| 编号 | 决策 | 说明 |
|---|---|---|
| D1 | 进程生命周期 = 对局生命周期 | 开局 spawn、对局结束（VICTORY/中止）kill；一个房间可连开多局，每局新进程 |
| D2 | 身份标识放连接层，AI 席位保持 `playerId=null` | bot 以无席位连接走 `/ws-bot` + `AI_INTENT_SUBMIT`；不给 bot 真实 userId（否则污染胜负名单/积分/断线投降） |
| D3 | 幂等 = 全量重放 | bot 重启不记忆任何跨重启计划；每次启动从对局日志全量重放重建状态，再从该状态规划 → 永不重复提交 |
| D4 | 拒绝即恢复 | 提交被拒（服务器 ERROR 或本地 reducer 拒绝）→ 补拉最新事件 → 重放 → 重规划，杜绝"拒绝即死锁" |
| D5 | AI 豁免不变 | 结算/胜负/共识/断线投降对 AI 的豁免维持现状（见 §5.6），新增测试锁定 |
| D6 | 可靠性主机制 = 崩溃 watchdog + 重放恢复；定时重启仅作慢速兜底 | 定时重启不解决两次重启之间的崩溃窗口 |
| D7 | AI 战胜人类时的账目（2026-09-07 用户拍板：**AI 胜局人类记败**） | 当 AI 势力获胜（`winners` 为空但存在人类败者）时：人类参战者按**战败**计入对局数与积分（支付侧按 0 和制扣分，获胜池无人领取作废），不再视同平局；AI 仍不参与积分 |

## 五、详细设计

### 5.1 shared 层：零改动

- `packages/shared/src/game/reducer.ts`、`ai.ts`、`protocol.ts` 均不动。
- AI 意图以 `actor {kind:'PLAYER', seat: aiSeat}` 入流是既有语义；`AI_INTENT_SUBMIT` 消息结构不变，bot 直接复用。

### 5.2 bot 连接通道（`backend/src/ws/`）

1. **Bot 会话服务**（新增 `BotSessionService` 或扩展 `TicketService`）：
   - `issueBot(gameId, roomId): string`：一次性 botToken ↔ {gameId, roomId} 绑定，spawn 时签发、对局结束/房间解散时失效。
2. **`/ws-bot` 升级路径**（新增，不改动现有 `/ws` 主路径，降低回归风险）：
   - 握手参数：`?token=&roomId=&gameId=&reducerVersion=`；
   - 校验 botToken 有效且绑定 gameId/roomId → 创建 `RoomConnection`，`role:'bot'`，`userId` 用保留哨兵 `-1`；
   - 无效 token → 直接拒绝（close）。
3. **网关豁免清单**（`gateway.ts`，逐项确认）：
   - `onAiIntentSubmit`：bot 连接放行（跳过 `fromSeat === -1` 拦截），仍校验 `aiSeat` 为 `game.seatAssignments` 中的 AI 席位；
   - `onConsensusResult`：`seatOf(-1) = -1` 天然忽略，bot 不投票；
   - 连接/关闭处理：`setOnline(-1,…)` 因 `room.players.get(-1) = undefined` 为 no-op；`seatOf(-1) = -1` → 不进断线时间线、不触发 120s 代发投降；
   - `publish(GAME_START)` 参与者在线标记：bot 的 seat=-1 自动跳过。
4. 广播：bot 订阅房间频道，正常收到 `INTENT_BROADCAST` / `CONSENSUS_CONFIRMED` / `GAME_OVER`；服务器 `broadcast` 对 bot 自身提交的意图不回环（排除 userId=-1，单局仅一个 bot，无冲突）。

### 5.3 ai-bot 子进程（新增 `backend/src/ai-bot/`）

**入口 `bot.ts`**：argv 接收 boot 文件绝对路径。

**boot 文件**（后端 spawn 时写入，如 `backend/data/bot_boot/{gameId}.json`）：
```jsonc
{
  "gameId": "gxxxx", "roomId": "rxxxx",
  "logFile": "backend/data/game_logs/gxxxx.jsonl", // GAME_START 为首行，其后按 eventId 追加事件
  "wsUrl": "ws://127.0.0.1:4096/ws-bot?...",
  "botToken": "<一次性>",
  "reducerVersion": "dev-0.1.0"
}
```

**启动流程**：
1. 读 `logFile` 首行（GAME_START）→ 取 `map / seatAssignments / seed / timeSettings`；
2. `initState(...)` 初始化 board；
3. 顺序应用日志中全部已记录意图（`INTENT_BROADCAST`，按 eventId；`CONSENSUS_CONFIRMED`/`GAME_OVER` 仅标记）——**全量重放，不记忆上次计划**；
4. 建立 `/ws-bot` 连接（`reducerVersion` 不一致即 4003 关闭，与玩家同规）。

**运行循环**（移植前端 `applyStreamMessage` 的**应用部分** + `driveAi` 的**判定部分**，去掉 UI/动画/共识上报/`isAiSubmitter`）：
- 每条 `INTENT_BROADCAST` / 本端 `INTENT_ACK` → 应用到本地 board；
- 应用后驱动检查：`board.currentSeat` 为 AI 席位（`seatAssignments[].isAI`）且 `phase ∈ {ACTION, ADD_POINT}` 且无在途提交 → `planAiTurn(board, seat)`（难度 1 → intents；2/3/255 → `skip` 展开为 `SWITCH_PHASE`）→ 逐条 `submitAiIntent`，ACK 后应用再提交下一条；
- 本地应用遇到 `!ok`（拒绝）：视为状态分歧 → 补拉（重读日志尾部或 `/api/game/:id/events?after=lastApplied`）→ 重放 → 重规划（D4）。

**幂等性论证（D3）**：服务器在提交时分配 eventId、追加日志与广播是原子的；日志即真相。bot 每次启动都从日志全量重放，规划永远基于"已入流事件之后"的状态 → 重启不会重复提交任何已入流意图。

**退出条件**：收到 `GAME_OVER`；收到 SIGTERM（后端 kill）；WS 关闭且日志尾部已出现 `GAME_OVER`（后端异常时兜底自退）。

**实现注意**：日志为追加写，读取时容忍尾部半行；bot 不写日志、不提交共识、不发 TIME_SYNC/CHAT。

### 5.4 生命周期管理（`backend/src/ai-bot/manager.ts`）

`AiBotManager`：
- `Map<gameId, ChildProcess>` + boot 文件记录；
- `spawn(game)`：仅当 `game.seatAssignments.some(a => a.isAI)`；写 boot 文件 → `spawn('node', [botEntry, bootPath])`（`tsx`/编译产物视运行方式）→ 注册 `on('exit')`：若对局仍 `in_game` 且未标记结束 → 按退避重拉（watchdog）；
- `kill(gameId)`：SIGTERM → 等待退出 → 清理 boot 文件；超时 SIGKILL；
- `dispose()`：服务器关闭时全量 kill。

**挂点（精确到函数）**：

| 时机 | 位置 | 动作 |
|---|---|---|
| 开局创建 | `backend/src/api/rooms.ts` `POST /api/rooms/:id/start`，`app.games.create(...)` 返回后 | `spawn(game)` |
| VICTORY 确认 | `gateway.ts onConsensusConfirmed`（`markFinished` / `rooms.finishGame` 后） | `kill(gameId)` |
| 对局中止 | `gateway.ts onConsensusFatal`（`markAborted` / `rooms.abortGame` 后） | `kill(gameId)` |
| 房间解散 | `rooms.disband` / 闲置清扫 `ROOM_DISBANDED` 分支 | `kill(gameId)`（对局未结束的兜底） |
| 服务器关闭 | `server.ts` 关闭钩子 / `WsGateway.close()` | `dispose()` |

**配置**（`backend/src/config.ts` 新增）：
- `aiBotEnabled`（默认 true，环境变量开关，测试可关）；
- `aiBotEntry`（bot 入口路径）；
- `aiBotRestartBackoffMs` / `aiBotRestartMax`（watchdog 退避）；
- `aiBotHealthRestartMs`（慢速兜底定时重启，默认 30 分钟，可选）。

### 5.5 前端清理（`frontend/src/`）

- `frontend/src/stores/game.ts`：
  - 删除 `isAiSubmitter`、`driveAi`、`skipIntents`、`aiPlan`、`aiWaitingAck`；
  - 删除全部 `driveAi(...)` 调用点：`startGame`、`applyStreamMessage`（实时路径尾部）、`attachTransport`、`catchUp`、`RECONNECT_ACK`；
  - 删除 `planAiTurn` 引入；`GameTransport.submitAiIntent` 与 `WsClient.submitAiIntent` 一并移除（或仅保留给 mock）；
  - **保留** reducer 应用路径（客户端仍须应用广播的 AI 意图，这是权威路径）。
- `frontend/src/mock/wsServer.ts`：保留 `submitAiIntent` 中继；可内嵌极简 AI 驱动（仅本地开发演示，显式标注 dev-only）——mock 与真后端互斥，无双驱动风险。
- `frontend/src/pages/Replay.tsx`：无需改动（回放直接应用记录意图）。

### 5.6 结算与历史（维持 AI 豁免，测试锁定）

- 现状已满足（无需改逻辑）：
  - `backend/src/stats/settlement.ts` `settleMatch` 仅结算 `playerId !== null && !isAI` 的席位 → AI 不参与积分；
  - reducer `victoryJudgeEvent` 的 winners/losers 仅收 `playerId !== null` → AI 不进胜负名单；
  - `game.expectedSeatsOf` 过滤 `!p.isAI`、`setConnected` 对 `isAI` 直接 return → AI 不参与共识与断线时间线。
- 决策点 D7（2026-09-07 拍板）：**AI 胜局人类记败**。
  - reducer 侧无需改动：`victoryJudgeEvent` 已把人类（`playerId !== null` 且非获胜队）写入 `losers`，AI 获胜时 `winners=[]`、`losers=[人类]`；
  - 结算侧（`settleMatch`）需区分"AI 胜局（`winners=[]` 且 `losers` 非空）"与"真平局"：AI 胜局按战败结算——计入对局数、人类按支付侧扣分（`computeScoreChanges` 的 `W=[]` 分支不再返回 `zeroChanges`，而是保留全员支付、获胜池作废），`wins+1` 不授予任何人；AI 席位仍不参与积分；
  - 历史/结算页展示：AI 胜局的人类显示"败"，不再显示"平局"。

## 六、实施计划

| 阶段 | 内容 | 主要文件 | 验收 |
|---|---|---|---|
| 0 | 现状确认（结算豁免/挂点/运行方式） | — | 本方案 §1/§5.4 核实 |
| 1 | bot 连接通道 | `backend/src/ws/gateway.ts`、新增 `BotSessionService`（或扩展 `ticket.ts`） | bot 可握手、收广播、放行 `AI_INTENT_SUBMIT`；玩家路径零回归 |
| 2 | ai-bot 进程 | 新增 `backend/src/ai-bot/bot.ts`（boot 读取、日志重放、运行循环、驱动判定、拒绝恢复、退出） | 单测：bot 驱动完整 AI 回合 |
| 3 | 生命周期管理 | 新增 `backend/src/ai-bot/manager.ts`、`backend/src/config.ts`、`api/rooms.ts`、`gateway.ts` 挂点 | 单测：开局 spawn、结束/中止/解散/关闭 kill、崩溃重启 |
| 4 | 前端清理 | `frontend/src/stores/game.ts`、`mock/wsServer.ts`、`ws/client.ts` | 前端 build/typecheck/lint 通过；双驱动消除 |
| 5 | 结算与历史 | 仅测试 | AI 不参与积分/胜负名单用例（含 AI 胜局） |
| 6 | 测试与回归 | `backend/tests/` 新增 `ai-bot.test.ts` 等 | 见 §七 |
| 7 | 部署确认 | 打包脚本、`coding.md` | 生产包含 bot 入口与 `@dl/shared`；本机同机部署 |

## 七、测试计划

1. **bot 驱动完整 AI 回合**：创建含 AI 席位对局 → 进程内运行 bot 模块 → 断言 AI 意图按 eventId 递增入流、回合正常轮转到人类席位；
2. **崩溃重启幂等**：bot 提交 N 条后杀进程 → 重启 → 断言无重复意图（eventId 连续、无跳号重放）且回合继续走完；
3. **生命周期**：VICTORY / 共识中止 / 房间解散 / 服务器关闭均正确 kill 子进程（无僵尸）；
4. **豁免锁定**：结算排除 AI；bot 连接不触发断线时间线/代发投降；bot 不投票共识；
5. **拒绝恢复**：人为构造状态分歧 → bot 补拉重放后继续推进（不冻结）；
6. **回归**：shared 97 / 后端既有测试全绿；前端 build/typecheck/lint。

## 八、风险与约束

1. **双驱动风险**：前端清理不彻底会与 bot 同时提交——阶段 4 必须与阶段 1-3 同版发布，禁止混合版本部署；
2. **进程管理复杂度**：Windows 下 kill 语义、孤儿进程清理、boot 文件残留需覆盖（超时 SIGKILL + 启动清扫）；
3. **日志并发读**：logFile 追加写与 bot 读取并发，须容忍尾部半行；
4. **单点窗口**：bot 崩溃到 watchdog 重拉之间 AI 短暂冻结，窗口 = 重放耗时（千级事件毫秒级），可接受；
5. **服务器重启**：对局本体在内存，重启即丢失（既有行为）；bot 连接断开后自退，无跨重启存活需求；
6. **AI 全 AI 对局**：`endTurnEvent` 的"无存活人类即结束"（M4 防卡死）维持不变，不在本次范围内放开。

## 十、实施记录（2026-09-07）

| 阶段 | 落地文件 | 说明 |
|---|---|---|
| 1 | 新增 `backend/src/ws/botSession.ts`；改 `backend/src/ws/gateway.ts` | `/ws-bot` 升级路径、`role:'bot'` 连接（userId=-1）、`onAiIntentSubmit` 放行 bot、ROOM_DISBANDED/VICTORY/中止 kill 挂点、`settleMatch` 传 `winningTeam` |
| 2 | 新增 `backend/src/ai-bot/bot.ts` | LogTailReader 增量读日志、全量重放、WS 实时流、逐条驱动（每次重新规划，重启幂等）、ERROR 重放恢复、SIGTERM/GAME_OVER 退出 |
| 3 | 新增 `backend/src/ai-bot/manager.ts`；改 `backend/src/app.ts`、`backend/src/api/rooms.ts`、`backend/src/declarations.d.ts`、`backend/src/config.ts` | spawn（仅含 AI 席位、wsPort 取实际监听端口）、崩溃指数退避重拉（对局不在进行不重拉）、kill/dispose、boot 文件清理；`app.aiBots`/`app.botSessions` 装饰与 onClose 清理 |
| 5 | 改 `backend/src/stats/settlement.ts`、`backend/src/ws/gateway.ts`、`frontend/src/pages/Result.tsx` | D7：`computeScoreChanges(players, {emptyWinnersAsLoss})`；`settleMatch` 判定 `aiWon = winningTeam !== -1 && winners.length===0` → 人类按战败结算；Result 页显示"🤖 AI 势力获胜" |
| 4 | 改 `frontend/src/stores/game.ts`、`frontend/src/ws/client.ts`、`frontend/src/mock/wsServer.ts` | 移除 `driveAi`/`isAiSubmitter`/`aiPlan`/`aiWaitingAck`/`submitAiIntent` 全部调用与字段（mock 保留中继方法） |
| 6 | 新增 `backend/tests/ai-bot.test.ts`、`backend/tests/ai-bot-manager.test.ts`；改 `backend/tests/points.unit.test.ts` | 集成：真实子进程驱动 AI 回合（from:'AI' 广播、回合回轮）、VICTORY 后 kill、结算豁免；单测：spawn 参数/退避重拉/restartMax/kill/dispose；D7 结算纯函数用例 |
| 7 | `backend/src/config.ts` | `aiBotEnabled`（`AI_BOT_ENABLED=0` 关闭）、`aiBotRestartBackoffMs`、`aiBotRestartMax` |

回归：shared 97、backend 158（原 147 + 新 11）、lint、前端 typecheck/build 全绿。

## 九、文档回改（实施时同步）

- 《数字领主-后端实现方案》：AI 意图来源条目由"提交方客户端"改为"服务端 ai-bot 子进程"；
- 《数字领主-前端实现规划（修订v3）》：移除提交方/AI 驱动相关描述；
- 《AI行动规则.md》 / 《AI难度1技术文档.md》：补充服务端托管说明；
- `coding.md` §5 质量基线：更新测试数、里程碑进度；
- 本方案为实施依据，冲突处以本方案为准。
