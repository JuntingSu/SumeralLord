# data.py — 训练样本加载与批处理（JSONL / 二进制，格式见 docs/阶段0-环境接口规范.md §4）
import json
import os
import random
import struct
from dataclasses import dataclass

import numpy as np
import torch

TILE_FEATURES = 14


@dataclass
class Sample:
    """单条样本（张量化）"""
    features: torch.Tensor  # (S, 14)：CLS + nTiles 个格子
    rows: torch.Tensor      # (S,) float32：行（CLS = 0）
    cols: torch.Tensor      # (S,) float32：列（CLS = 0）
    legal: torch.Tensor     # (L,) int64：合法动作索引（按 §3 动作空间布局）
    target: torch.Tensor    # (L,) float32：合法动作上的先验 π（合计 1）
    z: float                # 行动方视角终局标签


@dataclass
class PrefPair:
    """偏好对（局面题或走法题的后继局面统一表示）"""
    id: str
    label: str  # 'a' | 'b' | 'both_bad'
    features_a: torch.Tensor  # (S,14)
    rows_a: torch.Tensor
    cols_a: torch.Tensor
    seat_a: int
    features_b: torch.Tensor
    rows_b: torch.Tensor
    cols_b: torch.Tensor
    seat_b: int


def load_pref_samples(pref_dir: str) -> list[PrefPair]:
    """读入偏好样本（JSONL：{id,label,a:{cls,tiles,rows,columns,seat},b:{...}}）"""
    out: list[PrefPair] = []
    if not os.path.isdir(pref_dir):
        return out
    for fname in sorted(os.listdir(pref_dir)):
        if not fname.endswith('.jsonl'):
            continue
        with open(os.path.join(pref_dir, fname), encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                a = _side_from_rec(rec['a'])
                b = _side_from_rec(rec['b'])
                out.append(
                    PrefPair(
                        id=rec.get('id', fname),
                        label=rec['label'],
                        features_a=a[0], rows_a=a[1], cols_a=a[2], seat_a=a[3],
                        features_b=b[0], rows_b=b[1], cols_b=b[2], seat_b=b[3],
                    )
                )
    return out


def _side_from_rec(side: dict) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, int]:
    features = [side['cls']] + side['tiles']
    S = len(features)
    rows, cols = _derive_positions(S, side['columns'])
    return (
        torch.tensor(features, dtype=torch.float32),
        torch.tensor(rows, dtype=torch.float32),
        torch.tensor(cols, dtype=torch.float32),
        int(side['seat']),
    )


def _derive_positions(s: int, columns: int) -> tuple[list[float], list[float]]:
    """从 columns 推导每 token 行列（token 0 = CLS 位置 0；token i>0 = tile i-1）"""
    rows = [0.0] * s
    cols = [0.0] * s
    for i in range(1, s):
        tile = i - 1
        rows[i] = float(tile // columns)
        cols[i] = float(tile % columns)
    return rows, cols


def load_samples(samples_dir: str, max_samples: int = 0) -> list[Sample]:
    """读入 samples 目录下全部样本（优先二进制：.bin，训练循环用），否则 JSONL（.jsonl，调试/示范用）。
    max_samples > 0 时按固定种子随机打乱文件序、加载到上限即止（训练循环用：大轮次样本可达 10GB 级，
    先全量加载再子采样会 OOM；上限在加载阶段生效）。"""
    files = sorted(os.listdir(samples_dir))
    bin_files = [f for f in files if f.endswith('.bin')]
    if bin_files:
        if max_samples > 0 and len(bin_files) > 1:
            random.Random(0).shuffle(bin_files)  # 固定种子：文件序打乱可复现，避免只取到早期高 τ 对局
        out: list[Sample] = []
        for fname in bin_files:
            out.extend(load_binary(os.path.join(samples_dir, fname)))
            if max_samples > 0 and len(out) >= max_samples:
                del out[max_samples:]
                break
        return out
    out = []
    bad = 0
    for fname in files:
        if not fname.endswith('.jsonl'):
            continue
        path = os.path.join(samples_dir, fname)
        with open(path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(parse_sample(json.loads(line)))
                except (KeyError, TypeError, ValueError):
                    bad += 1  # 杂散文件（如对局日志误入样本目录）：跳过不中断
                    continue
                if max_samples > 0 and len(out) >= max_samples:
                    return out
    if bad:
        print(f'[data] 警告：{samples_dir} 跳过 {bad} 条无法解析的样本行（格式不匹配，请检查目录内容）')
    return out


def load_binary(path: str) -> list[Sample]:
    """解析二进制样本文件（记录布局见 TS sampleio.writeSamplesBinary）"""
    with open(path, 'rb') as f:
        data = f.read()
    out: list[Sample] = []
    off = 0
    n = len(data)
    while off < n:
        s, rows_m, cols_m, l, z = struct.unpack_from('<IIIIf', data, off)
        off += 20
        nf = s * TILE_FEATURES
        feats = np.frombuffer(data, dtype='<f4', count=nf, offset=off).reshape(s, TILE_FEATURES).copy()
        off += nf * 4
        legal = np.frombuffer(data, dtype='<u4', count=l, offset=off).astype(np.int64)
        off += l * 4
        target = np.frombuffer(data, dtype='<f4', count=l, offset=off).copy()
        off += l * 4
        r, c = _derive_positions(s, cols_m)
        out.append(
            Sample(
                features=torch.from_numpy(feats.astype(np.float32)),
                rows=torch.tensor(r, dtype=torch.float32),
                cols=torch.tensor(c, dtype=torch.float32),
                legal=torch.from_numpy(legal),
                target=torch.from_numpy(target.astype(np.float32)),
                z=float(z),
            )
        )
    return out


def parse_sample(rec: dict) -> Sample:
    n = rec['nTiles']
    cols = rec['columns']
    features = [rec['cls']] + rec['tiles']  # (S, 14)
    S = len(features)
    rows, col_pos = _derive_positions(S, cols)
    legal = torch.tensor([p[0] for p in rec['pi']], dtype=torch.long)
    target = torch.tensor([p[1] for p in rec['pi']], dtype=torch.float32)
    return Sample(
        features=torch.tensor(features, dtype=torch.float32),
        rows=torch.tensor(rows, dtype=torch.float32),
        cols=torch.tensor(col_pos, dtype=torch.float32),
        legal=legal,
        target=target,
        z=float(rec['z']),
    )


@dataclass
class Batch:
    features: torch.Tensor  # (B, Smax, 14)
    rows: torch.Tensor      # (B, Smax)
    cols: torch.Tensor      # (B, Smax)
    mask: torch.Tensor      # (B, Smax) 1=真实
    # 每样本的合法动作与目标（长度不一，按样本处理）
    legal: list[torch.Tensor]
    target: list[torch.Tensor]
    z: torch.Tensor         # (B,)


def collate(samples: list[Sample]) -> Batch:
    B = len(samples)
    Smax = max(s.features.shape[0] for s in samples)
    features = torch.zeros(B, Smax, TILE_FEATURES)
    rows = torch.zeros(B, Smax)
    cols = torch.zeros(B, Smax)
    mask = torch.zeros(B, Smax)
    z = torch.zeros(B)
    for b, s in enumerate(samples):
        S = s.features.shape[0]
        features[b, :S] = s.features
        rows[b, :S] = s.rows
        cols[b, :S] = s.cols
        mask[b, :S] = 1.0
        z[b] = s.z
    return Batch(
        features=features,
        rows=rows,
        cols=cols,
        mask=mask,
        legal=[s.legal for s in samples],
        target=[s.target for s in samples],
        z=z,
    )


def split_train_val(samples: list[Sample], val_fraction: float, seed: int = 0) -> tuple[list[Sample], list[Sample]]:
    """按文件/样本洗牌切分（seed 固定保证可复现）"""
    rng = random.Random(seed)
    idx = list(range(len(samples)))
    rng.shuffle(idx)
    n_val = max(1, int(len(samples) * val_fraction))
    val_idx = set(idx[:n_val])
    train = [s for i, s in enumerate(samples) if i not in val_idx]
    val = [s for i, s in enumerate(samples) if i in val_idx]
    return train, val
