# export.py — 导出 ONNX 并做前向一致性自检（PyTorch vs ONNX Runtime）
#
# 用法：python export.py --checkpoint ../runs/weights/checkpoint.pt --out ../runs/weights/model.onnx
# 自检通过才写回文件；输出模型供 TS 侧 onnxruntime-node 加载（自对弈/部署共用）。
import argparse

import numpy as np
import onnxruntime as ort
import torch

from model import NumeralLordNet


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--checkpoint', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--check-seq', type=int, default=145, help='自检序列长（含 CLS）')
    args = ap.parse_args()

    ckpt = torch.load(args.checkpoint, map_location='cpu')
    cfg = ckpt['config']
    model = NumeralLordNet(d_model=cfg['d_model'], layers=cfg['layers'], heads=cfg['heads'])
    model.load_state_dict(ckpt['state_dict'])
    model.eval()

    B, S = 2, args.check_seq
    features = torch.randn(B, S, 14)
    rows = torch.zeros(B, S)
    cols = torch.zeros(B, S)
    mask = torch.ones(B, S)
    mask[:, S // 2 :] = 0.0  # 后半 padding，验证 mask 生效

    torch.onnx.export(
        model,
        (features, rows, cols, mask),
        args.out,
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

    # 前向一致性自检：PyTorch vs ONNX Runtime
    sess = ort.InferenceSession(args.out, providers=['CPUExecutionProvider'])
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
    print(f'policy max err = {p_err:.2e}, value max err = {v_err:.2e}')
    if p_err > 1e-4 or v_err > 1e-4:
        raise SystemExit('前向一致性自检失败（PyTorch 与 ONNX 输出不一致）')
    print('导出成功且自检通过:', args.out)


if __name__ == '__main__':
    main()
