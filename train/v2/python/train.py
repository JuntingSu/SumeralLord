# train.py — 训练脚本（自对弈样本 → 策略 CE + 价值 MSE + 人类指导损失）
#
# 用法：
#   python train.py --samples-dir ../runs/samples --epochs 20 --out ../runs/weights/checkpoint.pt
#
# 损失（决策定稿 §7，修订版 §五）：
#   loss = 自对弈(策略CE + 价值MSE)
#        + λ_bc  × 示范策略CE        （--demo-dir；只算策略项，不计价值）
#        + λ_pref × 偏好损失          （--pref-dir；价值排序，按视角座次换算）
# 示范/偏好只在训练 batch 生效；验证损失只含自对弈项。
import argparse
import json
import os
import random
import time

import torch
from torch import nn

from data import collate, load_pref_samples, load_samples, split_train_val
from model import NumeralLordNet


def policy_ce(policy: torch.Tensor, legal: torch.Tensor, target: torch.Tensor) -> torch.Tensor:
    """合法动作子集上的策略交叉熵（每个样本独立 gather + softmax）"""
    logits = policy[legal]  # (L,)
    return nn.functional.cross_entropy(logits.unsqueeze(0), target.unsqueeze(0))


def value_persp(model: nn.Module, features: torch.Tensor, rows: torch.Tensor, cols: torch.Tensor, seat: int) -> torch.Tensor:
    """价值换算到视角座次（1v1 零和：行动方 == 视角 ? v : -v；行动方 = CLS[5]）"""
    _, v = model(
        features.unsqueeze(0),
        rows.unsqueeze(0),
        cols.unsqueeze(0),
        torch.ones(1, features.shape[0]),
    )
    actor = int(features[0][5].item())
    return v[0] if actor == seat else -v[0]


def pref_loss_for_pair(
    model: nn.Module,
    pair,
    margin: float,
    bad_target: float,
) -> torch.Tensor:
    """单条偏好损失：a好 → hinge(v_a - v_b - margin)；b好 反向；都不好 → 双双压向 bad_target"""
    va = value_persp(model, pair.features_a, pair.rows_a, pair.cols_a, pair.seat_a)
    vb = value_persp(model, pair.features_b, pair.rows_b, pair.cols_b, pair.seat_b)
    if pair.label == 'a':
        return nn.functional.relu(margin - (va - vb))
    if pair.label == 'b':
        return nn.functional.relu(margin - (vb - va))
    return (va - bad_target) ** 2 + (vb - bad_target) ** 2


def run_epoch(
    model: nn.Module,
    samples: list,
    batch_size: int,
    lr: float,
    train: bool,
    device: torch.device,
    demos: list | None = None,
    prefs: list | None = None,
    lambda_bc: float = 1.0,
    pref_weight: float = 1.0,
    pref_margin: float = 0.3,
    pref_bad_target: float = -0.5,
) -> tuple[float, int]:
    """跑一个 epoch；train=True 时更新权重（含人类指导损失项），返回（平均主损失, 样本数）"""
    if train:
        model.train()
        opt = torch.optim.Adam(model.parameters(), lr=lr)
    else:
        model.eval()
        opt = None
    total_loss = 0.0
    n = 0
    with torch.set_grad_enabled(train):
        for start in range(0, len(samples), batch_size):
            batch = collate(samples[start : start + batch_size])
            policy, value = model(batch.features, batch.rows, batch.cols, batch.mask)
            v_loss = nn.functional.mse_loss(value, batch.z)
            p_loss = torch.stack(
                [policy_ce(policy[b], batch.legal[b], batch.target[b]) for b in range(len(samples[start : start + batch_size]))]
            ).mean()
            loss = p_loss + v_loss
            if train:
                # 示范损失：每批抽一批示范样本，只算策略 CE
                if demos:
                    db = collate(random.sample(demos, min(batch_size, len(demos))))
                    dp, _ = model(db.features, db.rows, db.cols, db.mask)
                    dce = torch.stack(
                        [policy_ce(dp[b], db.legal[b], db.target[b]) for b in range(len(db.legal))]
                    ).mean()
                    loss = loss + lambda_bc * dce
                # 偏好损失：每批抽一批偏好对，价值排序
                if prefs:
                    pb = random.sample(prefs, min(batch_size, len(prefs)))
                    pl = torch.stack(
                        [pref_loss_for_pair(model, pr, pref_margin, pref_bad_target) for pr in pb]
                    ).mean()
                    loss = loss + pref_weight * pl
                opt.zero_grad()
                loss.backward()
                opt.step()
            total_loss += loss.item() * (len(samples[start : start + batch_size]))
            n += len(samples[start : start + batch_size])
    return total_loss / max(1, n), n


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--samples-dir', required=True, help='自对弈样本目录（runs/samples/round-XXXXX）')
    ap.add_argument('--extra-samples-dir', default=None, help='额外样本目录（如 v1 示范对局 runs/v1-samples；与主样本合并训练）')
    ap.add_argument('--demo-dir', default=None, help='示范样本目录（runs/demo-samples；λ_bc × 策略 CE）')
    ap.add_argument('--pref-dir', default=None, help='偏好样本目录（runs/pref-samples；λ_pref × 价值排序）')
    ap.add_argument('--lambda-bc', type=float, default=1.0, help='示范损失权重（主循环按轮衰减传入）')
    ap.add_argument('--pref-weight', type=float, default=1.0, help='偏好损失权重')
    ap.add_argument('--pref-margin', type=float, default=0.3, help='偏好 hinge 间隔')
    ap.add_argument('--pref-bad-target', type=float, default=-0.5, help='"都不好"的价值压低目标')
    ap.add_argument('--epochs', type=int, default=20)
    ap.add_argument('--batch-size', type=int, default=64)
    ap.add_argument('--lr', type=float, default=1e-3)
    ap.add_argument('--val-fraction', type=float, default=0.1)
    ap.add_argument('--max-samples', type=int, default=0, help='训练样本上限（0 = 全部；随机子采样控制 CPU 拟合成本）')
    ap.add_argument('--d-model', type=int, default=128)
    ap.add_argument('--layers', type=int, default=6)
    ap.add_argument('--heads', type=int, default=8)
    ap.add_argument('--out', required=True, help='checkpoint 输出路径（.pt）')
    ap.add_argument('--seed', type=int, default=0)
    args = ap.parse_args()

    torch.manual_seed(args.seed)
    random.seed(args.seed)
    device = torch.device('cpu')

    print(f'加载样本：{args.samples_dir}')
    t0 = time.time()
    samples = load_samples(args.samples_dir, max_samples=args.max_samples)
    print(f'样本数 {len(samples)}，耗时 {time.time() - t0:.1f}s')
    if args.extra_samples_dir:
        extra = load_samples(args.extra_samples_dir, max_samples=args.max_samples)
        print(f'额外样本（--extra-samples-dir）{len(extra)} 条，合并后 {len(samples) + len(extra)} 条')
        samples = samples + extra
    if len(samples) == 0:
        raise SystemExit('样本为空（先运行 random-games.ts 生成）')
    if args.max_samples > 0 and len(samples) >= args.max_samples:
        print(f'已按 --max-samples 上限加载（加载阶段子采样，避免大轮次全量加载 OOM）')

    demos = load_samples(args.demo_dir) if args.demo_dir else []
    prefs = load_pref_samples(args.pref_dir) if args.pref_dir else []
    if demos:
        print(f'示范样本 {len(demos)} 条（λ_bc = {args.lambda_bc}）')
    if prefs:
        print(f'偏好样本 {len(prefs)} 条（λ_pref = {args.pref_weight}, margin = {args.pref_margin}）')

    train_set, val_set = split_train_val(samples, args.val_fraction, seed=args.seed)
    print(f'train {len(train_set)} / val {len(val_set)}')

    model = NumeralLordNet(d_model=args.d_model, layers=args.layers, heads=args.heads)
    print(f'参数量 {sum(p.numel() for p in model.parameters()) / 1e6:.2f}M')

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    best_val = float('inf')
    for epoch in range(1, args.epochs + 1):
        tr_loss, tr_n = run_epoch(
            model, train_set, args.batch_size, args.lr, True, device,
            demos=demos, prefs=prefs,
            lambda_bc=args.lambda_bc, pref_weight=args.pref_weight,
            pref_margin=args.pref_margin, pref_bad_target=args.pref_bad_target,
        )
        va_loss, _ = run_epoch(model, val_set, args.batch_size, args.lr, False, device)
        print(f'epoch {epoch:3d}  train_loss {tr_loss:.4f}  val_loss {va_loss:.4f}')
        if va_loss < best_val:
            best_val = va_loss
            torch.save(
                {
                    'config': {
                        'd_model': args.d_model,
                        'layers': args.layers,
                        'heads': args.heads,
                    },
                    'state_dict': model.state_dict(),
                    'epoch': epoch,
                    'val_loss': va_loss,
                    'samples': len(samples),
                },
                args.out,
            )
            print(f'  → 已保存最佳 checkpoint：{args.out} (val {va_loss:.4f})')

    print('完成。checkpoint:', args.out)


if __name__ == '__main__':
    main()
