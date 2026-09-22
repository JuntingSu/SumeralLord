# check_ts.py — TS↔Python 前向一致性：读 TS 落盘的真实局面与输出，跑 torch 模型对比
# 用法：先跑 npx tsx v2/scripts/check-onnx.ts，再 python v2/python/check_ts.py
import json
import sys

import torch

sys.path.insert(0, 'v2/python')
from model import NumeralLordNet

DUMP = 'v2/runs/weights/check-ts-dump.json'
CKPT = 'v2/runs/weights/checkpoint.pt'

with open(DUMP, 'r', encoding='utf-8') as f:
    d = json.load(f)

features = [d['cls']] + d['tiles']
S = len(features)
rows = [0.0] * S
cols = [0.0] * S
for i in range(1, S):
    tile = i - 1
    rows[i] = float(tile // d['columns'])
    cols[i] = float(tile % d['columns'])

ckpt = torch.load(CKPT, map_location='cpu')
model = NumeralLordNet(**ckpt['config'])
model.load_state_dict(ckpt['state_dict'])
model.eval()

with torch.no_grad():
    p, v = model(
        torch.tensor([features], dtype=torch.float32),
        torch.tensor([rows], dtype=torch.float32),
        torch.tensor([cols], dtype=torch.float32),
        torch.ones(1, S),
    )

p_err = float((p[0].numpy() - torch.tensor(d['tsPolicy']).numpy()).__abs__().max())
v_err = abs(float(v[0]) - d['tsValue'])
print(f'policy max err = {p_err:.2e}, value err = {v_err:.2e}')
assert p_err < 1e-4 and v_err < 1e-4, 'TS 与 Python 前向不一致'
print('OK: TS 推理（ONNX Runtime）与 Python（torch）前向一致')
