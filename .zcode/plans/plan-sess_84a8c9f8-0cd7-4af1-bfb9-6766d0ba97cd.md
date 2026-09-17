# 交付物：一份指导生产的 Markdown 设计文档（不写代码）

## 目标
产出一份可直接指导生产实现的设计文档（同仓库根目录现有《数字领主-后端实现方案.md》《数字领主-前端接口需求声明.md》风格），**本对话不写任何代码、不改任何文件**。

## 文档位置与命名
- 仓库根目录新建：`数字领主-积分统计与排行榜设计方案.md`

## 文档内容大纲（章节结构）

### 1. 需求概述与规则定义
- 积分：注册初始 100；对局 VICTORY 结算公式（支付积分 = round1(-20×本人分/本局真人参战者积分和)，胜 +30 / 败 -30，新分 = max(0, round1(原分+delta))，全部保留一位小数，round1=Math.round(x*10)/10）。
- 已确认决策：平局不结算积分；步数 = 对局流 INTENT_BROADCAST 条数（即回放"N 意图"）；中途离线（结算时 connected=false）即使队伍获胜也按败者结算；对局数 = 正常结束且步数>100 时房间内全部真人参战者（含离线、不含观战/AI）matches+1；防除零（积分和≤0 时 pay=0）。
- **补充需求（新）**：回放列表（"我的战绩"页对局记录列表）每局展示该玩家本局获得/失去的积分。

### 2. 数据模型设计
- `users` 表新增 `score REAL NOT NULL DEFAULT 100`；存量库迁移方案（PRAGMA table_info + ALTER TABLE，存量账号补 100 分）。涉及 `backend/src/db/schema.ts` 与 `backend/src/db/client.ts` 两处同步。
- `match_history` 表新增 `score_changes TEXT`（JSON，默认 '[]'）持久化每局结算明细：`[{ playerId, result: 'win'|'lose', offline: boolean, oldScore, delta, newScore }]`；平局/中止存空数组（中止局本身不写行）。同样两处 DDL 同步 + ALTER 迁移。

### 3. 结算流程设计
- 新增结算模块（建议 `backend/src/stats/settlement.ts`）：纯函数 `computeScoreChanges`（可单测）+ 编排函数 `settleMatch`（读参与者离线状态与积分快照→统计步数→判定胜负→写 match_history.score_changes→批量 UPDATE users.score/matches）。
- 接入点：`backend/src/ws/gateway.ts` `onConsensusConfirmed` VICTORY 分支，`recordMatchHistory` 之后调用。
- `backend/src/game/manager.ts` 新增 `countReplaySteps(game)`（读 JSONL 统计 INTENT_BROADCAST 条数）。
- 明确不做的：不改 users.wins、不建独立积分流水表（用 match_history.score_changes 一列承载）。

### 4. 后端 API 设计
- 共享类型：`UserPublic` 加 `score`；新增 `LeaderboardEntry/LeaderboardResult`；`MatchRecord` 加 `scoreChanges`（数组）。
- `GET /api/users/me`（返回本人最新 UserPublic，供统计展示）。
- `GET /api/leaderboard/:type`（type=score|matches；Top100 `ORDER BY DESC, id ASC LIMIT 100`，rank=位置；当前账号 rank=COUNT(大于本人)+1）。
- `GET /api/users/:id/history` 响应扩展：每行带 `scoreChanges`，前端取本人 delta 展示。
- 涉及文件：`backend/src/api/users.ts`、新增 `backend/src/api/leaderboard.ts`、`backend/src/app.ts` 注册、`backend/src/api/auth.ts` toUserPublic。

### 5. 前端改动设计
- `frontend/src/api/users.ts` 加 `fetchMe`；新增 `frontend/src/api/leaderboard.ts`。
- `frontend/src/pages/History.tsx`：顶部统计行（对局数 X · 当前积分 Y）；**列表每行新增"积分 +20 / -30"展示**（取 scoreChanges 中本人的 delta，平局/中止显示 —）。
- 新增 `frontend/src/pages/Leaderboard.tsx`（积分榜/对局数榜两 tab、Top100、当前用户高亮与排名）。
- `frontend/src/App.tsx` 注册 `/leaderboard` 路由；`frontend/src/pages/Lobby.tsx` 按钮行加"排行榜"入口。

### 6. 测试设计（写入文档，供生产实现时落地）
- 单元（`backend/tests/points.unit.test.ts`）：双人各100→胜120/败60；三人按比例；一位小数（S=300→pay=-6.7）；下限0；离线胜者按败者；积分和≤0 保护。
- 集成（`backend/tests/points.test.ts`，沿用 game.test.ts 的 buildApp+inject+WS 模式）：注册即100分；VICTORY 后分数与 score_changes 落库正确；步数>100 时 matches+1 且观战不加；中途离线按败者结算；中止局不结算；平局分数不变但步数>100 仍 matches+1；history 接口返回本人 delta；排行榜两榜排序/me.rank/限100；存量库 ALTER 迁移。
- 前端验证：`npm run typecheck -w frontend` + 浏览器手测两个页面。
- 验证命令：`npm run test -w backend`、两个 typecheck。

### 7. 文档还将包含
- 边界与注意事项（离线定义、快照一致性、并列排名、平局语义、步数口径）。
- 分步实施顺序（数据模型→结算→API→前端→测试）。

## 完成标准
- 仅在仓库根目录新增一份 Markdown 设计文档，不触碰任何代码文件、不运行代码。
- 文档覆盖上述全部章节，可直接据此生产实现。