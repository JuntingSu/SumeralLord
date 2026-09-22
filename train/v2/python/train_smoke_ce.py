# 阶段 1 验收：集中式 π 合成样本——验证策略 CE 梯度路径（可学目标，CE 应显著低于均匀基线 log L ≈ 3.2）
import sys
from dataclasses import replace

sys.path.insert(0, 'v2/python')
from data import load_samples
from model import NumeralLordNet
from train import run_epoch

samples = load_samples('v2/runs/samples')
concentrated = []
for s in samples:
    t2 = s.target.clone().zero_()
    t2[0] = 1.0  # 集中于第一个合法动作
    concentrated.append(replace(s, target=t2))
print(f'合成样本 {len(concentrated)} 条（π 集中于每个样本的第一个合法动作），均匀基线 ≈ 3.22')

model = NumeralLordNet()
tr, _ = run_epoch(model, concentrated, 32, 3e-3, True, 'cpu')
print(f'初始 train_loss = {tr:.4f}')
best = tr
for i in range(8):
    tr, _ = run_epoch(model, concentrated, 32, 3e-3, True, 'cpu')
    best = min(best, tr)
    print(f'epoch {i+1}: train_loss = {tr:.4f}')
print(f'最优 {best:.4f}')
assert best < 2.8, 'CE 未显著低于均匀基线：梯度路径有问题'
print('OK：策略 CE 显著收敛，梯度路径正确')
