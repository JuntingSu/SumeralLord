# train/eval-maps/ — 验收图池

此目录用于放置**单独设计的验收地图**（与 `train/maps/` 训练图池无交集，用于泛化检验）。

- 每 500 局训练会抽检 100 局：训练权重 argmax vs 基准（种子权重 argmax），胜率 ≥ 60% 达标。
- 抽检时若此目录为空，将跳过本次抽检并提示（训练不中断）；放入地图后下一次抽检自动启用。
- 地图格式为项目标准 MapFullData JSON（与 mapeditor 导出一致），1v1（player_num=2）。
