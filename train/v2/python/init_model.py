# init_model.py — 生成种子模型（随机初始化）并导出 v0 checkpoint + ONNX
# 训练循环首次启动时调用；已存在则跳过。
# 用法：python init_model.py --out-dir ../runs/weights
import argparse
import os

import torch

from model import NumeralLordNet


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--out-dir', required=True)
    ap.add_argument('--d-model', type=int, default=128)
    ap.add_argument('--layers', type=int, default=6)
    ap.add_argument('--heads', type=int, default=8)
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)
    ckpt_path = os.path.join(args.out_dir, 'checkpoint-v0.pt')
    onnx_path = os.path.join(args.out_dir, 'model-v0.onnx')
    if os.path.exists(ckpt_path) and os.path.exists(onnx_path):
        print('种子模型已存在，跳过:', ckpt_path)
        return

    torch.manual_seed(0)
    model = NumeralLordNet(d_model=args.d_model, layers=args.layers, heads=args.heads)
    torch.save(
        {
            'config': {'d_model': args.d_model, 'layers': args.layers, 'heads': args.heads},
            'state_dict': model.state_dict(),
            'epoch': 0,
            'val_loss': None,
            'samples': 0,
        },
        ckpt_path,
    )
    print('已保存 checkpoint:', ckpt_path)

    # 导出 ONNX（复用 export.py 的导出与自检逻辑）
    import onnxruntime as ort
    import numpy as np

    model.eval()
    B, S = 1, 145
    features = torch.randn(B, S, 14)
    rows = torch.zeros(B, S)
    cols = torch.zeros(B, S)
    mask = torch.ones(B, S)
    torch.onnx.export(
        model,
        (features, rows, cols, mask),
        onnx_path,
        input_names=['features', 'rows', 'cols', 'mask'],
        output_names=['policy', 'value'],
        dynamic_axes={
            'features': {0: 'batch', 1: 'seq'},
            'rows': {0: 'batch', 1: 'seq'},
            'cols': {0: 'batch', 1: 'seq'},
            'mask': {0: 'batch', 1: 'seq'},
            'policy': {0: 'batch', 1: 'actions'},
            'value': {0: 'batch'},
        },
        opset_version=17,
    )
    sess = ort.InferenceSession(onnx_path, providers=['CPUExecutionProvider'])
    ort_out = sess.run(
        ['policy', 'value'],
        {
            'features': features.numpy().astype(np.float32),
            'rows': rows.numpy().astype(np.float32),
            'cols': cols.numpy().astype(np.float32),
            'mask': mask.numpy().astype(np.float32),
        },
    )
    with torch.no_grad():
        p, v = model(features, rows, cols, mask)
    p_err = float((p.numpy() - ort_out[0]).__abs__().max())
    v_err = float((v.numpy() - ort_out[1]).__abs__().max())
    assert p_err < 1e-4 and v_err < 1e-4, f'自检失败 p={p_err} v={v_err}'
    print('已导出 ONNX 且自检通过:', onnx_path)


if __name__ == '__main__':
    main()
