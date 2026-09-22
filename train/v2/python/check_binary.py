# check_binary.py — 二进制样本格式往返检查：TS 写入的 .bin 与 .jsonl 应解析出相同内容
import json
import sys

sys.path.insert(0, 'v2/python')
from data import load_binary, parse_sample

W = 'v2/runs/weights'

bin_samples = load_binary(f'{W}/game-check-binary.bin')
with open(f'{W}/samples-check-jsonl.jsonl', encoding='utf-8') as f:
    json_samples = [parse_sample(json.loads(line)) for line in f if line.strip()]

print(f'bin {len(bin_samples)} 条 / jsonl {len(json_samples)} 条')
assert len(bin_samples) == len(json_samples), '条数不一致'

for i, (b, j) in enumerate(zip(bin_samples, json_samples)):
    assert b.features.shape == j.features.shape, f'{i}: shape {b.features.shape} vs {j.features.shape}'
    assert (b.features == j.features).all(), f'{i}: features 不一致'
    assert (b.legal == j.legal).all(), f'{i}: legal 不一致'
    assert (b.target == j.target).all(), f'{i}: target 不一致'
    assert abs(b.z - j.z) < 1e-9, f'{i}: z 不一致'
    assert (b.rows == j.rows).all() and (b.cols == j.cols).all(), f'{i}: 位置不一致'

with open(f'{W}/check-expected.json', encoding='utf-8') as f:
    exp = json.load(f)
for i, e in enumerate(exp):
    b = bin_samples[i]
    assert b.features.shape[0] == e['nTiles'] + 1, f'{i}: nTiles 不一致'

print('OK: 二进制与 JSONL 解析结果完全一致')
