# 数字领主 · 回放查看器（train/replay-viewer）

独立对局回放播放器：**上传本地的 jsonl 对局日志 → 浏览器内本地解析重放**。
纯前端实现（复用主前端的 BoardCanvas + EventAnimator 与 `@dl/shared` reducer），
无后端、无鉴权、无数据库依赖 —— 任何人的对局日志都能播放。

## 使用

```bash
# 依赖复用 monorepo 根 node_modules（frontend 已装有 react/vite/tailwind，无需单独 install）
npx vite --port 5180          # 在 train/replay-viewer 目录下运行
# 或：npm run dev -w ... （若已加入根 workspaces）
```

打开 http://localhost:5180/ ：

1. 点击选择或直接拖入 `.jsonl` 对局日志（如 `backend/data/game_logs/g12345678.jsonl`）；
2. 页面自动开始播放：暂停/继续、1x/2x/4x 倍速、进度条拖动 seek（按意图数重放）、快进到结尾；
3. 点"选择其他文件"可换日志。

## 人工示范（演示操作 → 训练数据）

回放任意对局时，可把某个局面下的操作演示保存为训练示范（覆盖**行动阶段 + 加点阶段**）：

1. 拖动进度条**停在行动或加点阶段**（按钮在此阶段才可点击），点工具栏「示范操作」进入演示模式；
2. 在棋盘上演示：行动阶段点己方有移动力的兵选中 → 点目标格移动（空地）/ 进攻（敌方）；可连续操作（自动续选）；
3. 点「切换阶段」结束行动进入加点；加点阶段点己方**连兵 +1 点**（可连点；点数用尽自动结束回合，也可再点切换阶段提前结束）；
4. 可「撤销」；点「示范结束」→ 示范 JSON 经 `/api/demo` 落盘到 `train/demos/demo-<时间戳>.json`；点「返回」则放弃本次演示。

**注意**：写盘端点仅在 **dev 模式**（`npx vite`）下由 vite 中间件提供；`vite preview` 等构建产物无此端点。训练侧（`npm run train`）每次拟合会以 200 倍权重并入 `train/demos/` 下的示范样本（删除文件即移除其影响），详见 `../docs/数字领主-人工示范注入训练-修改技术文档.md`。

## 日志格式（与 backend `game_logs/*.jsonl` 一致）

- 每行一条 JSON；
- 首行必须是 `GAME_START`（含 `map` / `seatAssignments` / `timeSettings` / `seed`），否则提示"不是有效的对局日志"；
- 后续为 `INTENT_BROADCAST` 意图流（`fromSeat` + `intent`），坏行与其他消息（`GAME_OVER` 等）自动忽略；
- 意图数无 500 条上限 —— 整文件一次性读入内存重放。

## 结构

```
src/
  App.tsx              上传页 + 播放页（从 frontend/src/pages/Replay.tsx 改造，去掉了后端拉取）
  components/BoardCanvas.tsx   与 frontend/src/components 同源（原样复制）
  canvas/animator.ts           与 frontend/src/canvas 同源
  game/fog.ts                  与 frontend/src/game 同源
  lib/flags.ts                 本地化：旗帜资源从 public/flags/ 加载（原版指向 /static/flags）
public/flags/*.png      旗帜 sprite（复制自 backend/static/flags）
```

`@dl/shared` 通过 vite alias 直接指向 `../../packages/shared/src/index.ts`（与主前端一致）。
