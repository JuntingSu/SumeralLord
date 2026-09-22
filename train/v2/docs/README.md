# 数字领主 AI 训练 v2 · 项目结构与训练流程总览

> **用途**：v2 训练工程（全动作空间原子 MCTS + Transformer 策略/价值网络 + 人类指导）的入口文档——目录结构、完整训练流程、常用命令、参数与产物。
> **版本**：v0.1（2026-09-22）。
> **关联**：各阶段文档见 §7 索引；设计决策源头《数字领主-AI训练方案v2-整体框架.md》（决策定稿）。

---

## 1. 项目定位

在 `train/v2/` 下从零实现 v2 训练体系，替代 v1（`train/v1/`，已归档，仅保留线上 bot 与验收基准用途）：

- **规则引擎只写一份**：对局演算全部复用 `@dl/shared` reducer，训练/部署/人类工具共用；
- **架构**：变长全格 token Transformer（策略 + 价值双头）→ 原子 MCTS（PUCT、根全展开）→ 自对弈数据（每步一条 (局面, π, z)）→ Python 拟合；
- **人类指导**：示范/纠错（λ_bc × 策略 CE）+ 偏好局面题/走法题（λ_pref × 价值排序）；
- **验收**：v2 AI（200 模拟 argmax）vs v1 基准（v45 权重），验收图池 200 局，胜率 > 65% 达标。

## 2. 目录结构

```
train/
├── maps/                      # 训练图池（100 张，共享）
├── eval-maps/                 # 验收图池（用户提供，7 张）
├── v1/                        # 旧训练（归档；@dl/train main 仍指向 v1/lib/online.ts 供线上 bot 使用）
└── v2/                        # ★ v2 训练工程（本文档主体）
    ├── lib/                   # TS 核心库（Node 侧）
    │   ├── actions.ts         #   原子动作空间（每格 6 方向 + 32 加点 + 全局切换）、合法掩码、动作↔意图互转
    │   ├── encode.ts          #   状态编码（变长全格 token 14 维 + CLS 14 维，当前行动方相对视角）
    │   ├── driver.ts          #   步级对局驱动 + 样本收集（判平上限、日志、拒绝诊断）
    │   ├── mcts.ts            #   原子 MCTS（PUCT c=1.0、根全展开、回合边界符号翻转、温度采样/argmax）
    │   ├── nn.ts              #   TS 推理封装（onnxruntime-node）
    │   ├── pool.ts            #   对手池（20 checkpoint、随机抽取、接受/裁剪）
    │   ├── sampler.ts         #   偏好题抽样器（局面题配对 / 走法题 MCTS 候选）
    │   ├── annotations.ts     #   标注转换（示范/纠错/偏好 → 训练样本）
    │   ├── annotation-types.ts #  标注/题目共享类型（浏览器安全）
    │   ├── logs.ts            #   日志索引/加载/重放/回合末采集（Node 侧）
    │   ├── logparse.ts        #   日志解析与重放（浏览器/Node 通用）
    │   ├── sampleio.ts        #   样本落盘（二进制 .bin 为主、JSONL 为辅）
    │   ├── workerpool.ts      #   worker 子进程批处理池（训练/验收共用）
    │   └── paths.ts           #   目录布局常量
    ├── python/                # Python 侧（训练/导出）
    │   ├── model.py           #   NumeralLordNet：全格 token Transformer（相对位置偏置）
    │   ├── data.py            #   样本加载（.bin/.jsonl 自动识别）+ 偏好对加载
    │   ├── train.py           #   拟合（策略 CE + 价值 MSE + λ_bc×示范 + λ_pref×偏好）
    │   ├── export.py          #   ONNX 导出 + PyTorch↔ONNX 自检
    │   ├── init_model.py      #   种子模型 v0（随机初始化 + 导出）
    │   ├── check_ts.py        #   TS↔Python 前向一致性检查
    │   ├── check_binary.py    #   二进制样本往返检查
    │   └── requirements.txt   #   torch/onnx/onnxruntime/onnxscript/numpy
    ├── scripts/               #  CLI 入口
    │   ├── train-v2.ts        #   ★ 训练主循环（启动训练用）
    │   ├── worker.ts          #   worker 子进程（selfplay/gate/accept 三类任务）
    │   ├── acceptance.ts      #   验收（v2 vs v45 基准，200 局，>65%）
    │   ├── sample-questions.ts#   偏好题抽样（每轮拟合前自动运行）
    │   ├── annotations-to-samples.ts  # 标注转换（每轮拟合前自动运行）
    │   ├── random-games.ts    #   随机策略冒烟（调试/生成测试日志）
    │   └── check-onnx.ts      #   TS 推理落盘（供 check_ts.py 对比）
    ├── replay-viewer/         #   人类指导网页（vite dev，npm run dev）
    │   └── src/
    │       ├── App.tsx        #   回放器 + 示范/纠错模式
    │       └── Workbench.tsx  #   判题工作台（双棋盘逐题判定）
    ├── tests/                 #   vitest 单测（43 个）
    ├── docs/                  #   阶段文档（见 §7）
    ├── demos/                 #   示范/纠错标注（人工产生）
    ├── prefs/                 #   偏好题队列 pairs-*.json + 已判定 pref-*.json
    └── runs/                  #   训练产物（gitignore）
        ├── logs/round-XXXXX/  #   对局日志（重放/人类工具数据源，不裁剪）
        ├── samples/round-XXXXX/ # 二进制自对弈样本（每轮一目录，保留 2 轮）
        ├── demo-samples/      #   示范样本（JSONL，每轮重新生成）
        ├── pref-samples/      #   偏好样本（JSONL，每轮重新生成）
        ├── weights/           #   checkpoint-vN.pt / model-vN.onnx(+.data) / pool.json
        ├── state.json         #   训练进度（round / gamesDone）
        ├── curve.csv          #   胜率曲线（每轮一行）
        └── acceptance*.csv    #   验收报告
```

## 3. 完整训练流程

### 3.1 数据流总览

```
TS 自对弈（worker 并行，双方从对手池抽模型）
  │ 每步：随机 5~200 模拟 + 温度采样 → 意图 + 动作先验 π
  ▼
二进制样本（每步一条：局面编码 + π + z 回填）→ runs/samples/round-XXXXX/
  │
Python 拟合（train.py）：
  loss = 自对弈(策略CE + 价值MSE)
       + λ_bc × 示范策略CE          ← 人类示范/纠错（runs/demo-samples/）
       + λ_pref × 偏好损失          ← 人类偏好判定（runs/pref-samples/）
  ▼
checkpoint-vN.pt → export.py → model-vN.onnx（自检通过才落盘）
  │
门限对局：vN vs 当前（验收图池，argmax，100 局）→ 胜率 ≥ 55% 接受进对手池 / 否则丢弃
  ▼
对手池（≤20 checkpoint）+ curve.csv + state.json → 下一轮
```

### 3.2 每轮循环（train-v2.ts）

| 步骤 | 内容 | 产物 |
|---|---|---|
| 1. 自对弈 | 1000 局（`--games-per-round`），worker 并行；地图轮转 100 张；双方独立从对手池抽模型；每步随机 5~200 模拟 + 温度 τ(gamesDone) 采样 | 二进制样本 + 对局日志 |
| 2. 人类指导数据 | 抽样偏好题（局面题配对 + 走法题 MCTS 候选，当前模型）；转换示范/纠错/已判定偏好 → 样本 | pairs-*.json / demo-samples / pref-samples |
| 3. 拟合 | train.py：子采样 `--max-samples`，`--epochs` 轮，λ_bc 按轮衰减传入 | checkpoint-vN.pt |
| 4. 导出 | export.py：ONNX + PyTorch↔ONNX 自检 | model-vN.onnx(+.data) |
| 5. 门限 | vN vs current 对弈 `--gate-games` 局（argmax `--gate-sims` 模拟，验收图池，先后手交替） | 胜率 |
| 6. 收尾 | ≥55% 接受（进池、成为 current）；曲线/状态落盘；旧轮样本裁剪（保留 2 轮） | curve.csv / pool.json / state.json |

### 3.3 温度与 λ_bc 调度

- τ：`--tau-start 10 → --tau-end 0.5` 线性退火 `--tau-games 10000` 局，之后恒 0.5；
- λ_bc：`--lambda-bc-init 1.0 × --lambda-bc-decay 0.9 ^ round`（示范随训练推进衰减，防止拉回人类水平）。

### 3.4 耗时基线（16 核 CPU，无 GPU，前向 ~8ms）

- 自对弈 1000 局 ≈ 12~16 h；门限 100 局 ≈ 1.5~2 h；拟合 ≈ 1~2 h；**一轮 ≈ 15~20 h**；
- 加速手段：`--workers` 上调、`--data-sims-max` 下调、缩小网络（model.py d_model/layers）。

## 4. 常用命令（均在 train/ 目录执行）

```bash
# 训练
npm run train:v2                                   # 正式启动（无限轮次）
npx tsx v2/scripts/train-v2.ts --max-rounds 2      # 调试：只跑 2 轮

# 冒烟/调试
npx tsx v2/scripts/random-games.ts 5               # 随机策略跑 5 局（生成调试日志）

# 测试与类型检查
npm run test:v2                                    # v2 单测（43 个）
npm run test                                       # v1 单测（96 个）
npm run typecheck:v2 && npm run typecheck          # v2 + v1
cd v2/replay-viewer && npm run build               # 回放器构建

# Python（训练/导出/检查）
npm run train-py -- --samples-dir v2/runs/samples/round-00000 --out v2/runs/weights/checkpoint-test.pt
npm run export-py -- --checkpoint v2/runs/weights/checkpoint-test.pt --out v2/runs/weights/model-test.onnx

# 验收
npx tsx v2/scripts/acceptance.ts                   # 默认：current 模型 vs v45，200 局，>65%

# 人类指导（vite dev，三端点：/api/demo /api/pref /api/log/:gameId）
cd v2/replay-viewer && npm run dev                 # 浏览器打开，端口 5180
```

## 5. 人类指导使用流程

1. **判题**：训练每轮自动生成 `v2/prefs/pairs-*.json` → 打开判题工作台 → 上传该文件 → 逐题判定（a 好 / b 好 / 都不好 / 不能判断 / 跳过）→ 落盘 `pref-*.json`；
2. **示范/纠错**：回放器上传 `v2/runs/logs/round-*/game-*.jsonl` → 停在行动/加点阶段 → "示范操作"或"纠错" → 演示操作序列 → 保存；
3. **纳入训练**：下一轮拟合自动转换并入损失（无需手动操作）；
4. 败因分析：`GameStats.rejectedIntents`（被拒意图明细）+ 回放器人工标注。

## 6. 产物与监控

| 文件 | 内容 | 关注点 |
|---|---|---|
| `runs/curve.csv` | 每轮：round/games_done/version/gate_wins/gate_winrate/accepted | 胜率是否上升、门限是否接受 |
| `runs/weights/pool.json` | 对手池 + current | 版本演进 |
| `runs/state.json` | round/gamesDone | 中断恢复点 |
| `runs/weights/model-vN.onnx` | 可部署模型（与 .onnx.data 成对） | 最终产物 |

- **中断/恢复**：Ctrl+C 随时停；重启即从 state.json 的 round 继续（当前轮自动清空重跑，不混半成品）。

## 7. 阶段文档索引

| 文档 | 内容 |
|---|---|
| 阶段0-环境接口规范.md | 状态编码 / 动作空间 / 样本格式的权威规范（Python 对接依据） |
| 阶段1-网络与推理.md | Transformer 结构 / 训练脚本 / ONNX 导出 / 前向一致性 |
| 阶段2-原子MCTS.md | 搜索语义（符号翻转 / PUCT / 根全展开 / 温度） |
| 阶段3-自对弈与训练循环.md | 主循环组件 / 参数表 / 二进制样本格式 |
| 阶段4-验收.md | v45 基准接入 / 验收脚本 / 达标线 |
| 阶段5-人类指导工具.md | 四类标注 / 抽样器 / 判题工作台 / 损失集成 |

## 8. 待办

- **阶段 6（部署）**：`planAiTurn` 挂训练 AI 到难度 3、200 模拟 + 5s 兜底、线上可对局（用户暂缓）；
- **阶段 7**：两队多人（训练范围阶段二，后续）。
