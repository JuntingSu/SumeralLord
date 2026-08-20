# 《数字领主》开发流程与方法（agent 复用指南）

> 本文档从本项目已完成的三轮迭代（BM1/M1 → BM2/M2 → BM3/M3 + 两轮用户评审改动）中提炼，供后续 agent 接手开发时遵循。它回答："这个项目怎么干活"。

---

## 0. 项目背景与工作区结构

- **定位**：前后端分离的回合制游戏《数字领主》。架构决策：**对局逻辑前端本地权威**（reducer 即权威，各端按 eventId 序演算同一意图流），服务器只做 ①鉴权/房间 ②意图中继与 eventId 排序 ③全票共识收集 ④断线治理 ⑤聊天。朋友间娱乐定位，不做反作弊。
- **技术栈**：monorepo（npm workspaces）= `packages/shared`（协议单一事实来源）+ `backend`（Node 22 + TS + Fastify + ws + better-sqlite3）+ `frontend`（React 18 + Vite + Zustand + Tailwind v4）。
- **关键目录**：
  - `packages/shared/src/` — Zod schema、类型、常量（**改协议先改这里**）
  - `backend/src/` — api（路由）/ ws（网关）/ room / maps / auth / db
  - `frontend/src/` — pages / components / stores / api / ws / game
  - `数字领主-前端实现规划（修订v3）.md`、`数字领主-前端接口需求声明.md`、`数字领主-后端实现方案.md` — 三份规划文档，协议契约与架构决策的权威来源
  - `vip update/` — **用户拍板的补充决策备忘**（如 M4-备忘-无主势力开局与AI接管），实施对应里程碑前必须先读
- **环境**：Windows + Git Bash；Node 22；测试 vitest；无 lint 配置（tsc 严格模式作为门禁）。

---

## 1. 迭代开发流程总览

每个里程碑（BM1~BM6 ↔ M1~M7）遵循同一循环：

```
① 读规划文档 + vip update 备忘 → ② 共享协议先行（packages/shared）
→ ③ 后端实现 + 自动化测试（vitest）→ ④ 前端实现 + tsc/build 门禁
→ ⑤ 合并联调（浏览器黑盒 + 脚本客户端双端验证 + 截图）
→ ⑥ 同步修订规划文档（实现增补）→ ⑦ 汇报（含发现与修复的问题）
```

**铁律**：
1. **协议先行**：任何跨端数据（REST body、WS 消息、错误码、常量）先写进 `packages/shared`，前后端各自 `import`，禁止两端各自定义。
2. **测试驱动后端**：每完成一组接口/网关功能，立即补 vitest（fastify `inject` 集成测试 + 真 `ws` 客户端集成测试），全绿才进前端。
3. **构建门禁**：前端 `npm run build`（tsc --noEmit + vite build）零错误才允许联调。
4. **黑盒联调**：合并测试用真实 GUI 操作（浏览器自动化），DOM 快照 + 截图双验证，截图必须"看过"（读图）才算数。
5. **发现即修**：联调发现的问题当场修 + 补回归测试 + 在汇报中如实列出。
6. **文档同步**：接口/行为有增补时，回改《前端接口需求声明.md》等文档；用户新决策写进 `vip update/`。

---

## 2. 各阶段细则

### 2.1 规划与需求评审
- 用户提出改动 → 先**阅读相关规划文档与 vip update 备忘**，确认协议不漂移。
- 涉及架构级决策（权威方、反作弊程度、AI 优先级）用 AskUserQuestion 让用户拍板；拍板结果**写入备忘**（`vip update/`），回改文档。
- 里程碑实施前读对应备忘：如 M4 前必读 `M4-备忘-无主势力开局与AI接管-2026-08-16.md`（无主势力开局允许、初始化删兵、AI 接管语义、BM4 start 前置条件变更）。

### 2.2 共享协议先行
- `packages/shared/src/constants.ts`：错误码、WS 关闭码、时限、**可选项常量**（如 TIME_OPTIONS 计时下拉项与默认值——UI 选项也要放共享包，schema 按它枚举校验）。
- `protocol.ts`：REST body Zod schema + WS 客户端/服务器消息类型。schema 用 `refine` 做枚举校验；新消息类型在文档 §4 消息汇总表登记。
- `types.ts`：响应包裹、实体（RoomData/MapFullData 等）。**新字段必须加注释说明语义**（如 aiTakeover）。
- 改完共享包 → 后端 typecheck + 前端 typecheck 双端验证，确保没有遗漏引用。

### 2.3 后端实现
- 路由放 `src/api/*.ts`（Fastify 插件），`authPreHandler` 统一鉴权，错误统一 `RoomError` + `HTTP_BY_CODE` 映射 + `{ success, data?, code?, message? }` 包裹。
- 内存状态机（房间/对局）放 `src/room|game/manager.ts`，**状态变更即发事件**（`onEvent` 回调），WS 网关订阅并广播——状态层与传输层解耦。
- WS 网关：一次性 ticket 握手（失败用关闭码 4001/4002/4007）、心跳 30s/60s、同用户顶替（4006）、成员离线标记、CHAT 限流。
- **测试**（`tests/*.test.ts`）：
  - 集成测试用 `buildApp({ dbPath: 临时目录, logger: false, 注入短超时 })` + `app.inject()`，每个文件独立临时 DB。
  - WS 测试：`app.listen({ port: 0 })` 拿真实端口 + 真 `ws` 客户端；客户端**先挂监听再等 open**（避免丢早到消息）；条件等待支持谓词（避免命中旧消息）；顺序状态机用例共享变量。
  - 夹具与共享常量同步（如计时默认 60/1800/0 → 90/1200/0 时全部测试文件一起 sed 更新）。
- 运行：`npm run dev:backend`（tsx watch）；测试 `npm run test:backend`；typecheck `npm run typecheck:backend`。

### 2.4 前端实现
- API 层 `src/api/*.ts` 封装 fetch + JWT + 错误解析（`ApiError`）；**无 body 的 POST 不能带 Content-Type**（服务端拒空体）。
- 页面路由在 `App.tsx`（RequireAuth 守卫）；"我是否在某房间"以服务器为准（`GET /api/rooms/mine`），localStorage 仅作缓存。
- Zustand store：`auth`（token/user）、`lobby`（房间列表 + joinedRoom）、`room`（房间页 + 聊天 + 连接状态）。
- WS 客户端 `src/ws/client.ts`：ticket 握手、30s 心跳、指数退避重连（业务拒绝码 4001/4002/4007 不重连，4006 顶替可重连）。
- **表单/选择组件抽取**：地图筛选（MapPicker）、计时下拉（读共享常量）等跨页复用组件放 `components/`。
- 门禁：`npm run build`（frontend）零错误。

### 2.5 合并联调（黑盒测试）
- 启动：后端 `npm run start`（后台，`DL_DB_PATH` 指向 e2e 数据库）+ 前端 `npm run dev`（后台，`/api`、`/static`、`/ws` 已代理）。
- 双客户端：浏览器（内置 IAB，技能 `browser-use:web-gui-tester` + `control-browser`）作为"账号 A"，Node 脚本（如 `backend/scripts/e2e-player.mjs`）作为"账号 B"（REST 注册/登录/加入/准备 + 真 WS 收推送）——用于验证实时推送、踢人、断开等跨端行为。
- 浏览器操作要点：DOM 快照（`dom_cua.get_visible_dom` 的 `ref` 节点）点击/输入；`fill` 可代替键盘输入；**页面刚加载后等 3~5s 稳定**（vite 依赖优化会整页 reload）；同一页面长时间操作后指针点击可能失效——重开标签页。
- **每步双验证**：DOM 快照（结构/文本/状态）+ 截图（`tab.screenshot()` → 保存到 `gui-test-screenshots/` → Read 查看，必要时用图像分析工具确认视觉细节）。截图路径用**反斜杠转义或正斜杠**，中文目录名注意 URL 编码。
- 收尾：关标签页 → 停两个服务 → **杀孤儿进程**（Windows 上 npm 包装的 node 子进程会占端口）：`netstat -ano | grep :PORT | awk '{print $5}' | xargs taskkill //PID //F`。

### 2.6 汇报
- 格式：结论先行 → 交付内容 → 验证结果（表格：测试点/结果/证据截图）→ 发现并修复的问题 → 下一步。
- 用户验收过的改动（"我没有发现bug"）视为通过；用户提的改动要求立即整理成"修改计划"并确认后执行。

---

## 3. 常用命令速查

```bash
npm install                      # 根目录安装全部 workspace 依赖
npm run dev:backend              # 后端（3000）
npm run dev:frontend             # 前端（5173，代理 /api /static /ws）
npm run test:backend             # 后端 vitest 全部测试
npm run typecheck:backend        # 后端 tsc
npm run build:frontend           # 前端 tsc + vite build（门禁）
cd backend && npm run gen:maps / gen:flags   # 生成示例地图/占位旗帜
cd backend && node scripts/e2e-player.mjs <roomId>  # 脚本"第二玩家"
```

---

## 4. 常见坑清单（Windows/本项目实测）

| 坑 | 解法 |
|---|---|
| 端口 3000/5173 被孤儿进程占用，重启后端报 EADDRINUSE | `netstat -ano | grep ":3000"` → `taskkill //PID <pid> //F` |
| vite 首次启动后整页 reload（依赖优化），点击落在旧节点上 | goto 后等 3~5s 至快照稳定再操作 |
| IAB 指针点击突然无响应（fill/键盘仍可用） | 重开标签页 |
| `Edit` 报"文件已被修改"（之前用 sed/脚本改过） | 重新 Read 再 Edit |
| 无 body 的 POST 被服务端拒"Body cannot be empty" | client 只在有 body 时设 Content-Type |
| sed 批量改测试夹具后类型报错 | sed 只改文本，类型层面仍需手动过 |
| 中文/反斜杠路径进截图文件名或 CDN URL | 用正斜杠或转义；URL 编码中文 |
| 截图 emitImage 不显示 | 保存文件后 Read 查看；图像分析工具吃 CDN URL |

---

## 5. 质量基线（当前状态）

- 后端测试：85 个用例全绿（auth 17 + maps 6 + rooms 25 + ws 12 + game 17 + consensus 25）。
- shared 测试：81 个用例全绿（含 ai.test.ts 14 个 AI 策略层用例）。
- 前端：tsc 严格 + vite build 零错误。
- 文档：三份规划 + vip update 备忘 + M4/M5 流程文档保持同步；新增接口/错误码要回写《前端接口需求声明.md》。
- 已交付里程碑：M1~M3、**M4（对局核心闭环：后端 BM4~BM6 完整落地 + 前端对局界面）**、M5 的 AI 策略层（D3 拍板：难度 1~3 与 255 统一跳过 + 战场信息接口预留，`packages/shared/src/game/ai.ts`）。下一步：M5 主线——事件链动画播放器（M5.1）→ 棋盘拖拽缩放与 hollow sprite（M5.2）→ 对局内聊天（M5.3）→ 历史回放（M5.4，后端 BM7a）→ 战绩查询（M5.5，后端 BM7b）→ 收尾验收（M5.7）。详见《数字领主-M5开发流程设计.md》。
