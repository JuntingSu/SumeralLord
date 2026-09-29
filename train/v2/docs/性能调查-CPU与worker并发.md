# 性能调查：CPU 与 worker 并发（onnxruntime 线程池空转）

> **日期**：2026-09-22
> **触发**：训练自对弈开 2 个 worker，任务管理器 CPU 即达 100%，怀疑加 worker 无法再提升训练速度
> **结论**：当前 100% 是 **onnxruntime 线程池空转造成的假饱和**；钉住推理线程数后，worker 可开至物理核数规模，自对弈吞吐约提升 3 倍

---

## 1. 现象与问题

- 命令：`npx tsx v2/scripts/train-v2.ts --workers 2 --tau-start 10 ...`
- 现象：仅 2 个 worker，整机 CPU 占用即到 100%（任务管理器）。
- 疑问：机器是 AMD Ryzen 7 5800U（**8 物理核 / 16 逻辑核**），2 个 worker 不可能用满 16 逻辑核——除非每个 worker 实际占用了远超 1 核的算力。加 worker 是否真的无法提速？

## 2. 测量方法

为还原真实 worker 的内存/CPU 画像，编写临时探针脚本：加载 ONNX 模型（CPU EP），循环执行 `mctsDecide(sims=50, τ=10)` + `playGame(maxSteps=200)`（地图 map-001，130 格），复刻 `worker.ts` 的自对弈循环。

CPU 占用采样：PowerShell `Get-Process` 累计 CPU 秒差分（间隔 12~15s），换算核数：

```
占用核数 ≈ (CPU_秒_end - CPU_秒_start) / 墙钟秒
```

推理耗时基准：固定 session 反复前向 50 次取平均（输入长度 130~230 变化，模拟不同地图）。

## 3. 实测数据

### 3.1 单 worker CPU 占用（核心结论）

| 配置 | 单 worker 占用 | 线程数 | 说明 |
|---|---|---|---|
| onnxruntime 默认（不指定线程数） | **~4.8 核**（单 session 探针） | 22 | 真实 worker 每局加载 **2 个** session（双方模型），估算 **~9 核/worker** |
| `intraOpNumThreads=1, interOpNumThreads=1` | **~0.67 核** | 17 | 这才是 MCTS + 推理的真实算力 |

> 2 个 worker × ~9 核 ≈ 18 核 ≈ 16 逻辑核吃满 → 任务管理器显示 100%。

### 3.2 单次前向耗时（线程数几乎无影响）

| 配置 | 平均前向耗时 |
|---|---|
| 默认 | 20.4 ms |
| `intraOpNumThreads=1` | 23.9 ms（慢 ~17%） |
| `intraOpNumThreads=2` | 19.9 ms |

模型（变长全格 token 小 Transformer，S≤256）规模太小，多线程推理**无并行收益**；线程池的存在反而以空转形式持续烧 CPU。

## 4. 根因

- onnxruntime CPU 执行器默认 **intra-op 线程池线程数 = 物理核数（本机 8）**。
- 每次推理仅 ~20ms 且串行依赖，线程池中的线程大部分时间在 **spin-wait 空转**，白烧 CPU。
- 真实 worker 同时持有 2 个 session（`runSelfplay` 为双方各 load 一个），线程池翻倍 → 空转核数翻倍。
- 该 CPU 浪费是**原生线程**行为，不受 `--max-old-space-size` 约束，也不会出现在 V8 堆日志里（与之前的 OOM 问题相互独立，见 §6）。

## 5. 修复与调参建议

### 5.1 钉住推理线程数（治本）

在 `lib/nn.ts` 的 session 创建处加：

```ts
await ort.InferenceSession.create(onnxPath, {
  executionProviders: ['cpu'],
  intraOpNumThreads: 1,   // 模型太小，并行无收益，线程池只会空转
  interOpNumThreads: 1,
});
```

代价：单次前向慢 ~17%（20.4 → 23.9ms）；收益：每个 worker 释放 ~8 核空转。

### 5.2 worker 数

- 修复后每 worker ≈ 0.7~0.8 核，**worker 数上限 = 物理核数**（8），并留 1~2 核给主进程与 Python 拟合阶段 → 本机建议 `--workers 5~6`。
- 自对弈吞吐 ≈ 当前 2 worker 的 **3 倍**（从 ~2 核真算力 → ~5~6 核真算力），机器不再 100%。
- 超过物理核数后继续加 worker **无收益**（CPU 饱和 + 上下文切换开销）——"100% 后加 worker 不提速"的直觉成立，但前提是 100% 是真饱和。

### 5.3 流水线注意

训练主循环是串行的：**自对弈（worker）→ Python 拟合（torch）→ 门限对局（worker）**。拟合阶段 torch 同样吃满 CPU，因此 worker 数要留余量，避免与拟合阶段互相挤压。

## 6. 相关背景（独立问题）

本报告仅覆盖 CPU/并发。另有一个独立的内存问题（已另行调查）：worker 以 `--max-old-space-size=1024`（1GB JS 堆）运行，大图后期 ADD_POINT 局面下单次 MCTS 决策的瞬时树内存（每节点全量克隆局面 × L≈2000 合法动作 × 模拟数）会打爆堆上限导致 `FATAL ERROR: Reached heap limit`（exit 134）。两者互不影响，但叠加会加剧整机内存/CPU 压力。

## 7. 复测方法

需要复测时，按 §2 起一个循环探针（单 session 或双 session 均可），用 PowerShell 差分采样即可复现本报告数据；验证修复效果时对比「默认配置」与「intraOpNumThreads=1」两列的核数与前向耗时。
